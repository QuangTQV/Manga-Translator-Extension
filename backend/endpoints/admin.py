"""Admin-only endpoints for a centrally-hosted deployment
(MT_REQUIRE_AUTH=true) — lets the operator (see auth.py:require_admin,
config.py's MT_ADMIN_EMAIL) configure the server-wide shared LLM provider/
model/key from the extension popup's Owner section, instead of setting
GOOGLE_API_KEY/etc. env vars by hand and redeploying. Irrelevant to (and
untouched by) the normal local/self-hosted setup.
"""
from fastapi import APIRouter, Depends, HTTPException

from auth import require_admin
from core.accounts import Account
from core.server_config import (
    SecretKeyMismatchError,
    SecretKeyNotConfiguredError,
    get_shared_llm_config,
    set_shared_llm_config,
)
from schemas import SharedLlmConfigRequest, SharedLlmConfigResponse

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
