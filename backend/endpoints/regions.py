"""Manual region endpoints: read the text in a user-drawn box, translate a
piece of text, and draw text into boxes. See core/manual_region.py."""
import asyncio
import re

from fastapi import APIRouter, Depends, HTTPException

from auth import verify_token
from core.manual_region import (
    box_to_pixels,
    crop_for_ocr,
    decode_image,
    encode_png,
    render_regions,
    restore_regions,
)
from core.services.translation import (
    _call_llm_endpoint,
    _format_special_instructions,
    _format_story_context,
    _perform_manga_ocr,
    _perform_paddle_ocr_vl,
)
from endpoints.translate import (
    _apply_shared_llm_config,
    _config_for_request,
    _pipeline_slot,
    _reject_oversized_image,
    _resolve_story_context,
)
from schemas import (
    RegionBox,
    RegionOcrRequest,
    RegionOcrResponse,
    RegionRenderRequest,
    RegionRenderResponse,
    RegionTranslateRequest,
    RegionTranslateResponse,
)

router = APIRouter(prefix="/region")

OCR_FAILED_MARKERS = ("[OCR FAILED]",)
MAX_REGION_TEXT_CHARS = 4000
MAX_REGIONS_PER_RENDER = 50


def _box_tuple(box: RegionBox):
    return (box.x1, box.y1, box.x2, box.y2)


def _read_text(req: RegionOcrRequest, config) -> str:
    image = decode_image(req.image)
    px_box = box_to_pixels(image.size, _box_tuple(req.box))
    crop = crop_for_ocr(image, px_box)
    crop_b64 = encode_png(crop)

    method = config.translation.ocr_method
    if method == "manga-ocr":
        results = _perform_manga_ocr([crop_b64], [{}])
    elif method == "paddleocr-vl":
        results = _perform_paddle_ocr_vl([crop_b64], [{}])
    else:
        prompt = (
            "Transcribe all text in this image exactly as written, in reading order. "
            "Output only the text — no commentary, quotes or formatting."
        )
        part = {"inline_data": {"mime_type": "image/png", "data": crop_b64}}
        raw = _call_llm_endpoint(config.translation, [part], prompt, call_type="ocr_region")
        results = [(raw or "").strip()]
    return (results[0] if results else "") or ""


@router.post("/ocr", response_model=RegionOcrResponse)
async def region_ocr(req: RegionOcrRequest, account=Depends(verify_token)) -> RegionOcrResponse:
    _apply_shared_llm_config(req, account)
    _reject_oversized_image(req.image)
    config = _config_for_request(req)
    try:
        async with _pipeline_slot(False):
            text = await asyncio.to_thread(_read_text, req, config)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OCR failed: {e}")
    text = text.strip()
    if not text or any(marker in text for marker in OCR_FAILED_MARKERS):
        return RegionOcrResponse(text="", warning="ocr_failed")
    return RegionOcrResponse(text=text)


def _clean_translation(raw: str) -> str:
    text = (raw or "").strip()
    fence = re.match(r"^```[a-zA-Z]*\n?(.*?)\n?```$", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    if len(text) >= 2 and text[0] == text[-1] and text[0] in "\"'“”「」":
        text = text[1:-1].strip()
    return text


@router.post("/translate", response_model=RegionTranslateResponse)
async def region_translate(req: RegionTranslateRequest, account=Depends(verify_token)) -> RegionTranslateResponse:
    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Nothing to translate")
    if len(text) > MAX_REGION_TEXT_CHARS:
        raise HTTPException(status_code=400, detail="Text is too long")
    _apply_shared_llm_config(req, account)
    _resolve_story_context(req, account)
    config = _config_for_request(req)
    tconf = config.translation

    prompt = f"""
Translate this text from a manga page into {req.output_language}.
Source language: {req.input_language}. Keep it natural and short enough to fit the same speech bubble.
Output ONLY the translated text — no quotes, notes or explanations.
{_format_story_context(tconf)}{_format_special_instructions(tconf)}
## TEXT
{text}
""".strip()
    try:
        raw = await asyncio.to_thread(_call_llm_endpoint, tconf, [], prompt, False, None, "translate_region")
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Translation failed: {e}")
    translation = _clean_translation(raw or "")
    if not translation:
        raise HTTPException(status_code=502, detail="The model returned no translation")
    return RegionTranslateResponse(translation=translation)


@router.post("/render", response_model=RegionRenderResponse)
async def region_render(req: RegionRenderRequest, account=Depends(verify_token)) -> RegionRenderResponse:
    if len(req.regions) > MAX_REGIONS_PER_RENDER:
        raise HTTPException(status_code=400, detail=f"At most {MAX_REGIONS_PER_RENDER} regions per page")
    _reject_oversized_image(req.image)
    if req.source_image:
        _reject_oversized_image(req.source_image)
    config = _config_for_request(req)

    def work() -> str:
        base = decode_image(req.image)
        restore_boxes = [_box_tuple(r.box) for r in req.regions if r.restore_only]
        if restore_boxes:
            if not req.source_image:
                raise ValueError("source_image is required when a region has restore_only set")
            base = restore_regions(base, decode_image(req.source_image), restore_boxes)
        draw_regions = [(_box_tuple(r.box), r.text) for r in req.regions if not r.restore_only]
        return encode_png(render_regions(base, draw_regions, config.rendering.font_dir, config.rendering))

    try:
        async with _pipeline_slot(False):
            image_b64 = await asyncio.to_thread(work)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Render failed: {e}")
    return RegionRenderResponse(image=image_b64)
