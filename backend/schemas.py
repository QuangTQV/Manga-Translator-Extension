"""Pydantic request/response schemas for the translation endpoints."""
from typing import List, Optional

from pydantic import BaseModel


class BubbleInfo(BaseModel):
    bbox: List[float]
    confidence: float
    original_text: Optional[str] = None
    translated_text: str
    high_res_crop: Optional[str] = None  # raw base64 PNG, pre-downscale supersampled render of just this bubble — sharper than cropping the final page image, for UI magnifiers. None when supersampling was off.


class FallbackProviderConfig(BaseModel):
    """A fallback LLM provider to try if the primary provider (and its
    backup keys) are all rate-limited."""

    provider: str
    model_name: Optional[str] = None
    api_keys: List[str] = []
    api_key_weights: Optional[List[float]] = None  # relative pick weight per key (same order as api_keys), used only when rotation_strategy is "random"
    base_url: Optional[str] = None  # Azure endpoint, or OpenAI-Compatible URL
    reasoning_effort: Optional[str] = None  # overrides the top-level reasoning_effort for this fallback provider; unset inherits it


class FixHintConfig(BaseModel):
    """A user-supplied correction, applied on a re-translate of the whole
    page. When bubble_index is set, original_text identifies that bubble
    from a prior TranslateResponse.bubbles list and the LLM is instructed
    to fix just that bubble, leaving the rest unaffected. When bubble_index
    is omitted, the instruction is applied as a general correction across
    the whole page instead (e.g. a recurring mistake fixed across several
    pages at once)."""

    bubble_index: Optional[int] = None
    original_text: Optional[str] = None
    instruction: str


class TranslateOptions(BaseModel):
    """Fields shared by single and batch translation requests."""

    input_language: str
    output_language: str
    provider: str
    base_url: Optional[str] = None
    model_name: Optional[str] = None
    api_key: Optional[str] = None
    temperature: float = 0.1
    top_p: float = 0.95
    top_k: int = 40
    max_tokens: Optional[int] = None
    translation_mode: str = "one-step"
    ocr_method: str = "LLM"
    reasoning_effort: Optional[str] = None
    special_instructions: Optional[str] = None
    llm_instructions: Optional[str] = None
    font_dir: Optional[str] = None
    max_font_size: int = 16
    min_font_size: int = 8
    supersampling_factor: int = 4
    send_full_page_context: bool = True
    image_detail: str = "auto"
    outside_text_enabled: bool = False
    previous_context_texts: Optional[List[List[str]]] = None  # oldest-to-newest OCR transcripts of prior pages
    context_memory_enabled: bool = False  # ask the model for a MEMORY NOTE summary each page
    context_memory: Optional[str] = None  # accumulated MEMORY NOTE summaries from earlier pages, caller-formatted
    backup_api_keys: Optional[List[str]] = None  # extra keys for the same provider/model, tried on rate limit
    fallback_providers: Optional[List[FallbackProviderConfig]] = None  # tried after primary + backup keys are rate-limited
    fix_hint: Optional[FixHintConfig] = None  # re-translate this page with a targeted correction for one bubble
    rotation_strategy: Optional[str] = None  # "round_robin" (default), "random", or "sequential" — which candidate to try first
    cooldown_seconds: Optional[float] = None  # how long a rate-limited key/provider is skipped before being retried (default 15s)
    api_key_weight: Optional[float] = None  # relative pick weight for `api_key`, used only when rotation_strategy is "random"
    backup_api_key_weights: Optional[List[float]] = None  # relative pick weight per key (same order as backup_api_keys), used only when rotation_strategy is "random"


class TranslateRequest(TranslateOptions):
    image: str  # raw base64 (no data: prefix)


class TranslateResponse(BaseModel):
    translated_image: str  # raw base64
    bubbles: List[BubbleInfo]
    processing_time_seconds: float
    source_language: str
    target_language: str
    provider: str
    ocr_texts: List[str] = []  # this page's OCR transcripts, in reading order
    memory_note: Optional[str] = None  # this page's MEMORY NOTE summary, if context memory was enabled


class TranslateBatchItem(BaseModel):
    id: Optional[str] = None
    image: str  # raw base64


class TranslateBatchRequest(TranslateOptions):
    images: List[TranslateBatchItem]


class TranslateBatchItemResponse(BaseModel):
    id: Optional[str] = None
    translated_image: Optional[str] = None
    bubbles: List[BubbleInfo] = []
    error: Optional[str] = None
    processing_time_seconds: Optional[float] = None
    ocr_texts: List[str] = []  # this page's OCR transcripts, in reading order
    memory_note: Optional[str] = None  # this page's MEMORY NOTE summary, if context memory was enabled


class TranslateBatchResponse(BaseModel):
    results: List[TranslateBatchItemResponse]
    total_time_seconds: float
    success_count: int
    error_count: int


class SuggestInstructionsRequest(BaseModel):
    """A handful of sample page images from the same manga, used for a
    one-off LLM call that drafts Special Instructions text (cast,
    relationships, tone) for the user to review before saving."""

    images: List[str]  # raw base64 sample page images, no data: prefix
    output_language: str
    provider: str
    base_url: Optional[str] = None
    model_name: Optional[str] = None
    api_key: Optional[str] = None
    temperature: float = 0.1
    top_p: float = 0.95
    top_k: int = 40
    reasoning_effort: Optional[str] = None
    backup_api_keys: Optional[List[str]] = None
    fallback_providers: Optional[List[FallbackProviderConfig]] = None
    rotation_strategy: Optional[str] = None
    cooldown_seconds: Optional[float] = None
    api_key_weight: Optional[float] = None
    backup_api_key_weights: Optional[List[float]] = None
    enable_web_search: bool = False  # let the model use its provider's built-in web search to look up the story
    story_title: Optional[str] = None  # user-supplied title, to search for when enable_web_search is set


class SuggestInstructionsResponse(BaseModel):
    suggestion: str


class TestApiKeyRequest(BaseModel):
    """One (provider, model, key) combo to ping — the popup's "Test API
    Key" button, not part of the translate flow."""

    provider: str
    model_name: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None  # Azure endpoint, or OpenAI-Compatible URL
    reasoning_effort: Optional[str] = None  # same value the real translate request for this row would send


class TestApiKeyResponse(BaseModel):
    ok: bool
    error: Optional[str] = None
    latency_ms: Optional[float] = None
