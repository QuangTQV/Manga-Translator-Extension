"""Admin-only endpoints for a centrally-hosted deployment
(MT_REQUIRE_AUTH=true) — lets the operator (see auth.py:require_admin,
config.py's MT_ADMIN_EMAIL) configure the server-wide shared LLM provider/
model/key from the extension popup's Owner section, instead of setting
GOOGLE_API_KEY/etc. env vars by hand and redeploying. Irrelevant to (and
untouched by) the normal local/self-hosted setup.
"""
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse

from auth import require_admin, require_live_ai_log_access
from config import settings
from core.accounts import Account
from core.live_ai_log import (
    find_image_file,
    image_media_type,
    images_enabled,
    read_recent_live_ai_log,
    set_images_enabled,
)
from core.server_config import (
    SecretKeyMismatchError,
    SecretKeyNotConfiguredError,
    get_shared_llm_config,
    set_shared_llm_config,
)
from schemas import (
    LiveAiLogResponse,
    LiveAiLogSettings,
    LiveAiLogSettingsUpdate,
    SharedLlmConfigRequest,
    SharedLlmConfigResponse,
)

router = APIRouter(prefix="/admin", tags=["admin"])


def _to_response(config) -> SharedLlmConfigResponse:
    if config is None:
        return SharedLlmConfigResponse(provider="", model_name=None, api_key_set=False, base_url=None)
    return SharedLlmConfigResponse(
        provider=config.provider,
        model_name=config.model_name,
        api_key_set=bool(config.api_key),
        base_url=config.base_url,
    )


@router.get("/llm-config", response_model=SharedLlmConfigResponse)
async def get_llm_config(_admin: Account = Depends(require_admin)) -> SharedLlmConfigResponse:
    try:
        return _to_response(get_shared_llm_config())
    except SecretKeyMismatchError as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.post("/llm-config", response_model=SharedLlmConfigResponse)
async def set_llm_config(
    req: SharedLlmConfigRequest, _admin: Account = Depends(require_admin),
) -> SharedLlmConfigResponse:
    # GET never echoes the real key back (see SharedLlmConfigResponse), so
    # the popup's edit form can't pre-fill it — an empty api_key here means
    # "I didn't mean to touch the key", not "clear it", or every save that
    # only changes e.g. the model name would silently wipe the stored key.
    try:
        api_key = req.api_key
        if not api_key:
            existing = get_shared_llm_config()
            api_key = existing.api_key if existing else None

        config = set_shared_llm_config(
            provider=req.provider, model_name=req.model_name,
            api_key=api_key, base_url=req.base_url,
        )
    except SecretKeyMismatchError as e:
        raise HTTPException(status_code=500, detail=str(e))
    except SecretKeyNotConfiguredError as e:
        raise HTTPException(status_code=503, detail=str(e))
    return _to_response(config)


@router.get("/live-ai-log", response_model=LiveAiLogResponse)
async def get_live_ai_log(
    limit: int = 200,
    since: float | None = None,
    _access: Account | None = Depends(require_live_ai_log_access),
) -> LiveAiLogResponse:
    """Recent entries from the optional "Live AI" debug log (every LLM
    call this backend has made, any provider — see core/live_ai_log.py),
    for an operator to inspect without SSH-ing in to tail the file
    directly. `since` (a timestamp from an earlier response) returns only
    newer entries, for the extension's auto-refreshing viewer. 404s when the feature itself is off (MT_LIVE_AI_LOG_ENABLED)
    rather than silently returning an empty list, so "disabled" and "no
    calls logged yet" aren't indistinguishable."""
    if not settings.live_ai_log_enabled:
        raise HTTPException(
            status_code=404,
            detail="Live AI logging is disabled (set MT_LIVE_AI_LOG_ENABLED=true)",
        )
    entries = read_recent_live_ai_log(min(max(limit, 1), 1000), since)
    return LiveAiLogResponse(entries=entries)


def _require_live_ai_log_enabled() -> None:
    if not settings.live_ai_log_enabled:
        raise HTTPException(
            status_code=404,
            detail="Live AI logging is disabled (set MT_LIVE_AI_LOG_ENABLED=true)",
        )


def _live_ai_settings() -> LiveAiLogSettings:
    return LiveAiLogSettings(
        images=images_enabled(),
        images_default=settings.live_ai_log_images,
        images_max_mb=settings.live_ai_images_max_mb,
    )


@router.get("/live-ai-log/settings", response_model=LiveAiLogSettings)
async def get_live_ai_log_settings(_access: Account | None = Depends(require_live_ai_log_access)) -> LiveAiLogSettings:
    """The viewer's switches. Same access rules as the log itself."""
    _require_live_ai_log_enabled()
    return _live_ai_settings()


@router.post("/live-ai-log/settings", response_model=LiveAiLogSettings)
async def set_live_ai_log_settings(
    update: LiveAiLogSettingsUpdate, _access: Account | None = Depends(require_live_ai_log_access),
) -> LiveAiLogSettings:
    """Turns "Save images" on/off without a restart. Applies to calls made
    from now on and lasts until the backend restarts (then MT_LIVE_AI_LOG_IMAGES
    applies again); it is per process, so with several backend workers each
    keeps its own switch."""
    _require_live_ai_log_enabled()
    set_images_enabled(update.images)
    return _live_ai_settings()


@router.get("/live-ai-log/images/{image_id}")
async def get_live_ai_log_image(image_id: str, _access: Account | None = Depends(require_live_ai_log_access)) -> FileResponse:
    """One image that was sent to the model (see LiveAiLogEntry.images).
    Content-addressed, so it can be cached for good."""
    _require_live_ai_log_enabled()
    path = find_image_file(image_id)  # validates the id: hex only, never a path
    if path is None:
        raise HTTPException(status_code=404, detail="Image not found (it may have been deleted to stay under the size limit)")
    return FileResponse(path, media_type=image_media_type(path), headers={"Cache-Control": "private, max-age=86400"})
