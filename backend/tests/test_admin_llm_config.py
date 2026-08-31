"""core/server_config.py, auth.py:require_admin, /admin/llm-config, and
endpoints/translate.py:_apply_shared_llm_config — the "Owner" section that
lets a centrally-hosted deployment's operator configure the shared LLM
provider/model/key from the extension popup instead of setting
GOOGLE_API_KEY/etc. env vars by hand. Irrelevant to the normal
local/self-hosted setup.

Needs a real Postgres reachable at MT_DATABASE_URL — skipped entirely
otherwise (see backend/docker-compose.yml for a local one).
"""
import os
from types import SimpleNamespace

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("MT_DATABASE_URL"),
    reason="MT_DATABASE_URL not set — see backend/docker-compose.yml for a local Postgres",
)

import sqlalchemy as sa  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from config import settings  # noqa: E402
from core.accounts import _accounts_table, register_account  # noqa: E402
from core.db import get_engine  # noqa: E402
from core.server_config import (  # noqa: E402
    SchemaMismatchError,
    SecretKeyNotConfiguredError,
    _server_config_table,
    ensure_schema,
    get_shared_llm_config,
    set_shared_llm_config,
)
from endpoints.translate import _apply_shared_llm_config  # noqa: E402
from main import app  # noqa: E402

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean_tables(monkeypatch):
    monkeypatch.setattr(settings, "admin_email", "")
    # set_shared_llm_config() encrypts api_key at rest and refuses to do so
    # without this — most tests here aren't about the encryption itself,
    # so give them a working default and let the dedicated tests below
    # override it.
    monkeypatch.setattr(settings, "secret_key", "test-secret-key-not-for-prod")
    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(_accounts_table.delete())
        conn.execute(_server_config_table.delete())


# ---------------------------------------------------------------------------
# core/server_config.py
# ---------------------------------------------------------------------------
def test_get_shared_llm_config_returns_none_when_unset():
    assert get_shared_llm_config() is None


def test_set_then_get_shared_llm_config_round_trips():
    set_shared_llm_config("Google", "gemini-3.1-flash-lite-preview", "secret-key", None)
    config = get_shared_llm_config()
    assert config is not None
    assert config.provider == "Google"
    assert config.model_name == "gemini-3.1-flash-lite-preview"
    assert config.api_key == "secret-key"


def test_set_shared_llm_config_twice_updates_the_same_row_not_a_second_one():
    set_shared_llm_config("Google", "model-a", "key-a", None)
    set_shared_llm_config("OpenAI", "model-b", "key-b", "https://example.com")
    config = get_shared_llm_config()
    assert config.provider == "OpenAI"
    assert config.model_name == "model-b"
    assert config.api_key == "key-b"
    assert config.base_url == "https://example.com"

    engine = get_engine()
    with engine.connect() as conn:
        count = conn.execute(sa.select(sa.func.count()).select_from(_server_config_table)).scalar()
    assert count == 1


def test_set_shared_llm_config_requires_provider():
    with pytest.raises(ValueError):
        set_shared_llm_config("", "model", "key", None)


def test_api_key_is_encrypted_at_rest_not_stored_in_the_clear():
    set_shared_llm_config("Google", "gemini-3.1-flash-lite-preview", "super-secret-key", None)
    engine = get_engine()
    with engine.connect() as conn:
        row = conn.execute(sa.select(_server_config_table.c.api_key)).first()
    assert row.api_key != "super-secret-key"
    assert "super-secret-key" not in row.api_key
    # ... but round-trips back to plaintext through the real accessor.
    assert get_shared_llm_config().api_key == "super-secret-key"


def test_set_shared_llm_config_without_secret_key_configured_refuses_to_store_the_key(monkeypatch):
    monkeypatch.setattr(settings, "secret_key", "")
    with pytest.raises(SecretKeyNotConfiguredError):
        set_shared_llm_config("Google", "model", "some-key", None)


def test_set_shared_llm_config_without_secret_key_still_works_with_no_key(monkeypatch):
    # Provider/model/base_url with no api_key at all doesn't touch
    # encryption, so it shouldn't need MT_SECRET_KEY either.
    monkeypatch.setattr(settings, "secret_key", "")
    config = set_shared_llm_config("Google", "model", None, None)
    assert config.api_key is None


def test_get_shared_llm_config_raises_if_secret_key_changed_after_saving(monkeypatch):
    set_shared_llm_config("Google", "model", "super-secret-key", None)
    monkeypatch.setattr(settings, "secret_key", "a-completely-different-secret")
    from core.server_config import SecretKeyMismatchError
    with pytest.raises(SecretKeyMismatchError):
        get_shared_llm_config()


def test_admin_get_endpoint_surfaces_secret_key_mismatch_as_500(monkeypatch):
    monkeypatch.setattr(settings, "admin_email", "owner@example.com")
    account = register_account("owner@example.com")
    headers = {"Authorization": f"Bearer {account.token}"}
    client.post("/admin/llm-config", json={"provider": "Google", "api_key": "a-key"}, headers=headers)

    monkeypatch.setattr(settings, "secret_key", "a-completely-different-secret")
    resp = client.get("/admin/llm-config", headers=headers)
    assert resp.status_code == 500


