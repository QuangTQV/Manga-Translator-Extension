"""FastAPI translation endpoints."""
import asyncio
import base64
import io
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager

from fastapi import APIRouter, HTTPException
from PIL import Image

from schemas import (
    SuggestInstructionsRequest,
    SuggestInstructionsResponse,
    TranslateBatchItem,
    TranslateBatchItemResponse,
    TranslateBatchRequest,
    TranslateBatchResponse,
    TranslateRequest,
    TranslateResponse,
)
from core.services.translation import generate_character_notes
from pipeline.wrapper import (
    _build_config,
    image_to_base64_raw,
    translate_image_base64,
)
from config import settings

# Sample images for /suggest-instructions are for a cast/tone overview, not
# pixel-perfect reading — cap count and resolution so this stays a cheap,
# one-off call regardless of how many/how large the pages the user selected.
SUGGEST_INSTRUCTIONS_MAX_IMAGES = 8
SUGGEST_INSTRUCTIONS_MAX_DIMENSION = 1024

router = APIRouter(prefix="", tags=["translate"])

# Thread pool for batch processing
_executor = ThreadPoolExecutor(max_workers=4)

# Shared across /translate and /translate/batch: the two endpoints used to
# have independent, uncoordinated concurrency caps (asyncio.to_thread's
# default executor for single, _executor above for batch), so a single
# request plus a batch running at the same time could push far more than
# max_concurrent_translations ML pipeline runs onto the GPU at once. This
# semaphore is the one hard ceiling on how many run concurrently, across
# both endpoints combined.
_pipeline_semaphore = asyncio.Semaphore(settings.max_concurrent_translations)

# fix_hint requests ("re-translate this bubble/page with a correction") are
# a single action the popup/scanner UI is synchronously spinner-blocked on
# — unlike auto-translate/batch throughput, which the user isn't watching
# page-by-page. Reserve a slice of the total capacity for them so a fix
# never has to queue behind a full auto-translate/batch backlog it has
# nothing to do with; regular (non-fix) work is capped to leave that slice
# free. Mirrors the client's own "reserve one concurrency slot for
# priority work" pattern in the auto-translate queue (content-script
# index.ts, effectiveLimit).
_FIX_HINT_RESERVED_SLOTS = min(2, max(0, settings.max_concurrent_translations - 1))
_regular_pipeline_gate = asyncio.Semaphore(
    max(1, settings.max_concurrent_translations - _FIX_HINT_RESERVED_SLOTS)
)


@asynccontextmanager
async def _pipeline_slot(is_priority: bool):
    """Acquire one of _pipeline_semaphore's permits — the hard ceiling
    every pipeline run obeys. Non-priority callers must also fit within
    _regular_pipeline_gate's smaller cap first, which is what keeps
    _FIX_HINT_RESERVED_SLOTS permits free for priority callers even while
    regular traffic is saturated."""
    if is_priority:
        async with _pipeline_semaphore:
            yield
    else:
        async with _regular_pipeline_gate:
            async with _pipeline_semaphore:
                yield


def _build_bubble_info(bubbles: list[dict]) -> list:
    """Convert bubble dicts to BubbleInfo schema items."""
    from schemas import BubbleInfo

    results = []
    for b in bubbles:
        results.append(
            BubbleInfo(
                bbox=b.get("bbox", []),
                confidence=float(b.get("confidence", 0.0)),
                original_text=b.get("ocr_text"),
                translated_text=b.get("translation", ""),
            )
        )
    return results


