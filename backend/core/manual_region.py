"""Manual region tools: the user boxes one spot on a page and we (1) read the
text in it, (2) optionally translate that text, (3) clean the spot and draw
the chosen translation into it.

Deliberately independent of the whole-page pipeline (core/pipeline.py): it
works on one rectangle, so it can run on a page that was never auto-translated
or on top of one that was. Boxes are normalised (0..1) so they stay valid even
when the image being edited is a different size than the source (upscaled
output, thumbnail, ...).
"""
from __future__ import annotations

import base64
import io
from typing import List, Optional, Tuple

import cv2
import numpy as np
from PIL import Image

from core.config import RenderingConfig
from core.text.text_renderer import render_text_skia
from utils.logging import log_message

MIN_REGION_PIXELS = 8
OCR_PADDING_PIXELS = 4
FLAT_BACKGROUND_MAX_STD = 18.0  # border colour spread below this = a flat (bubble-like) background
TEXT_DIFF_THRESHOLD = 40  # per-channel difference from the background that counts as text/ink


def decode_image(b64: str) -> Image.Image:
    if b64.startswith("data:"):
        b64 = b64.split(",", 1)[1]
    return Image.open(io.BytesIO(base64.b64decode(b64))).convert("RGB")


def encode_png(image: Image.Image) -> str:
    buf = io.BytesIO()
    image.save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def box_to_pixels(size: Tuple[int, int], box: Tuple[float, float, float, float]) -> Tuple[int, int, int, int]:
    """Normalised (x1, y1, x2, y2) -> clamped pixel box. Raises ValueError for
    a box that is empty or collapses to almost nothing."""
    width, height = size
    x1, y1, x2, y2 = box
    left, right = sorted((x1, x2))
    top, bottom = sorted((y1, y2))
    px = (
        max(0, int(round(left * width))),
        max(0, int(round(top * height))),
        min(width, int(round(right * width))),
        min(height, int(round(bottom * height))),
    )
    if px[2] - px[0] < MIN_REGION_PIXELS or px[3] - px[1] < MIN_REGION_PIXELS:
        raise ValueError("Selected region is too small")
    return px


def crop_for_ocr(image: Image.Image, px_box: Tuple[int, int, int, int]) -> Image.Image:
    x1, y1, x2, y2 = px_box
    pad = OCR_PADDING_PIXELS
    return image.crop((max(0, x1 - pad), max(0, y1 - pad), min(image.width, x2 + pad), min(image.height, y2 + pad)))


