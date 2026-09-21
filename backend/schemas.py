"""Pydantic request/response schemas for the translation endpoints."""
from typing import List, Optional

from pydantic import BaseModel, field_validator

# Character assets are stored inline as small data URLs (the popup downscales
# them before upload) — these caps keep a single story document bounded.
MAX_AVATAR_CHARS = 60_000
MAX_REFERENCE_IMAGE_CHARS = 200_000
MAX_REFERENCE_IMAGES_PER_CHARACTER = 2


def _check_data_url(value: str, limit: int, what: str) -> str:
    if not value.startswith("data:image/"):
        raise ValueError(f"{what} must be an image data URL")
    if len(value) > limit:
        raise ValueError(f"{what} is too large (max {limit} characters)")
    return value


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


class StoryCharacter(BaseModel):
    """One character in a Story DB (see core/story_context.py) — a
    client-generated id links it to StoryRelationship entries below."""

    id: str
    name: str
    gender: str = "unknown"  # male | female | other | unknown
    role: Optional[str] = None
    voice_notes: Optional[str] = None  # personality/tone, for consistent voice across pages
    # Position on the popup's relationship map (0-360 x 0-260). Presentation
    # only — never sent to the model. Unset until the user drags the node.
    x: Optional[float] = None
    y: Optional[float] = None
    # Character assets — data URLs. `avatar` is display-only (popup + map).
    # `reference_images` (character sheets etc.) are only ever sent to the model
    # when the request opts in via story_use_reference_images.
    avatar: Optional[str] = None
    reference_images: List[str] = []

    @field_validator("avatar")
    @classmethod
    def _valid_avatar(cls, v):
        return _check_data_url(v, MAX_AVATAR_CHARS, "avatar") if v else None

    @field_validator("reference_images")
    @classmethod
    def _valid_references(cls, v):
        if len(v) > MAX_REFERENCE_IMAGES_PER_CHARACTER:
            raise ValueError(f"at most {MAX_REFERENCE_IMAGES_PER_CHARACTER} reference images per character")
        return [_check_data_url(i, MAX_REFERENCE_IMAGE_CHARS, "reference image") for i in v]


class StoryRelationship(BaseModel):
    """How two characters relate/address each other — a "surface"
    description (not a psychology model), just enough to get pronouns/
    honorifics/register right."""

    id: str
    character_a_id: str
    character_b_id: str
    surface_relation: str  # e.g. "boss and employee", "secretly in love"
    address_notes: Optional[str] = None  # how they address each other, if not obvious from surface_relation


class StoryGlossaryTerm(BaseModel):
    """A fixed term translation (skill/item/nickname/place name) to keep
    consistent across pages instead of leaving it to the model each time."""

    id: str
    term: str
    translation: str
    notes: Optional[str] = None


class StoryContinuityNote(BaseModel):
    """A short, user-maintained note about something that happened/was
    revealed in the story (e.g. "Ch.5: Ren is revealed to be Aoi's
    half-brother") — simpler than a categorized fact ledger: just free
    text plus an optional source label, manually kept by the user rather
    than auto-extracted. Only sent to the model when the story's
    continuity_notes_enabled toggle is on."""

    id: str
    text: str
    source_label: Optional[str] = None  # e.g. "Chapter 5" or "Page 12" — where this was established


class StoryContextPayload(BaseModel):
    """Body of PUT /stories/{id} — a full replace of one story's content."""

    name: str
    characters: List[StoryCharacter] = []
    relationships: List[StoryRelationship] = []
    glossary: List[StoryGlossaryTerm] = []
    continuity_notes: List[StoryContinuityNote] = []
    continuity_notes_enabled: bool = False  # on/off switch — notes are kept even when off, just not sent to the model


class CreateStoryRequest(BaseModel):
    """Body of POST /stories — creates an empty story the user then fills
    in via PUT /stories/{id}."""

    name: str


