"""POST /account/google-login — "Sign in with Google" for the extension's
Account tab. The extension sends an OAuth access token from
chrome.identity.getAuthToken(); this verifies it against Google's own
tokeninfo endpoint (mocked here) rather than trusting the client.

Needs a real Postgres reachable at MT_DATABASE_URL — skipped entirely
otherwise (see backend/docker-compose.yml for a local one).
"""
import os
from unittest.mock import MagicMock, patch

import pytest
from fastapi.testclient import TestClient

from config import settings
from main import app

client = TestClient(app)

pytestmark = pytest.mark.skipif(
    not os.environ.get("MT_DATABASE_URL"),
    reason="MT_DATABASE_URL not set — see backend/docker-compose.yml for a local Postgres",
)

from core.accounts import _accounts_table, check_and_increment_usage  # noqa: E402
from core.db import get_engine  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_accounts_table(monkeypatch):
    monkeypatch.setattr(settings, "google_oauth_client_id", "")
    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(_accounts_table.delete())


def _mock_tokeninfo(status_ok=True, **fields):
    resp = MagicMock()
    resp.ok = status_ok
    resp.json.return_value = {
        "aud": "expected-client-id.apps.googleusercontent.com",
        "email": "googleuser@example.com",
        "email_verified": "true",
        **fields,
    }
    return resp


def test_google_login_creates_a_new_account():
    with patch("endpoints.account.requests.get", return_value=_mock_tokeninfo()):
        resp = client.post("/account/google-login", json={"access_token": "fake-access-token"})
    assert resp.status_code == 200
    body = resp.json()
    assert body["email"] == "googleuser@example.com"
    assert body["plan"] == "free"
    assert body["token"]


def test_google_login_returning_user_gets_the_same_account_not_a_conflict():
    # Each login mints a fresh token (find_or_create_account rotates it —
    # see core/accounts.py), so "same account" is no longer provable by
    # comparing tokens directly. Instead: bump usage on the first login's
    # token, then confirm the second login's token reflects that same
    # usage_count rather than a fresh account starting back at 0.
    with patch("endpoints.account.requests.get", return_value=_mock_tokeninfo()):
        first = client.post("/account/google-login", json={"access_token": "token-1"})
    assert first.status_code == 200
    first_token = first.json()["token"]
    check_and_increment_usage(first_token)  # usage_count -> 1 on the underlying row

    with patch("endpoints.account.requests.get", return_value=_mock_tokeninfo()):
        second = client.post("/account/google-login", json={"access_token": "token-2"})
    assert second.status_code == 200
    second_token = second.json()["token"]

    assert first_token != second_token  # rotated, not reused
    me = client.get("/account/me", headers={"Authorization": f"Bearer {second_token}"})
    assert me.status_code == 200
    assert me.json()["email"] == "googleuser@example.com"
    assert me.json()["usage_count"] == 1  # same underlying row, not a fresh account
    # The first (now-stale) token no longer authenticates at all.
    stale = client.get("/account/me", headers={"Authorization": f"Bearer {first_token}"})
    assert stale.status_code == 401


def test_google_login_rejects_invalid_token():
    with patch("endpoints.account.requests.get", return_value=_mock_tokeninfo(status_ok=False)):
        resp = client.post("/account/google-login", json={"access_token": "bad"})
    assert resp.status_code == 401


def test_google_login_rejects_unverified_email():
    with patch("endpoints.account.requests.get", return_value=_mock_tokeninfo(email_verified="false")):
        resp = client.post("/account/google-login", json={"access_token": "fake"})
    assert resp.status_code == 401


def test_google_login_rejects_audience_mismatch_when_client_id_configured(monkeypatch):
    monkeypatch.setattr(settings, "google_oauth_client_id", "expected-client-id.apps.googleusercontent.com")
    with patch("endpoints.account.requests.get", return_value=_mock_tokeninfo(aud="some-other-app.apps.googleusercontent.com")):
        resp = client.post("/account/google-login", json={"access_token": "fake"})
    assert resp.status_code == 401


def test_google_login_accepts_matching_audience_when_client_id_configured(monkeypatch):
    monkeypatch.setattr(settings, "google_oauth_client_id", "expected-client-id.apps.googleusercontent.com")
    with patch("endpoints.account.requests.get", return_value=_mock_tokeninfo()):
        resp = client.post("/account/google-login", json={"access_token": "fake"})
    assert resp.status_code == 200
