"""core/live_ai_log.py (the optional "Live AI" debug logger — every LLM
call this backend makes, any provider) and its wiring into
core/services/translation.py:_call_llm_endpoint_impl, plus the
GET /admin/live-ai-log viewing endpoint (auth.py:require_live_ai_log_access).

Most of this needs no database — MT_LIVE_AI_LOG_ENABLED and the log file
are pure local state. The require_auth=on admin-gating cases at the bottom
need a real Postgres (same as test_admin_llm_config.py) and skip
themselves individually when MT_DATABASE_URL isn't set.
"""
import json
import os

import pytest
from fastapi.testclient import TestClient

from config import settings
from core.config import TranslationConfig
from core.live_ai_log import log_ai_call, read_recent_live_ai_log
from core.services.translation import _call_llm_endpoint
# Aliased on import — pytest's default collection would otherwise try to
# treat this imported production function as a test case, since its name
# happens to start with "test_".
from core.services.translation import test_api_key as call_test_api_key
from main import app

client = TestClient(app)


@pytest.fixture(autouse=True)
def _reset_settings(tmp_path, monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_enabled", False)
    monkeypatch.setattr(settings, "live_ai_log_path", tmp_path / "live_ai.jsonl")
    monkeypatch.setattr(settings, "require_auth", False)
    monkeypatch.setattr(settings, "admin_email", "")


# ---------------------------------------------------------------------------
# core/live_ai_log.py — direct unit tests
# ---------------------------------------------------------------------------
def test_log_ai_call_is_a_noop_when_disabled():
    log_ai_call(
        provider="Google", model_name="gemini-3.1-flash", call_type="translate",
        system_prompt=None, prompt_text="hello", parts_for_size_estimate=[],
        response_text="world", error=None, latency_ms=100.0,
    )
    assert not settings.live_ai_log_path.exists()
    assert read_recent_live_ai_log() == []


def test_log_ai_call_writes_a_json_line_when_enabled(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    log_ai_call(
        provider="Google", model_name="gemini-3.1-flash", call_type="translate",
        system_prompt="sys", prompt_text="hello", parts_for_size_estimate=[{"a": 1}],
        response_text="world", error=None, latency_ms=123.4,
    )
    assert settings.live_ai_log_path.exists()
    lines = settings.live_ai_log_path.read_text().splitlines()
    assert len(lines) == 1
    entry = json.loads(lines[0])
    assert entry["provider"] == "Google"
    assert entry["model"] == "gemini-3.1-flash"
    assert entry["call_type"] == "translate"
    assert entry["prompt_text"] == "hello"
    assert entry["response_text"] == "world"
    assert entry["error"] is None
    assert entry["latency_ms"] == 123.4
    assert entry["images_count"] == 1


def test_log_ai_call_never_stores_raw_image_data_only_count_and_kb(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    huge_fake_image_b64 = "A" * 500_000  # simulate a large base64 image payload
    log_ai_call(
        provider="Google", model_name="m", call_type="translate",
        system_prompt=None, prompt_text="p",
        parts_for_size_estimate=[{"inline_data": {"data": huge_fake_image_b64}}],
        response_text="r", error=None, latency_ms=1.0,
    )
    raw = settings.live_ai_log_path.read_text()
    assert huge_fake_image_b64 not in raw
    entry = json.loads(raw.splitlines()[0])
    assert entry["images_count"] == 1
    assert entry["images_kb"] > 400  # roughly the size of the fake payload, not zero


def test_log_ai_call_records_errors(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    log_ai_call(
        provider="OpenAI", model_name="gpt-5.4", call_type="test_key",
        system_prompt=None, prompt_text="p", parts_for_size_estimate=[],
        response_text=None, error="Invalid API key", latency_ms=50.0,
    )
    entry = json.loads(settings.live_ai_log_path.read_text().splitlines()[0])
    assert entry["response_text"] is None
    assert entry["error"] == "Invalid API key"


def test_read_recent_live_ai_log_returns_newest_first_and_respects_limit(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    for i in range(5):
        log_ai_call(
            provider="Google", model_name="m", call_type="translate",
            system_prompt=None, prompt_text=f"prompt-{i}", parts_for_size_estimate=[],
            response_text=f"response-{i}", error=None, latency_ms=1.0,
        )
    all_entries = read_recent_live_ai_log(limit=100)
    assert [e["prompt_text"] for e in all_entries] == ["prompt-4", "prompt-3", "prompt-2", "prompt-1", "prompt-0"]

    limited = read_recent_live_ai_log(limit=2)
    assert [e["prompt_text"] for e in limited] == ["prompt-4", "prompt-3"]


def test_read_recent_live_ai_log_skips_corrupt_lines(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    log_ai_call(
        provider="Google", model_name="m", call_type="translate",
        system_prompt=None, prompt_text="ok", parts_for_size_estimate=[],
        response_text="fine", error=None, latency_ms=1.0,
    )
    with settings.live_ai_log_path.open("a") as f:
        f.write("not valid json\n")
    entries = read_recent_live_ai_log()
    assert len(entries) == 1
    assert entries[0]["prompt_text"] == "ok"


def test_rotation_moves_oversized_log_to_backup_file(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    import core.live_ai_log as live_ai_log_module
    monkeypatch.setattr(live_ai_log_module, "_MAX_BYTES", 10)  # force rotation on the very next write

    settings.live_ai_log_path.parent.mkdir(parents=True, exist_ok=True)
    settings.live_ai_log_path.write_text("x" * 100)  # already "oversized"

    log_ai_call(
        provider="Google", model_name="m", call_type="translate",
        system_prompt=None, prompt_text="new entry", parts_for_size_estimate=[],
        response_text="r", error=None, latency_ms=1.0,
    )

    backup = settings.live_ai_log_path.with_suffix(".jsonl.1")
    assert backup.exists()
    assert backup.read_text() == "x" * 100
    # The fresh file only has the new entry, not the old oversized content.
    entries = read_recent_live_ai_log()
    assert len(entries) == 1
    assert entries[0]["prompt_text"] == "new entry"


# ---------------------------------------------------------------------------
# Wiring: core/services/translation.py's real call paths log the right
# call_type — verified by mocking only the actual provider dispatch
# (_dispatch_llm_call), not the logging wrapper itself.
# ---------------------------------------------------------------------------
def test_translate_call_path_logs_call_type_translate(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    monkeypatch.setattr(
        "core.services.translation._dispatch_llm_call",
        lambda *a, **k: "translated text",
    )
    config = TranslationConfig(provider="Google", google_api_key="key-A", model_name="gemini-3.1-flash")
    result = _call_llm_endpoint(config, [], "translate this")
    assert result == "translated text"

    entries = read_recent_live_ai_log()
    assert len(entries) == 1
    assert entries[0]["call_type"] == "translate"
    assert entries[0]["response_text"] == "translated text"


def test_suggest_instructions_call_path_logs_call_type_suggest_instructions(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    monkeypatch.setattr(
        "core.services.translation._dispatch_llm_call",
        lambda *a, **k: "- some note",
    )
    config = TranslationConfig(provider="Google", google_api_key="key-A", model_name="gemini-3.1-flash")
    _call_llm_endpoint(config, [], "draft notes", call_type="suggest_instructions")

    entries = read_recent_live_ai_log()
    assert entries[0]["call_type"] == "suggest_instructions"

    # Calling _call_llm_endpoint again WITHOUT call_type must not leak the
    # previous call's value — this is exactly the ContextVar staleness
    # risk the design has to avoid under a reused worker thread.
    _call_llm_endpoint(config, [], "translate this")
    entries = read_recent_live_ai_log()
    assert entries[0]["call_type"] == "translate"


def test_test_key_call_path_logs_call_type_test_key(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    monkeypatch.setattr(
        "core.services.translation._dispatch_llm_call",
        lambda *a, **k: "OK",
    )
    config = TranslationConfig(provider="Google", google_api_key="key-A", model_name="gemini-3.1-flash")
    ok, err = call_test_api_key(config)
    assert ok is True

    entries = read_recent_live_ai_log()
    assert entries[0]["call_type"] == "test_key"


def test_failed_call_is_logged_with_the_error_and_re_raised(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)

    def raise_it(*a, **k):
        raise ValueError("boom")

    monkeypatch.setattr("core.services.translation._dispatch_llm_call", raise_it)
    config = TranslationConfig(provider="Google", google_api_key="key-A", model_name="gemini-3.1-flash")
    with pytest.raises(Exception):
        _call_llm_endpoint(config, [], "translate this")

    entries = read_recent_live_ai_log()
    assert entries[0]["response_text"] is None
    assert "boom" in entries[0]["error"]


# ---------------------------------------------------------------------------
# GET /admin/live-ai-log
# ---------------------------------------------------------------------------
def test_live_ai_log_endpoint_404s_when_feature_disabled():
    resp = client.get("/admin/live-ai-log")
    assert resp.status_code == 404


def test_live_ai_log_endpoint_needs_no_auth_on_the_normal_self_hosted_setup(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    log_ai_call(
        provider="Google", model_name="m", call_type="translate", system_prompt=None,
        prompt_text="p", parts_for_size_estimate=[], response_text="r", error=None, latency_ms=1.0,
    )
    resp = client.get("/admin/live-ai-log")
    assert resp.status_code == 200
    assert len(resp.json()["entries"]) == 1


def test_live_ai_log_endpoint_respects_limit_query_param(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    for i in range(3):
        log_ai_call(
            provider="Google", model_name="m", call_type="translate", system_prompt=None,
            prompt_text=f"p{i}", parts_for_size_estimate=[], response_text="r", error=None, latency_ms=1.0,
        )
    resp = client.get("/admin/live-ai-log?limit=1")
    assert resp.status_code == 200
    assert len(resp.json()["entries"]) == 1


@pytest.mark.skipif(
    not os.environ.get("MT_DATABASE_URL"),
    reason="MT_DATABASE_URL not set — see backend/docker-compose.yml for a local Postgres",
)
def test_live_ai_log_endpoint_requires_admin_when_require_auth_is_on(monkeypatch):
    from core.accounts import _accounts_table, register_account
    from core.db import get_engine

    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(_accounts_table.delete())

    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    monkeypatch.setattr(settings, "require_auth", True)
    monkeypatch.setattr(settings, "admin_email", "owner@example.com")

    # No token at all -> unauthorized.
    assert client.get("/admin/live-ai-log").status_code == 401

    # Logged in, but not the admin -> forbidden.
    other = register_account("someone-else@example.com")
    resp = client.get("/admin/live-ai-log", headers={"Authorization": f"Bearer {other.token}"})
    assert resp.status_code == 403

    # The configured admin -> allowed.
    admin = register_account("owner@example.com")
    resp = client.get("/admin/live-ai-log", headers={"Authorization": f"Bearer {admin.token}"})
    assert resp.status_code == 200

    with engine.begin() as conn:
        conn.execute(_accounts_table.delete())