@router.post("/translate", response_model=TranslateResponse)
async def translate_single(req: TranslateRequest) -> TranslateResponse:
    """Translate a single image.

    Accepts a base64-encoded image and returns the translated image
    plus bubble metadata.
    """
    models_dir = settings.models_dir
    fonts_dir = settings.fonts_base_dir

    config = _build_config(
        input_language=req.input_language,
        output_language=req.output_language,
        provider=req.provider,
        base_url=req.base_url,
        model_name=req.model_name,
        api_key=req.api_key,
        temperature=req.temperature,
        top_p=req.top_p,
        top_k=req.top_k,
        max_tokens=req.max_tokens,
        translation_mode=req.translation_mode,
        ocr_method=req.ocr_method,
        reasoning_effort=req.reasoning_effort,
        special_instructions=req.special_instructions,
        llm_instructions=req.llm_instructions,
        context_memory_enabled=req.context_memory_enabled,
        context_memory=req.context_memory,
        backup_api_keys=req.backup_api_keys,
        fallback_providers=(
            [fb.model_dump() for fb in req.fallback_providers]
            if req.fallback_providers
            else None
        ),
        fix_hint_bubble_index=req.fix_hint.bubble_index if req.fix_hint else None,
        fix_hint_original_text=req.fix_hint.original_text if req.fix_hint else None,
        fix_hint_instruction=req.fix_hint.instruction if req.fix_hint else None,
        rotation_strategy=req.rotation_strategy,
        cooldown_seconds=req.cooldown_seconds,
        api_key_weight=req.api_key_weight,
        backup_api_key_weights=req.backup_api_key_weights,
        font_dir=req.font_dir,
        max_font_size=req.max_font_size,
        min_font_size=req.min_font_size,
        supersampling_factor=req.supersampling_factor,
        send_full_page_context=req.send_full_page_context,
        image_detail=req.image_detail,
        outside_text_enabled=req.outside_text_enabled,
        models_dir=models_dir,
        fonts_base_dir=fonts_dir,
    )

    start = time.time()
    try:
        async with _pipeline_slot(req.fix_hint is not None):
            result_image, bubbles, elapsed, ocr_texts, memory_note = await asyncio.to_thread(
                translate_image_base64, req.image, config, req.previous_context_texts
            )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Translation failed: {e}")

    translated_b64 = image_to_base64_raw(result_image)

    return TranslateResponse(
        translated_image=translated_b64,
        bubbles=_build_bubble_info(bubbles),
        processing_time_seconds=elapsed,
        source_language=req.input_language,
        target_language=req.output_language,
        provider=req.provider,
        ocr_texts=ocr_texts,
        memory_note=memory_note,
    )


def _translate_single_item(
    item: TranslateBatchItem, req: TranslateBatchRequest
) -> TranslateBatchItemResponse:
    """Translate one item from a batch request (runs in thread pool)."""
    import time as t

    models_dir = settings.models_dir
    fonts_dir = settings.fonts_base_dir

    item_start = t.time()
    try:
        config = _build_config(
            input_language=req.input_language,
            output_language=req.output_language,
            provider=req.provider,
            base_url=req.base_url,
            model_name=req.model_name,
            api_key=req.api_key,
            temperature=req.temperature,
            top_p=req.top_p,
            top_k=req.top_k,
            max_tokens=req.max_tokens,
            translation_mode=req.translation_mode,
            ocr_method=req.ocr_method,
            reasoning_effort=req.reasoning_effort,
            special_instructions=req.special_instructions,
            llm_instructions=req.llm_instructions,
            context_memory_enabled=req.context_memory_enabled,
            context_memory=req.context_memory,
            backup_api_keys=req.backup_api_keys,
            fallback_providers=(
                [fb.model_dump() for fb in req.fallback_providers]
                if req.fallback_providers
                else None
            ),
            fix_hint_bubble_index=req.fix_hint.bubble_index if req.fix_hint else None,
            fix_hint_original_text=req.fix_hint.original_text if req.fix_hint else None,
            fix_hint_instruction=req.fix_hint.instruction if req.fix_hint else None,
            rotation_strategy=req.rotation_strategy,
            cooldown_seconds=req.cooldown_seconds,
            api_key_weight=req.api_key_weight,
            backup_api_key_weights=req.backup_api_key_weights,
            font_dir=req.font_dir,
            max_font_size=req.max_font_size,
            min_font_size=req.min_font_size,
            supersampling_factor=req.supersampling_factor,
            send_full_page_context=req.send_full_page_context,
            image_detail=req.image_detail,
            outside_text_enabled=req.outside_text_enabled,
            models_dir=models_dir,
            fonts_base_dir=fonts_dir,
        )

        result_image, bubbles, _, ocr_texts, memory_note = translate_image_base64(
            item.image, config, req.previous_context_texts
        )
        translated_b64 = image_to_base64_raw(result_image)
        return TranslateBatchItemResponse(
            id=item.id,
            translated_image=translated_b64,
            bubbles=_build_bubble_info(bubbles),
            processing_time_seconds=t.time() - item_start,
            ocr_texts=ocr_texts,
            memory_note=memory_note,
        )
    except Exception as e:
        return TranslateBatchItemResponse(
            id=item.id,
            translated_image=None,
            bubbles=[],
            error=str(e),
            processing_time_seconds=t.time() - item_start,
        )


async def _run_batch_item(
    item: TranslateBatchItem, req: TranslateBatchRequest
) -> TranslateBatchItemResponse:
    """Await one batch item without blocking the event loop, gated by the
    same slot accounting /translate uses so batch + single-page requests
    share one real concurrency ceiling (and fix_hint batch corrections get
    the same priority reservation as a single-page fix)."""
    loop = asyncio.get_running_loop()
    async with _pipeline_slot(req.fix_hint is not None):
        return await loop.run_in_executor(_executor, _translate_single_item, item, req)