def test_ensure_schema_rejects_a_pre_existing_incompatible_server_llm_config_table():
    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(sa.text("DROP TABLE server_llm_config"))
        conn.execute(sa.text("CREATE TABLE server_llm_config (id serial primary key, foo text)"))
    try:
        with pytest.raises(SchemaMismatchError):
            ensure_schema()
    finally:
        with engine.begin() as conn:
            conn.execute(sa.text("DROP TABLE server_llm_config"))
        _server_config_table.metadata.create_all(engine)


# ---------------------------------------------------------------------------
# auth.py:require_admin, via GET/POST /admin/llm-config
# ---------------------------------------------------------------------------
def test_admin_endpoint_rejects_when_no_admin_configured():
    account = register_account("someone@example.com")
    resp = client.get("/admin/llm-config", headers={"Authorization": f"Bearer {account.token}"})
    assert resp.status_code == 503


def test_admin_endpoint_rejects_missing_token(monkeypatch):
    monkeypatch.setattr(settings, "admin_email", "owner@example.com")
    resp = client.get("/admin/llm-config")
    assert resp.status_code == 401


def test_admin_endpoint_rejects_non_admin_account(monkeypatch):
    monkeypatch.setattr(settings, "admin_email", "owner@example.com")
    account = register_account("not-the-owner@example.com")
    resp = client.get("/admin/llm-config", headers={"Authorization": f"Bearer {account.token}"})
    assert resp.status_code == 403


def test_admin_endpoint_accepts_the_configured_admin_email_case_insensitively(monkeypatch):
    monkeypatch.setattr(settings, "admin_email", "Owner@Example.com")
    account = register_account("owner@example.com")
    resp = client.get("/admin/llm-config", headers={"Authorization": f"Bearer {account.token}"})
    assert resp.status_code == 200


def test_admin_can_set_and_read_back_shared_config_without_key_leaking(monkeypatch):
    monkeypatch.setattr(settings, "admin_email", "owner@example.com")
    account = register_account("owner@example.com")
    headers = {"Authorization": f"Bearer {account.token}"}

    resp = client.post(
        "/admin/llm-config",
        json={"provider": "Google", "model_name": "gemini-3.1-flash-lite-preview", "api_key": "super-secret"},
        headers=headers,
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["provider"] == "Google"
    assert body["api_key_set"] is True
    assert "api_key" not in body  # never echoed back

    get_resp = client.get("/admin/llm-config", headers=headers)
    assert get_resp.json()["api_key_set"] is True


def test_saving_without_api_key_does_not_wipe_the_existing_key(monkeypatch):
    monkeypatch.setattr(settings, "admin_email", "owner@example.com")
    account = register_account("owner@example.com")
    headers = {"Authorization": f"Bearer {account.token}"}

    client.post("/admin/llm-config", json={"provider": "Google", "api_key": "first-key"}, headers=headers)
    # Admin only wants to change the model this time — doesn't retype the key.
    resp = client.post("/admin/llm-config", json={"provider": "Google", "model_name": "gemini-3.1-pro"}, headers=headers)
    assert resp.status_code == 200
    assert resp.json()["api_key_set"] is True

    stored = get_shared_llm_config()
    assert stored.api_key == "first-key"
    assert stored.model_name == "gemini-3.1-pro"


# ---------------------------------------------------------------------------
# endpoints/translate.py:_apply_shared_llm_config
# ---------------------------------------------------------------------------
def _fake_req(provider="Google", model_name=None, api_key=None, base_url=None):
    return SimpleNamespace(provider=provider, model_name=model_name, api_key=api_key, base_url=base_url)


def test_apply_shared_config_noop_when_not_authenticated():
    set_shared_llm_config("OpenAI", "gpt-5.4-nano", "shared-key", None)
    req = _fake_req(provider="Google", api_key="")
    _apply_shared_llm_config(req, None)
    assert req.provider == "Google"
    assert req.api_key == ""


def test_apply_shared_config_noop_when_request_already_has_its_own_key():
    set_shared_llm_config("OpenAI", "gpt-5.4-nano", "shared-key", None)
    account = register_account("byok-user@example.com")
    req = _fake_req(provider="Google", api_key="users-own-key")
    _apply_shared_llm_config(req, account)
    assert req.provider == "Google"
    assert req.api_key == "users-own-key"


def test_apply_shared_config_overrides_when_authenticated_and_no_own_key():
    set_shared_llm_config("OpenAI", "gpt-5.4-nano", "shared-key", "https://example.com")
    account = register_account("hosted-user@example.com")
    req = _fake_req(provider="Google", model_name=None, api_key="", base_url=None)
    _apply_shared_llm_config(req, account)
    assert req.provider == "OpenAI"
    assert req.model_name == "gpt-5.4-nano"
    assert req.api_key == "shared-key"
    assert req.base_url == "https://example.com"


def test_apply_shared_config_noop_when_nothing_configured_yet():
    account = register_account("hosted-user2@example.com")
    req = _fake_req(provider="Google", api_key="")
    _apply_shared_llm_config(req, account)
    assert req.provider == "Google"
    assert req.api_key == ""
