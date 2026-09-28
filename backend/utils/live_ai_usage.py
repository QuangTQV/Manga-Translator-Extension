"""Context-local token usage reported by the current LLM provider response."""
from __future__ import annotations

import contextvars
import base64
import io
import math
import unicodedata
from typing import Any, Optional

_token_usage: contextvars.ContextVar[
    Optional[tuple[Optional[int], Optional[int], Optional[int]]]
] = contextvars.ContextVar("live_ai_token_usage", default=None)


def record_token_usage(usage: Any) -> None:
    """Capture provider-reported token counts for the current LLM call."""
    if not isinstance(usage, dict):
        return
    input_tokens = next(
        (
            usage.get(key)
            for key in ("input_tokens", "prompt_tokens", "promptTokenCount")
            if isinstance(usage.get(key), int)
        ),
        None,
    )
    output_tokens = next(
        (
            usage.get(key)
            for key in ("output_tokens", "completion_tokens", "candidatesTokenCount")
            if isinstance(usage.get(key), int)
        ),
        None,
    )
    cached_tokens = next(
        (
            usage.get(key)
            for key in (
                "cache_read_input_tokens",  # Anthropic
                "prompt_cache_hit_tokens",  # DeepSeek
                "cached_tokens",  # OpenAI-compatible usage details
                "cachedContentTokenCount",  # Gemini
            )
            if isinstance(usage.get(key), int)
        ),
        None,
    )
    for details_key in ("prompt_tokens_details", "input_tokens_details"):
        details = usage.get(details_key)
        if cached_tokens is None and isinstance(details, dict):
            value = details.get("cached_tokens")
            if isinstance(value, int):
                cached_tokens = value
    if cached_tokens is None:
        value = usage.get("cachedContentTokenCount")
        if isinstance(value, int):
            cached_tokens = value
    metadata = usage.get("usageMetadata")
    if cached_tokens is None and isinstance(metadata, dict):
        value = metadata.get("cachedContentTokenCount")
        if isinstance(value, int):
            cached_tokens = value
    # Anthropic reports cache-read and cache-write input separately from
    # input_tokens; include them to show the full prompt token volume.
    if input_tokens is not None:
        input_tokens += sum(
            value
            for key in ("cache_read_input_tokens", "cache_creation_input_tokens")
            if isinstance((value := usage.get(key)), int)
        )
    if input_tokens is not None or output_tokens is not None:
        _token_usage.set((input_tokens, output_tokens, cached_tokens))


def current_token_usage() -> Optional[tuple[Optional[int], Optional[int], Optional[int]]]:
    return _token_usage.get()


def clear_token_usage() -> None:
    _token_usage.set(None)


def _estimate_text_tokens(text: str) -> int:
    """Rough mixed-script estimate: CJK characters count near one token,
    other text averages about four characters per token."""
    cjk = 0
    other = 0
    for char in text:
        if unicodedata.category(char).startswith("C"):
            continue
        name = unicodedata.name(char, "")
        if any(script in name for script in ("CJK", "HIRAGANA", "KATAKANA", "HANGUL")):
            cjk += 1
        else:
            other += 1
    return cjk + math.ceil(other / 4)


def _image_dimensions(data: str) -> Optional[tuple[int, int]]:
    try:
        from PIL import Image

        encoded = data.split(",", 1)[-1]
        with Image.open(io.BytesIO(base64.b64decode(encoded))) as image:
            return image.size
    except Exception:
        return None


def _estimate_image_tokens(provider: str, parts: list[dict[str, Any]]) -> int:
    provider_key = provider.lower()
    estimate = 0
    for part in parts:
        inline = part.get("inline_data") if isinstance(part, dict) else None
        if not isinstance(inline, dict) or not isinstance(inline.get("data"), str):
            continue
        dimensions = _image_dimensions(inline["data"])
        if not dimensions:
            estimate += 258
            continue
        width, height = dimensions
        if "anthropic" in provider_key:
            estimate += math.ceil(width / 28) * math.ceil(height / 28)
        elif "openai" in provider_key or "azure" in provider_key or "xai" in provider_key:
            tiles = math.ceil(width / 512) * math.ceil(height / 512)
            estimate += 85 + 170 * tiles
        else:
            tiles = math.ceil(width / 768) * math.ceil(height / 768)
            estimate += 258 * tiles
    return estimate


def estimate_token_usage(
    provider: str,
    system_prompt: Optional[str],
    prompt_text: str,
    parts: list[dict[str, Any]],
    response_text: Optional[str],
) -> tuple[int, int]:
    """Provider-agnostic fallback; image counts are especially approximate."""
    text_parts = [
        part["text"]
        for part in parts
        if isinstance(part, dict) and isinstance(part.get("text"), str)
    ]
    input_text = "\n".join(text_parts) if text_parts else prompt_text
    input_estimate = _estimate_text_tokens(input_text)
    if system_prompt:
        input_estimate += _estimate_text_tokens(system_prompt)
    input_estimate += _estimate_image_tokens(provider, parts)
    output_estimate = _estimate_text_tokens(response_text or "")
    return input_estimate, output_estimate