@router.post("/translate/batch", response_model=TranslateBatchResponse)
async def translate_batch(req: TranslateBatchRequest) -> TranslateBatchResponse:
    """Translate multiple images concurrently.

    Processes up to 20 images in parallel using a thread pool.
    Returns results in the same order as the input.
    """
    if len(req.images) > 20:
        raise HTTPException(
            status_code=400, detail="Maximum 20 images per batch"
        )

    start = time.time()
    results = await asyncio.gather(*(_run_batch_item(item, req) for item in req.images))

    success_count = sum(1 for r in results if r.error is None)
    error_count = len(results) - success_count

    return TranslateBatchResponse(
        results=results,
        total_time_seconds=time.time() - start,
        success_count=success_count,
        error_count=error_count,
    )


def _downscale_and_reencode_jpeg(raw_b64: str, max_dimension: int) -> str:
    """Decode a client-supplied base64 image, downscale if needed, and
    re-encode as JPEG. Guarantees the mime type we tell the LLM provider
    (image/jpeg) actually matches the bytes, regardless of what format the
    client originally captured (PNG from canvas capture, JPEG from a raw
    fetch fallback, etc.)."""
    image = Image.open(io.BytesIO(base64.b64decode(raw_b64)))
    image.load()
    if image.mode not in ("RGB", "L"):
        image = image.convert("RGB")
    if max(image.size) > max_dimension:
        scale = max_dimension / max(image.size)
        new_size = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        image = image.resize(new_size, Image.LANCZOS)
    return image_to_base64_raw(image, fmt="JPEG")


@router.post("/suggest-instructions", response_model=SuggestInstructionsResponse)
async def suggest_instructions(req: SuggestInstructionsRequest) -> SuggestInstructionsResponse:
    """Draft Special Instructions text from a handful of sample pages.

    A single explicit, user-triggered LLM call — not part of the
    per-page translation pipeline or cache. The user is expected to
    review/edit the result before saving it.

    Sample pages are normally required, but not when the caller has both a
    story title and web search on — in that case there's nothing to look
    at visually yet, and the notes can be drafted purely from search
    results.
    """
    can_search_without_images = req.enable_web_search and bool((req.story_title or "").strip())
    if not req.images and not can_search_without_images:
        raise HTTPException(status_code=400, detail="No sample images provided.")

    sample_images = req.images[:SUGGEST_INSTRUCTIONS_MAX_IMAGES]

    try:
        prepared_images = [
            _downscale_and_reencode_jpeg(img, SUGGEST_INSTRUCTIONS_MAX_DIMENSION)
            for img in sample_images
        ]
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Invalid sample image: {e}")

    config = _build_config(
        input_language="Auto",
        output_language=req.output_language,
        provider=req.provider,
        base_url=req.base_url,
        model_name=req.model_name,
        api_key=req.api_key,
        temperature=req.temperature,
        top_p=req.top_p,
        top_k=req.top_k,
        max_tokens=None,
        translation_mode="one-step",
        ocr_method="LLM",
        reasoning_effort=req.reasoning_effort,
        special_instructions=None,
        backup_api_keys=req.backup_api_keys,
        fallback_providers=(
            [fb.model_dump() for fb in req.fallback_providers]
            if req.fallback_providers
            else None
        ),
        rotation_strategy=req.rotation_strategy,
        cooldown_seconds=req.cooldown_seconds,
        api_key_weight=req.api_key_weight,
        backup_api_key_weights=req.backup_api_key_weights,
        font_dir=None,
        max_font_size=16,
        min_font_size=8,
        supersampling_factor=1,
        send_full_page_context=False,
        image_detail="auto",
        outside_text_enabled=False,
        models_dir=settings.models_dir,
        fonts_base_dir=settings.fonts_base_dir,
        enable_web_search=req.enable_web_search,
    )

    try:
        suggestion = await asyncio.to_thread(
            generate_character_notes,
            config.translation,
            prepared_images,
            req.output_language,
            story_title=req.story_title,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to generate suggestion: {e}")

    return SuggestInstructionsResponse(suggestion=suggestion)


@router.get("/health")
async def health_check():
    """Health check endpoint."""
    import torch

    return {
        "status": "ok",
        "version": "1.0.0",
        "backend_version": "1.0.0",
        "gpu_available": torch.cuda.is_available(),
        "device": "cuda" if torch.cuda.is_available() else "mps" if torch.backends.mps.is_available() else "cpu",
        "cuda_available": torch.cuda.is_available(),
    }


@router.get("/providers")
async def list_providers():
    """Return available LLM providers."""
    return {
        "providers": [
            "Google",
            "OpenAI",
            "Azure OpenAI",
            "Anthropic",
            "xAI",
            "DeepSeek",
            "Z.ai",
            "Moonshot AI",
            "OpenRouter",
            "OpenAI-Compatible",
        ],
        "default_provider": "Google",
    }
