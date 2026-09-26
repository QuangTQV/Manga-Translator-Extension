"""LaMa inpainting (big-lama, TorchScript) — the middle option between the
lightweight OpenCV fill and Flux: ~200MB, runs on CPU in seconds, and
reconstructs panel borders/screentone/hatching that cv2.inpaint just smears.

Works on a crop around the mask (with surrounding context) rather than the
whole page — faster, and LaMa only needs local context — and only ever
writes back masked pixels, so nothing outside the text region changes.
"""
import threading
from typing import Optional, Tuple

import numpy as np
import torch
from PIL import Image

from core.ml.model_manager import ModelManager, ModelType
from utils.logging import log_message

# One TorchScript module is shared by concurrent request threads.
_INFERENCE_LOCK = threading.Lock()
# Context kept around the masked area, relative to its size (min in px).
_CONTEXT_FRACTION = 0.5
_MIN_CONTEXT_PX = 48
# Crops larger than this are downscaled for inference; the result is scaled
# back and only masked pixels are used, so unmasked detail is never touched.
_MAX_SIDE = 1536


def _run_model(img: np.ndarray, mask: np.ndarray, device, verbose: bool) -> np.ndarray:
    """img HxWx3 uint8, mask HxW bool, both already multiples of 8."""
    manager = ModelManager()
    model, model_device = manager.load_lama(device, verbose=verbose)
    image_t = torch.from_numpy(img).permute(2, 0, 1)[None].float().div_(255.0)
    mask_t = torch.from_numpy(mask.astype(np.float32))[None, None]
    with _INFERENCE_LOCK, torch.inference_mode():
        try:
            out = model(image_t.to(model_device), mask_t.to(model_device))
        except Exception as e:
            if model_device.type == "cpu":
                raise
            # Some accelerators (e.g. MPS) lack the FFT ops LaMa relies on.
            log_message(f"LaMa failed on {model_device} ({e}); retrying on CPU", verbose=verbose)
            model = model.to("cpu")
            model_device = torch.device("cpu")
            manager.models[ModelType.LAMA] = (model, model_device)
            out = model(image_t, mask_t)
    result = out[0].permute(1, 2, 0).float().cpu().numpy()
    if result.max() <= 1.5:  # the exported model outputs 0..1
        result = result * 255.0
    return np.clip(result, 0, 255).astype(np.uint8)


def _pad_to_multiple_of_8(img: np.ndarray, mask: np.ndarray) -> Tuple[np.ndarray, np.ndarray]:
    h, w = mask.shape
    ph, pw = (8 - h % 8) % 8, (8 - w % 8) % 8
    if not ph and not pw:
        return img, mask
    img = np.pad(img, ((0, ph), (0, pw), (0, 0)), mode="reflect" if min(h, w) > 1 else "edge")
    mask = np.pad(mask, ((0, ph), (0, pw)), mode="constant")
    return img, mask


def lama_inpaint_rgb(rgb: np.ndarray, mask: np.ndarray, device=None, verbose: bool = False) -> np.ndarray:
    """Inpaint the nonzero pixels of `mask` (HxW) in `rgb` (HxWx3 uint8).
    Returns a new array; pixels outside the mask are left exactly as they were."""
    m = np.asarray(mask).astype(bool)
    if not m.any():
        return rgb.copy()
    h, w = m.shape
    ys, xs = np.nonzero(m)
    y0, y1, x0, x1 = int(ys.min()), int(ys.max()) + 1, int(xs.min()), int(xs.max()) + 1
    context = max(_MIN_CONTEXT_PX, int(max(y1 - y0, x1 - x0) * _CONTEXT_FRACTION))
    cy0, cy1 = max(0, y0 - context), min(h, y1 + context)
    cx0, cx1 = max(0, x0 - context), min(w, x1 + context)
    crop = rgb[cy0:cy1, cx0:cx1]
    crop_mask = m[cy0:cy1, cx0:cx1]
    ch, cw = crop_mask.shape

    scale = min(1.0, _MAX_SIDE / max(ch, cw))
    work_img, work_mask = crop, crop_mask
    if scale < 1.0:
        size = (max(8, round(cw * scale)), max(8, round(ch * scale)))
        work_img = np.array(Image.fromarray(crop).resize(size, Image.LANCZOS))
        work_mask = np.array(Image.fromarray(crop_mask.astype(np.uint8) * 255).resize(size, Image.NEAREST)) > 127
    wh, ww = work_mask.shape
    padded_img, padded_mask = _pad_to_multiple_of_8(work_img, work_mask)

    result = _run_model(padded_img, padded_mask, device, verbose)[:wh, :ww]
    if scale < 1.0:
        result = np.array(Image.fromarray(result).resize((cw, ch), Image.LANCZOS))

    merged = crop.copy()
    merged[crop_mask] = result[crop_mask]
    out = rgb.copy()
    out[cy0:cy1, cx0:cx1] = merged
    return out


class LamaInpainter:
    """Same inpaint_mask() shape as FluxKleinInpainter, so the outside-text
    pipeline (core/outside_text_processor.py) can use either interchangeably."""

    def __init__(self, device=None, verbose: bool = False):
        self.device = device
        self.verbose = verbose
        # Load (and download, first time) now, so an unavailable model falls
        # back to OpenCV at setup time, the same way the Flux inpainters do.
        ModelManager().load_lama(device, verbose=verbose)

    def inpaint_mask(
        self,
        image: Image.Image,
        mask,
        seed: Optional[int] = None,
        verbose: bool = False,
        strict_mask_clipping: bool = True,
        composite_clip_bbox: Optional[Tuple[int, int, int, int]] = None,
        ocr_params=None,
        **_kwargs,
    ) -> Image.Image:
        m = np.asarray(mask).astype(bool)
        if composite_clip_bbox is not None:
            x1, y1, x2, y2 = composite_clip_bbox
            clipped = np.zeros_like(m)
            clipped[max(0, y1):max(0, y2), max(0, x1):max(0, x2)] = m[max(0, y1):max(0, y2), max(0, x1):max(0, x2)]
            m = clipped
        if not m.any():
            return image
        rgb = np.array(image.convert("RGB"))
        result = Image.fromarray(lama_inpaint_rgb(rgb, m, self.device, verbose or self.verbose))
        return result if image.mode == "RGB" else result.convert(image.mode)
