"""auth.py's verify_token dependency, exercised through the real FastAPI
app — confirms the two things that matter most: (1) a normal self-hosted
backend (require_auth off, the default) is completely unaffected, and (2) a
hosted deployment (require_auth on) actually enforces a valid, non-exhausted
account token on the gated routes.

Uses /test-key as the gated endpoint under test (cheapest to reach — it
short-circuits with a clean ok:false before ever calling an LLM when the
key/URL is missing/invalid, so no network I/O happens), and /account/*
directly for the account-management routes.

The account-related tests here need a real Postgres reachable at
MT_DATABASE_URL — skipped entirely otherwise (see
backend/docker-compose.yml for a local one).
"""
import os

import pytest
from fastapi.testclient import TestClient

from config import settings
from main import app

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    not os.environ.get("MT_DATABASE_URL"),
    reason="MT_DATABASE_URL not set — see backend/docker-compose.yml for a local Postgres",
)

from core.accounts import _accounts_table, register_account  # noqa: E402
from core.db import get_engine  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_accounts_table(monkeypatch):
    monkeypatch.setattr(settings, "require_auth", False)
    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(_accounts_table.delete())


def test_gated_route_works_without_a_token_when_require_auth_is_off():
    resp = client.post("/test-key", json={"provider": "Google", "api_key": ""})
    assert resp.status_code == 200
    assert resp.json()["ok"] is False  # empty key -> a clean failure, not an auth error


def test_gated_route_rejects_missing_token_when_require_auth_is_on(monkeypatch):
    monkeypatch.setattr(settings, "require_auth", True)
    resp = client.post("/test-key", json={"provider": "Google", "api_key": ""})
    assert resp.status_code == 401


def test_gated_route_rejects_invalid_token_when_require_auth_is_on(monkeypatch):
    monkeypatch.setattr(settings, "require_auth", True)
    resp = client.post(
        "/test-key", json={"provider": "Google", "api_key": ""},
        headers={"Authorization": "Bearer not-a-real-token"},
    )
    assert resp.status_code == 401


def test_gated_route_accepts_a_valid_token_when_require_auth_is_on(monkeypatch):
    monkeypatch.setattr(settings, "require_auth", True)
    account = register_account("hosted-user@example.com")
    resp = client.post(
        "/test-key", json={"provider": "Google", "api_key": ""},
        headers={"Authorization": f"Bearer {account.token}"},
    )
    assert resp.status_code == 200


def test_gated_route_enforces_quota_when_require_auth_is_on(monkeypatch):
    monkeypatch.setattr(settings, "require_auth", True)
    account = register_account("quota-user@example.com")
    for _ in range(account.quota):
        resp = client.post(
            "/test-key", json={"provider": "Google", "api_key": ""},
            headers={"Authorization": f"Bearer {account.token}"},
        )
        assert resp.status_code == 200
    over_quota = client.post(
        "/test-key", json={"provider": "Google", "api_key": ""},
        headers={"Authorization": f"Bearer {account.token}"},
    )
    assert over_quota.status_code == 429


def test_health_and_providers_are_never_gated(monkeypatch):
    # Connectivity checks stay open regardless of require_auth — a user
    # should be able to tell "is this backend reachable" without an account.
    monkeypatch.setattr(settings, "require_auth", True)
    assert client.get("/health").status_code == 200
    assert client.get("/providers").status_code == 200


def test_account_register_then_me_round_trips():
    reg = client.post("/account/register", json={"email": "new-user@example.com"})
    assert reg.status_code == 200
    body = reg.json()
    assert body["plan"] == "free"
    assert body["token"]

    me = client.get("/account/me", headers={"Authorization": f"Bearer {body['token']}"})
    assert me.status_code == 200
    me_body = me.json()
    assert me_body["email"] == "new-user@example.com"
    # /account/me never echoes the token back.
    assert me_body["token"] is None


def test_account_register_duplicate_email_returns_409():
    client.post("/account/register", json={"email": "dupe@example.com"})
    resp = client.post("/account/register", json={"email": "dupe@example.com"})
    assert resp.status_code == 409


def test_account_me_without_token_is_rejected():
    resp = client.get("/account/me")
    assert resp.status_code == 401


def test_account_plan_change_updates_quota():
    reg = client.post("/account/register", json={"email": "upgrade-me@example.com"})
    token = reg.json()["token"]
    resp = client.post("/account/plan", json={"plan": "paid"}, headers={"Authorization": f"Bearer {token}"})
    assert resp.status_code == 200
    assert resp.json()["plan"] == "paid"
    assert resp.json()["quota"] > 50


def test_account_logout_revokes_the_token():
    reg = client.post("/account/register", json={"email": "logout-me@example.com"})
    token = reg.json()["token"]

    logout = client.post("/account/logout", headers={"Authorization": f"Bearer {token}"})
    assert logout.status_code == 200
    assert logout.json()["ok"] is True

    me = client.get("/account/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 401


def test_account_logout_without_a_token_is_rejected():
    resp = client.post("/account/logout")
    assert resp.status_code == 401


def test_account_logout_unknown_token_is_rejected():
    resp = client.post("/account/logout", headers={"Authorization": "Bearer nope"})
    assert resp.status_code == 401
