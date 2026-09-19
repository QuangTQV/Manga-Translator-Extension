"""Optional "Live AI" debug logger for every LLM call this backend makes —
any provider, across /translate, /translate/batch, /suggest-instructions,
and /test-key. Off by default; enable with MT_LIVE_AI_LOG_ENABLED=true
(see config.py). Hooked in exactly once, in
core/services/translation.py:_call_llm_endpoint_impl(), which every one of
those call sites funnels through regardless of provider.

Writes one JSON line per call to settings.live_ai_log_path so an operator
can `tail -f` it directly, or fetch recent entries via
GET /admin/live-ai-log (see endpoints/admin.py,
auth.py:require_live_ai_log_access). Deliberately excludes image bytes —
records a count + approximate KB instead of raw base64, since manga page
images are large and unreadable in a log; this is meant as a lightweight,
human-readable prompt/response trace, not a full request replay dump.
"""
from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any, Optional

from config import settings

_lock = threading.Lock()

# Roughly caps the log file's size: once it would exceed this, the current
# file is rotated to a single ".1" backup instead of growing forever on a
# long-running server. Not a full logrotate-style scheme (no multi-
# generation history) — just enough to bound disk usage for a debug
# feature that's off by default anyway.
_MAX_BYTES = 20 * 1024 * 1024


def _rotate_if_needed(path: Path) -> None:
    try:
        if path.exists() and path.stat().st_size > _MAX_BYTES:
            path.replace(path.with_suffix(path.suffix + ".1"))
    except OSError:
        pass  # best-effort — a logging hiccup should never break a real request


def log_ai_call(
    *,
    provider: str,
    model_name: Optional[str],
    call_type: str,
    system_prompt: Optional[str],
    prompt_text: str,
    parts_for_size_estimate: list[dict[str, Any]],
    response_text: Optional[str],
    error: Optional[str],
    latency_ms: float,
) -> None:
    """Checks the enabled flag first so this costs nothing on the hot path
    for everyone who hasn't opted in. Every exception here is swallowed —
    a broken log write must never be the reason a real translate request
    fails."""
    if not settings.live_ai_log_enabled:
        return
    try:
        images_count = len(parts_for_size_estimate)
        images_bytes = len(json.dumps(parts_for_size_estimate, default=str).encode("utf-8"))
        entry = {
            "timestamp": time.time(),
            "provider": provider,
            "model": model_name,
            "call_type": call_type,
            "system_prompt": system_prompt,
            "prompt_text": prompt_text,
            "images_count": images_count,
            "images_kb": round(images_bytes / 1024, 1),
            "response_text": response_text,
            "error": error,
            "latency_ms": round(latency_ms, 1),
        }
        path = settings.live_ai_log_path
        path.parent.mkdir(parents=True, exist_ok=True)
        with _lock:
            _rotate_if_needed(path)
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(entry, ensure_ascii=False) + "\n")
    except Exception:
        pass


def read_recent_live_ai_log(limit: int = 200) -> list[dict[str, Any]]:
    """Returns up to `limit` most recent log entries, newest first. Empty
    list if nothing has been logged yet (file missing); unreadable/corrupt
    lines are skipped individually rather than failing the whole read."""
    path = settings.live_ai_log_path
    if not path.exists():
        return []
    with _lock:
        try:
            lines = path.read_text(encoding="utf-8").splitlines()
        except OSError:
            return []
    entries = []
    for line in lines[-limit:]:
        try:
            entries.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    entries.reverse()
    return entries
