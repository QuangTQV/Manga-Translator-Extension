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
import os
import threading
import time
from pathlib import Path
from typing import Any, Iterator, Optional

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


_TAIL_CHUNK = 256 * 1024


def _iter_lines_newest_first(path: Path) -> Iterator[str]:
    """Yields the file's non-empty lines from the end, reading it backwards in
    chunks — so asking for the latest few entries of a log that has grown to
    the rotation cap (20 MB) doesn't read all of it, which matters when the
    viewer polls every couple of seconds. Every entry is exactly one physical
    line (json.dumps escapes newlines), and 0x0A never occurs inside a UTF-8
    multi-byte sequence, so splitting the raw bytes is safe."""
    with path.open("rb") as f:
        pos = f.seek(0, os.SEEK_END)
        carry = b""
        while pos > 0:
            step = min(_TAIL_CHUNK, pos)
            pos -= step
            f.seek(pos)
            lines = (f.read(step) + carry).split(b"\n")
            if pos > 0:
                carry, lines = lines[0], lines[1:]  # the first line may be cut off; finish it with the next chunk
            else:
                carry = b""
            for raw in reversed(lines):
                if raw.strip():
                    yield raw.decode("utf-8", errors="replace")


def read_recent_live_ai_log(limit: int = 200, since: Optional[float] = None) -> list[dict[str, Any]]:
    """Returns up to `limit` most recent log entries, newest first. Empty
    list if nothing has been logged yet (file missing); unreadable/corrupt
    lines are skipped individually rather than failing the whole read.

    `since` (a `timestamp` from a previous read) returns only entries newer
    than it, so a viewer that keeps polling transfers just what's new."""
    path = settings.live_ai_log_path
    if not path.exists():
        return []
    entries: list[dict[str, Any]] = []
    with _lock:
        try:
            for line in _iter_lines_newest_first(path):
                try:
                    entry = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if since is not None and entry.get("timestamp", 0) <= since:
                    break  # newest first: everything after this is older still
                entries.append(entry)
                if len(entries) >= limit:
                    break
        except OSError:
            return []
    return entries
