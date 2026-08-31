"""Account management for a centrally-hosted deployment
(MT_REQUIRE_AUTH=true) — registration, status, and a plan-change endpoint
that stands in for a real payment webhook. Irrelevant to (and untouched by)
the normal local/self-hosted setup: these routes exist regardless, but
nothing else in the app calls them unless require_auth is on and the
extension's Account tab is used.
"""
import requests
from fastapi import APIRouter, Header, HTTPException

from config import settings
from core.accounts import (
    Account,
    AccountExistsError,
    AccountNotFoundError,
    find_or_create_account,
    get_account,
    register_account,
    revoke_token,
    set_plan,
)
from schemas import AccountResponse, GoogleLoginRequest, RegisterAccountRequest, SetPlanRequest

router = APIRouter(prefix="/account", tags=["account"])

GOOGLE_TOKENINFO_URL = "https://oauth2.googleapis.com/tokeninfo"


def _to_response(account: Account, include_token: bool = False) -> AccountResponse:
    return AccountResponse(
        email=account.email,
        token=account.token if include_token else None,
        plan=account.plan,
        usage_count=account.usage_count,
        quota=account.quota,
        period_start=account.period_start,
        is_admin=bool(settings.admin_email) and account.email.lower() == settings.admin_email.lower(),
    )


def _token_from_header(authorization: str | None) -> str:
    if not authorization or not authorization.startswith("Bearer "):
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    token = authorization.removeprefix("Bearer ").strip()
    if not token:
        raise HTTPException(status_code=401, detail="Missing or invalid Authorization header")
    return token


@router.post("/register", response_model=AccountResponse)
async def register(req: RegisterAccountRequest) -> AccountResponse:
    """No email verification or payment collection — this is scaffolding
    for a hosted deployment to build a real signup flow on top of."""
    try:
        account = register_account(req.email)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except AccountExistsError as e:
        raise HTTPException(status_code=409, detail=str(e))
    return _to_response(account, include_token=True)


@router.get("/me", response_model=AccountResponse)
async def me(authorization: str = Header(None)) -> AccountResponse:
    token = _token_from_header(authorization)
    account = get_account(token)
    if not account:
        raise HTTPException(status_code=401, detail="Invalid account token")
    return _to_response(account)


@router.post("/plan", response_model=AccountResponse)
async def change_plan(req: SetPlanRequest, authorization: str = Header(None)) -> AccountResponse:
    """Stand-in for a real payment webhook — sets the plan directly with no
    payment verification. A real deployment would call core.accounts.set_plan
    from a Stripe (or similar) webhook handler instead of exposing this."""
    token = _token_from_header(authorization)
    try:
        account = set_plan(token, req.plan)
    except AccountNotFoundError as e:
        raise HTTPException(status_code=401, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _to_response(account)


@router.post("/logout")
async def logout(authorization: str = Header(None)) -> dict:
    """Revokes the caller's current token server-side (see
    core/accounts.py:revoke_token) — a self-serve "sign out this device"
    that actually invalidates the credential, not just a local
    chrome.storage clear. The account (email/plan/usage) is untouched;
    only Google Sign-In can issue that email a new token afterward."""
    token = _token_from_header(authorization)
    try:
        revoke_token(token)
    except AccountNotFoundError as e:
        raise HTTPException(status_code=401, detail=str(e))
    return {"ok": True}


@router.post("/google-login", response_model=AccountResponse)
async def google_login(req: GoogleLoginRequest) -> AccountResponse:
    """"Sign in with Google" for the extension's Account tab
    (chrome.identity.getAuthToken()) — verifies the access token against
    Google's own tokeninfo endpoint rather than trusting the client, then
    finds or creates the matching account. Returning users get their
    existing account back (not a 409, unlike /register)."""
    try:
        resp = requests.get(
            GOOGLE_TOKENINFO_URL, params={"access_token": req.access_token}, timeout=10,
        )
    except requests.exceptions.RequestException as e:
        raise HTTPException(status_code=502, detail=f"Could not reach Google: {e}")

    if not resp.ok:
        raise HTTPException(status_code=401, detail="Invalid or expired Google access token")

    info = resp.json()
    if settings.google_oauth_client_id and info.get("aud") != settings.google_oauth_client_id:
        raise HTTPException(status_code=401, detail="Token was not issued for this app")
    if info.get("email_verified") not in ("true", True):
        raise HTTPException(status_code=401, detail="Google account email is not verified")
    email = info.get("email")
    if not email:
        raise HTTPException(status_code=401, detail="Google token did not include an email")

    account = find_or_create_account(email)
    return _to_response(account, include_token=True)
