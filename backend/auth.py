"""Account gate for a centrally-hosted deployment. Inert by default — see
config.py's `require_auth` (env MT_REQUIRE_AUTH, default false): a normal
self-hosted/local backend never requires a token, so this dependency
returning None on every route is a no-op for that setup."""
from typing import Optional

from fastapi import Header, HTTPException

from config import settings
from core.accounts import Account, QuotaExceededError, check_and_increment_usage, get_account


async def verify_token(authorization: Optional[str] = Header(None)) -> Optional[Account]:
    """FastAPI dependency for /translate, /translate/batch,
    /suggest-instructions, and /test-key. When require_auth is off
    (default), always returns None without touching the accounts store —
    the exact behavior these routes had before this existed. When on,
    requires a valid `Authorization: Bearer <token>` header, enforces that
    account's usage quota, and returns the account so a caller could log
    which account a request came from if it wanted to."""
    if not settings.require_auth:
        return None

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    token = authorization.removeprefix("Bearer ").strip()
    if not token or not get_account(token):
        raise HTTPException(status_code=401, detail="Invalid account token")

    try:
        return check_and_increment_usage(token)
    except QuotaExceededError as e:
        raise HTTPException(status_code=429, detail=str(e)) from e


async def require_login(authorization: Optional[str] = Header(None)) -> Account:
    """FastAPI dependency for the story-context (character DB) endpoints.
    Unconditionally requires a valid account token, independent of
    require_auth — same shape as require_admin below, minus the
    admin-email check. The character-DB feature is opt-in per user (you
    log in via the Account tab to get it), not tied to whether the
    deployment happens to enforce translate quotas right now."""
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    token = authorization.removeprefix("Bearer ").strip()
    account = get_account(token) if token else None
    if not account:
        raise HTTPException(status_code=401, detail="Invalid account token")
    return account


async def require_admin(authorization: Optional[str] = Header(None)) -> Account:
    """FastAPI dependency for GET/POST /admin/llm-config. Independent of
    require_auth — managing the shared LLM config is always a privileged,
    authenticated action, regardless of whether regular translate requests
    happen to be gated right now. The admin is whichever registered
    account's email matches config.py's admin_email (env MT_ADMIN_EMAIL,
    empty by default) — not a stored per-account flag, so the deployment
    operator can change who's admin just by changing that one env var,
    and so there's no "first signup wins" race to exploit."""
    if not settings.admin_email:
        raise HTTPException(status_code=503, detail="No admin configured (MT_ADMIN_EMAIL not set)")

    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")

    token = authorization.removeprefix("Bearer ").strip()
    account = get_account(token) if token else None
    if not account:
        raise HTTPException(status_code=401, detail="Invalid account token")
    if account.email.lower() != settings.admin_email.lower():
        raise HTTPException(status_code=403, detail="This account is not the configured admin")
    return account


async def require_live_ai_log_access(authorization: Optional[str] = Header(None)) -> Optional[Account]:
    """FastAPI dependency for GET /admin/live-ai-log. A no-op (any request
    allowed) for the normal self-hosted setup (require_auth off) — Live AI
    logging is already opt-in via MT_LIVE_AI_LOG_ENABLED, and this is
    meant as a local debugging tool for whoever already controls that env
    var. On a hosted deployment (require_auth on), the log can contain
    OTHER users' prompts/translations, so only the configured admin may
    view it — reuses require_admin's check rather than duplicating it."""
    if not settings.require_auth:
        return None
    return await require_admin(authorization)
