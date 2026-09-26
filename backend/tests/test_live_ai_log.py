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


def _write_entries(path, entries):
    with path.open("w", encoding="utf-8") as f:
        for e in entries:
            f.write(json.dumps(e, ensure_ascii=False) + "\n")


def _entry(i, ts=None, text="x"):
    return {
        "timestamp": float(i if ts is None else ts), "provider": "Google", "model": "m", "call_type": "translate",
        "system_prompt": None, "prompt_text": f"p{i}", "images_count": 0, "images_kb": 0.0,
        "response_text": text, "error": None, "latency_ms": 1.0,
    }


def test_since_returns_only_entries_newer_than_it_newest_first():
    _write_entries(settings.live_ai_log_path, [_entry(i) for i in range(1, 8)])
    assert [e["prompt_text"] for e in read_recent_live_ai_log(since=5)] == ["p7", "p6"]
    assert read_recent_live_ai_log(since=7) == []
    assert read_recent_live_ai_log(since=999) == []
    assert len(read_recent_live_ai_log(since=0, limit=3)) == 3  # limit still applies


def test_tail_reading_is_correct_across_chunk_boundaries_with_multibyte_text(monkeypatch):
    import core.live_ai_log as live

    # Tiny chunks so entries (with multi-byte characters) straddle many
    # boundaries; the result must still match a plain full read.
    monkeypatch.setattr(live, "_TAIL_CHUNK", 37)
    entries = [_entry(i, text="漫画 ✓ " * (i % 5 + 1) + "é" * i) for i in range(1, 40)]
    _write_entries(settings.live_ai_log_path, entries)
    got = read_recent_live_ai_log(limit=1000)
    assert got == list(reversed(entries))
    assert read_recent_live_ai_log(limit=3) == list(reversed(entries))[:3]


def test_tail_reading_handles_a_missing_final_newline_and_an_empty_file():
    path = settings.live_ai_log_path
    path.write_text("")
    assert read_recent_live_ai_log() == []
    path.write_text(json.dumps(_entry(1)) + "\n" + json.dumps(_entry(2)))  # no trailing newline
    assert [e["prompt_text"] for e in read_recent_live_ai_log()] == ["p2", "p1"]


def test_a_large_log_is_read_from_the_tail_not_in_full(monkeypatch):
    import core.live_ai_log as live

    _write_entries(settings.live_ai_log_path, [_entry(i, text="y" * 2000) for i in range(1, 2001)])  # ~4 MB
    reads = []
    real_open = live.Path.open

    def counting_open(self, *a, **k):
        f = real_open(self, *a, **k)
        real_read = f.read
        f.read = lambda n=-1: (reads.append(n), real_read(n))[1]
        return f

    monkeypatch.setattr(live.Path, "open", counting_open)
    got = read_recent_live_ai_log(limit=5)
    assert [e["prompt_text"] for e in got] == ["p2000", "p1999", "p1998", "p1997", "p1996"]
    assert sum(n for n in reads if n > 0) < 1024 * 1024  # a small tail, not the whole ~4 MB


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