class StorySummary(BaseModel):
    """One row of GET /stories — enough to populate a picker without
    fetching every story's full content."""

    id: str
    name: str
    updated_at: float


class StoryDetail(StoryContextPayload):
    id: str
    updated_at: float


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
    economy_mode: bool = False  # cut LLM spend: downscale the full-page context image and lower its media resolution (the client also turns off the costlier context options)
    outside_text_enabled: bool = False
    inpainting_method: Optional[str] = None  # "auto" (default) | "flux_klein_4b" | "flux_klein_9b" | "flux_kontext" | "opencv" | "none" — omitted means "auto"
    flux_remote_token: Optional[str] = None  # shared secret for the remote worker (X-Flux-Worker-Token), if it was started with one
    flux_remote_base_url: Optional[str] = None  # run Flux on a remote worker (backend/flux_worker.py) instead of loading it locally; only used when inpainting_method is a flux_* variant
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
    story_use_reference_images: bool = False  # also send each character's reference images (character sheets) to the model — more tokens; only applies with LLM OCR
    story_id: Optional[str] = None  # id of a logged-in-account Story DB (see core/story_context.py) to inject as structured context; ignored when not logged in or the id doesn't resolve
    # Populated server-side by endpoints/translate.py:_resolve_story_context() when story_id
    # resolves against the logged-in account — not meant to be set by the client directly.
    story_characters: List[StoryCharacter] = []
    story_relationships: List[StoryRelationship] = []
    story_glossary: List[StoryGlossaryTerm] = []
    story_continuity_notes: List[StoryContinuityNote] = []  # only populated when the story's continuity_notes_enabled is on


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
    warnings: List[str] = []  # non-fatal issues the UI should surface, e.g. "flux_remote_unreachable", "flux_remote_unauthorized"


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
    warnings: List[str] = []


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


class RegisterAccountRequest(BaseModel):
    email: str


class AccountResponse(BaseModel):
    email: str
    token: Optional[str] = None  # only present on /account/register — never returned by /account/me
    plan: str
    usage_count: int
    quota: int
    period_start: float
    is_admin: bool = False  # true iff this account's email matches the server's MT_ADMIN_EMAIL


class SetPlanRequest(BaseModel):
    """Stand-in for what a real payment webhook (Stripe checkout completed
    / subscription cancelled) would call — no payment is verified here."""

    plan: str


class GoogleLoginRequest(BaseModel):
    """access_token from the extension's chrome.identity.getAuthToken() —
    NOT an ID token/JWT. Verified server-side against Google's tokeninfo
    endpoint (see endpoints/account.py:google_login)."""

    access_token: str


class SharedLlmConfigRequest(BaseModel):
    """Admin-only (see auth.py:require_admin) — the LLM provider/model/key
    every hosted user's request falls back to when they haven't supplied
    their own. Set via the extension popup's Owner section instead of
    editing GOOGLE_API_KEY/etc. env vars by hand."""

    provider: str
    model_name: Optional[str] = None
    api_key: Optional[str] = None
    base_url: Optional[str] = None  # Azure endpoint, or OpenAI-Compatible URL


class SharedLlmConfigResponse(BaseModel):
    provider: str
    model_name: Optional[str] = None
    # Never echoes the real key back — only whether one is currently set,
    # so the popup can show "configured" without re-displaying the secret
    # every time an admin opens the tab.
    api_key_set: bool = False
    base_url: Optional[str] = None


class LiveAiLogEntry(BaseModel):
    """One recorded LLM call — see core/live_ai_log.py. Image data is
    deliberately excluded (just a count + approximate KB)."""

    timestamp: float
    provider: str
    model: Optional[str] = None
    call_type: str  # "translate" | "suggest_instructions" | "test_key"
    system_prompt: Optional[str] = None
    prompt_text: str
    images_count: int
    images_kb: float
    response_text: Optional[str] = None
    error: Optional[str] = None
    latency_ms: float


class LiveAiLogResponse(BaseModel):
    entries: List[LiveAiLogEntry]