def _border_pixels(crop: np.ndarray) -> np.ndarray:
    ring = max(1, min(3, min(crop.shape[:2]) // 6))
    return np.concatenate([
        crop[:ring].reshape(-1, 3), crop[-ring:].reshape(-1, 3),
        crop[:, :ring].reshape(-1, 3), crop[:, -ring:].reshape(-1, 3),
    ])


def clean_region(image_bgr: np.ndarray, px_box: Tuple[int, int, int, int], use_lama: bool = False) -> Tuple[int, int, int]:
    """Erases the text inside px_box, in place, and returns the resulting
    background colour (BGR) so the caller can pick a readable text colour.

    A flat border (speech bubble, caption box) is simply filled with its own
    colour. A busy one (text over artwork) is inpainted from the surroundings
    around a mask of everything that differs from the local background — with
    LaMa when use_lama is set (reconstructs screentone/lines; falls back to
    OpenCV on any error), otherwise OpenCV."""
    x1, y1, x2, y2 = px_box
    crop = image_bgr[y1:y2, x1:x2]
    border = _border_pixels(crop)
    background = np.median(border, axis=0)
    flat = float(border.std(axis=0).max()) < FLAT_BACKGROUND_MAX_STD

    if flat:
        crop[:] = background.astype(np.uint8)
        return tuple(int(c) for c in background)

    diff = np.abs(crop.astype(np.int16) - background.astype(np.int16)).max(axis=2)
    mask = (diff > TEXT_DIFF_THRESHOLD).astype(np.uint8) * 255
    mask = cv2.dilate(mask, np.ones((3, 3), np.uint8), iterations=2)
    if use_lama:
        try:
            full_mask = np.zeros(image_bgr.shape[:2], dtype=bool)
            full_mask[y1:y2, x1:x2] = mask > 0
            # Whole image in, so LaMa sees context beyond the box; only
            # masked pixels come back changed.
            healed_rgb = _lama_inpaint(cv2.cvtColor(image_bgr, cv2.COLOR_BGR2RGB), full_mask)
            image_bgr[:] = cv2.cvtColor(healed_rgb, cv2.COLOR_RGB2BGR)
            return tuple(int(c) for c in np.median(image_bgr[y1:y2, x1:x2].reshape(-1, 3), axis=0))
        except Exception as e:  # noqa: BLE001 — never fail the render over the nicer inpainter
            log_message(f"LaMa cleanup failed ({e}); using OpenCV", always_print=True)
    healed = cv2.inpaint(crop, mask, 3, cv2.INPAINT_TELEA)
    crop[:] = healed
    return tuple(int(c) for c in np.median(healed.reshape(-1, 3), axis=0))


def _lama_inpaint(rgb: np.ndarray, mask: np.ndarray) -> np.ndarray:
    # Imported lazily: loading torch/the model manager is only worth it when
    # LaMa was actually asked for.
    from core.image.lama_inpainter import lama_inpaint_rgb
    return lama_inpaint_rgb(rgb, mask)


def erase_mask(image: Image.Image, mask: Image.Image, dilate_px: int = 2, use_lama: bool = False) -> Image.Image:
    """The "eraser" tool: removes whatever is under an arbitrary hand-drawn
    mask instead of a rectangle — for raw text/SFX baked into complex art
    that a box can't isolate cleanly without also grabbing nearby artwork
    (curved/diagonal SFX, text hugging a character's outline, ...).

    `mask` is a same-resolution-or-scaled image where any non-black pixel
    marks "erase here" (what a freehand brush stroke on a transparent canvas,
    composited to black, naturally produces). Inpainted with LaMa when
    use_lama is set (falls back to OpenCV on any error), otherwise cv2.inpaint
    (OpenCV's TELEA); both handle arbitrary mask shapes natively — unlike
    clean_region()'s box-shaped flat-fill/inpaint heuristic used elsewhere in
    this module, which assumes a rectangular region with a clean border to
    sample a background color/texture from."""
    if mask.size != image.size:
        mask = mask.resize(image.size, Image.NEAREST)
    mask_arr = np.array(mask.convert("L"))
    binary_mask = (mask_arr > 32).astype(np.uint8) * 255
    if not binary_mask.any():
        return image.convert("RGB")
    if dilate_px > 0:
        binary_mask = cv2.dilate(binary_mask, np.ones((3, 3), np.uint8), iterations=dilate_px)
    rgb = np.array(image.convert("RGB"))
    if use_lama:
        try:
            return Image.fromarray(_lama_inpaint(rgb, binary_mask > 0))
        except Exception as e:  # noqa: BLE001
            log_message(f"LaMa erase failed ({e}); using OpenCV", always_print=True)
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    healed = cv2.inpaint(bgr, binary_mask, 3, cv2.INPAINT_TELEA)
    return Image.fromarray(cv2.cvtColor(healed, cv2.COLOR_BGR2RGB))


def restore_regions(
    target: Image.Image,
    source: Image.Image,
    boxes: List[Tuple[float, float, float, float]],
) -> Image.Image:
    """Pastes `source`'s own pixels back over `target` at each normalised
    box — used to undo a wrongly-placed/translated bubble exactly, instead
    of clean_region()'s flat-fill/inpaint guess, since here we actually have
    the real pre-translation pixels for that spot (see endpoints/regions.py:
    "delete a bubble" / "move a bubble" reuse this for the bubble's old
    box). `source` and `target` may differ in resolution (e.g. the page was
    upscaled); each crop is resized to fit `target`'s pixel box."""
    out = target.convert("RGB").copy()
    for box in boxes:
        src_px = box_to_pixels(source.size, box)
        tgt_px = box_to_pixels(out.size, box)
        patch = source.convert("RGB").crop(src_px)
        target_size = (tgt_px[2] - tgt_px[0], tgt_px[3] - tgt_px[1])
        if patch.size != target_size:
            patch = patch.resize(target_size, Image.LANCZOS)
        out.paste(patch, (tgt_px[0], tgt_px[1]))
    return out


def render_regions(
    base: Image.Image,
    regions: List[Tuple[Tuple[float, float, float, float], str]],
    font_dir: str,
    rendering: Optional[RenderingConfig] = None,
    use_lama: bool = False,
) -> Image.Image:
    """Cleans each region of `base` and draws its text there. Regions with
    empty text are cleaned only (useful for "just remove this text")."""
    image = base.convert("RGB")
    rendering = rendering or RenderingConfig(font_dir=font_dir)
    for box, text in regions:
        px_box = box_to_pixels(image.size, box)
        bgr = cv2.cvtColor(np.array(image), cv2.COLOR_RGB2BGR)
        background = clean_region(bgr, px_box, use_lama=use_lama)
        image = Image.fromarray(cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB))
        if not text.strip():
            continue
        try:
            image = render_text_skia(
                image, text, px_box, font_dir,
                cleaned_mask=None, bubble_color_bgr=background, config=rendering,
            )
        except Exception as e:  # noqa: BLE001 — one bad region must not lose the others
            log_message(f"Manual region render failed for {px_box}: {e}", always_print=True)
    return image