def test_live_ai_log_endpoint_since_returns_only_newer_entries(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    _write_entries(settings.live_ai_log_path, [_entry(i) for i in range(1, 6)])
    resp = client.get("/admin/live-ai-log?since=3")
    assert resp.status_code == 200
    assert [e["prompt_text"] for e in resp.json()["entries"]] == ["p5", "p4"]
    assert client.get("/admin/live-ai-log?since=5").json() == {"entries": []}


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


# ---------------------------------------------------------------------------
# "Save images": the images sent to the model kept on disk, off by default
# ---------------------------------------------------------------------------
import base64  # noqa: E402
import io  # noqa: E402

from PIL import Image  # noqa: E402

import core.live_ai_log as live  # noqa: E402


def _png_b64(color=(200, 30, 30), size=(8, 8)) -> str:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _jpeg_b64(size=(8, 8)) -> str:
    buf = io.BytesIO()
    Image.new("RGB", size, (10, 120, 200)).save(buf, format="JPEG")
    return base64.b64encode(buf.getvalue()).decode()


def _log(monkeypatch, parts, **kw):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    log_ai_call(
        provider="Google", model_name="m", call_type="translate", system_prompt=None, prompt_text="p",
        parts_for_size_estimate=parts, response_text="r", error=None, latency_ms=1.0, **kw,
    )
    live.flush_image_writes()


@pytest.fixture(autouse=True)
def _reset_image_switch(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_images", False)
    monkeypatch.setattr(settings, "live_ai_images_max_mb", 512)
    live.set_images_enabled(None)
    yield
    live.flush_image_writes()
    live.set_images_enabled(None)


def test_images_are_not_stored_by_default_and_nothing_is_queued(monkeypatch):
    submitted = []
    monkeypatch.setattr(live, "_get_executor", lambda: submitted.append(1))  # would blow up if used
    _log(monkeypatch, [{"inline_data": {"mime_type": "image/png", "data": _png_b64()}}])
    assert submitted == []  # off means no background work at all
    entry = json.loads(settings.live_ai_log_path.read_text().splitlines()[0])
    assert entry["images_count"] == 1  # the count is always recorded...
    assert "images" not in entry  # ...but no image was kept
    assert not (settings.live_ai_log_path.parent / "live_ai_images").exists()


def test_with_the_switch_on_images_are_saved_and_referenced_by_content_id(monkeypatch):
    live.set_images_enabled(True)
    png, jpeg = _png_b64(), _jpeg_b64()
    _log(monkeypatch, [
        {"inline_data": {"mime_type": "image/png", "data": png}},
        {"inline_data": {"data": jpeg}},  # no declared mime: sniffed from the bytes
        {"text": "not an image"},
    ])
    entry = json.loads(settings.live_ai_log_path.read_text().splitlines()[0])
    assert entry["images_count"] == 3
    assert [i["mime"] for i in entry["images"]] == ["image/png", "image/jpeg"]
    for ref in entry["images"]:
        assert len(ref["id"]) == 32 and ref["kb"] > 0
        stored = live.find_image_file(ref["id"])
        assert stored is not None and stored.exists()
    assert live.find_image_file(entry["images"][0]["id"]).read_bytes() == base64.b64decode(png)
    # The base64 itself never goes into the JSON line.
    assert png not in settings.live_ai_log_path.read_text()


def test_the_same_image_in_two_calls_is_stored_once(monkeypatch):
    live.set_images_enabled(True)
    page = _png_b64(size=(20, 20))
    _log(monkeypatch, [{"inline_data": {"mime_type": "image/png", "data": page}}])
    _log(monkeypatch, [{"inline_data": {"mime_type": "image/png", "data": page}}])
    entries = [json.loads(line) for line in settings.live_ai_log_path.read_text().splitlines()]
    assert entries[0]["images"][0]["id"] == entries[1]["images"][0]["id"]
    assert len(list((settings.live_ai_log_path.parent / "live_ai_images").iterdir())) == 1


def test_an_undecodable_image_is_skipped_without_losing_the_entry(monkeypatch):
    live.set_images_enabled(True)
    _log(monkeypatch, [{"inline_data": {"mime_type": "image/png", "data": ""}}, {"inline_data": {"mime_type": "image/png", "data": _png_b64()}}])
    entry = json.loads(settings.live_ai_log_path.read_text().splitlines()[0])
    assert entry["images_count"] == 2 and len(entry["images"]) == 1


def test_the_configured_default_applies_until_the_runtime_switch_overrides_it(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_images", True)
    assert live.images_enabled() is True
    live.set_images_enabled(False)
    assert live.images_enabled() is False
    live.set_images_enabled(None)
    assert live.images_enabled() is True


def test_the_llm_call_does_not_wait_for_the_image_writes(monkeypatch):
    """The whole point of the background writer: a slow disk must not slow the model call."""
    import threading
    import time

    live.set_images_enabled(True)
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    gate = threading.Event()
    real_save = live._save_image

    def slow_save(data, mime):
        gate.wait(5)
        return real_save(data, mime)

    monkeypatch.setattr(live, "_save_image", slow_save)
    start = time.monotonic()
    log_ai_call(
        provider="Google", model_name="m", call_type="translate", system_prompt=None, prompt_text="p",
        parts_for_size_estimate=[{"inline_data": {"mime_type": "image/png", "data": _png_b64()}}],
        response_text="r", error=None, latency_ms=1.0,
    )
    assert time.monotonic() - start < 0.5  # returned while the write is still blocked
    assert not settings.live_ai_log_path.exists()  # entry appears only once its images are on disk
    gate.set()
    live.flush_image_writes()
    assert len(settings.live_ai_log_path.read_text().splitlines()) == 1


def test_entries_stay_in_call_order_when_image_and_plain_calls_interleave(monkeypatch):
    live.set_images_enabled(True)
    for i in range(6):
        parts = [{"inline_data": {"mime_type": "image/png", "data": _png_b64(color=(i, i, i), size=(30 + i, 30))}}] if i % 2 == 0 else []
        monkeypatch.setattr(settings, "live_ai_log_enabled", True)
        log_ai_call(provider="Google", model_name="m", call_type="translate", system_prompt=None, prompt_text=f"p{i}",
                    parts_for_size_estimate=parts, response_text="r", error=None, latency_ms=1.0)
    live.flush_image_writes()
    entries = [json.loads(line) for line in settings.live_ai_log_path.read_text().splitlines()]
    assert [e["prompt_text"] for e in entries] == [f"p{i}" for i in range(6)]
    stamps = [e["timestamp"] for e in entries]
    assert stamps == sorted(stamps)


def test_old_images_are_deleted_once_over_the_size_cap(monkeypatch):
    live.set_images_enabled(True)
    monkeypatch.setattr(live, "_PRUNE_INTERVAL_SECONDS", 0.0)
    monkeypatch.setattr(live, "_last_prune", 0.0)
    directory = settings.live_ai_log_path.parent / "live_ai_images"
    directory.mkdir(parents=True)
    import os as _os
    for n in range(5):  # five old 250 KB files = 1.25 MB, over a 1 MiB cap
        f = directory / (f"{n:032x}.png")
        f.write_bytes(b"x" * 250_000)
        _os.utime(f, (1_000_000 + n, 1_000_000 + n))
    monkeypatch.setattr(settings, "live_ai_images_max_mb", 1)  # cap: 1 MiB, target 90%
    _log(monkeypatch, [{"inline_data": {"mime_type": "image/png", "data": _png_b64(size=(400, 400))}}])
    left = sorted(p.name for p in directory.iterdir())
    total = sum(p.stat().st_size for p in directory.iterdir())
    assert total <= 0.9 * 1024 * 1024  # pruned down to 90% of the cap
    assert f"{0:032x}.png" not in left and f"{1:032x}.png" not in left  # the oldest went first
    assert f"{4:032x}.png" in left  # the newest old file survived
    assert any(name not in {f"{n:032x}.png" for n in range(5)} for name in left)  # and so did the new image


# --- endpoints -------------------------------------------------------------
def test_settings_endpoint_reports_and_changes_the_switch(monkeypatch):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    monkeypatch.setattr(settings, "live_ai_log_images", False)
    assert client.get("/admin/live-ai-log/settings").json() == {"images": False, "images_default": False, "images_max_mb": 512}
    assert client.post("/admin/live-ai-log/settings", json={"images": True}).json()["images"] is True
    assert live.images_enabled() is True
    assert client.get("/admin/live-ai-log/settings").json()["images_default"] is False  # the default itself is untouched
    assert client.post("/admin/live-ai-log/settings", json={"images": False}).json()["images"] is False


def test_settings_and_image_endpoints_404_when_the_feature_is_off():
    assert client.get("/admin/live-ai-log/settings").status_code == 404
    assert client.post("/admin/live-ai-log/settings", json={"images": True}).status_code == 404
    assert client.get("/admin/live-ai-log/images/" + "a" * 32).status_code == 404


def test_image_endpoint_serves_the_stored_bytes_with_the_right_type(monkeypatch):
    live.set_images_enabled(True)
    png, jpeg = _png_b64(), _jpeg_b64()
    _log(monkeypatch, [{"inline_data": {"data": png}}, {"inline_data": {"data": jpeg}}])
    entry = json.loads(settings.live_ai_log_path.read_text().splitlines()[0])
    for ref, data, mime in zip(entry["images"], (png, jpeg), ("image/png", "image/jpeg")):
        resp = client.get(f"/admin/live-ai-log/images/{ref['id']}")
        assert resp.status_code == 200
        assert resp.headers["content-type"] == mime
        assert resp.content == base64.b64decode(data)
    # The entry endpoint carries the references.
    listed = client.get("/admin/live-ai-log").json()["entries"][0]
    assert [i["mime"] for i in listed["images"]] == ["image/png", "image/jpeg"]


@pytest.mark.parametrize("bad_id", ["../../etc/passwd", "..%2f..%2fsecret", "A" * 32, "a" * 31, "a" * 33, "g" * 32, "a" * 32])
def test_image_endpoint_rejects_anything_that_is_not_a_known_content_id(monkeypatch, bad_id):
    monkeypatch.setattr(settings, "live_ai_log_enabled", True)
    (settings.live_ai_log_path.parent / "secret.txt").write_text("nope")
    resp = client.get(f"/admin/live-ai-log/images/{bad_id}")
    assert resp.status_code in (404, 405, 422)
    assert b"nope" not in resp.content
