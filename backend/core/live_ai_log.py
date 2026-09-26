"""Optional "Live AI" debug logger for every LLM call this backend makes —
any provider, across /translate, /translate/batch, /suggest-instructions,
and /test-key. Off by default; enable with MT_LIVE_AI_LOG_ENABLED=true
(see config.py). Hooked in exactly once, in
core/services/translation.py:_call_llm_endpoint_impl(), which every one of
those call sites funnels through regardless of provider.

Writes one JSON line per call to settings.live_ai_log_path so an operator
can `tail -f` it directly, or fetch recent entries via
GET /admin/live-ai-log (see endpoints/admin.py,
auth.py:require_live_ai_log_access). Image bytes never go into the JSON
line — it records a count + approximate KB, since base64 pages would drown
a log meant as a lightweight, human-readable prompt/response trace.

Optionally (`live_ai_log_images`, or the viewer's runtime "Save images"
switch) the images themselves are kept as files next to the log, referenced
from the entry by content hash, so the viewer can show what the model was
sent. Because that means decoding and writing megabytes per call, it is done
entirely on a background thread: the LLM call returns without waiting, and
when the switch is off none of it runs at all.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import os
import threading
import time
from concurrent.futures import ThreadPoolExecutor
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


# ── image capture ───────────────────────────────────────────────────────────

# Runtime override of settings.live_ai_log_images, set from the viewer.
# Per process: with several backend workers each has its own switch.
_images_override: Optional[bool] = None
# One writer keeps entries in the file in call order (the viewer's `since`
# polling relies on timestamps not going backwards).
_executor: Optional[ThreadPoolExecutor] = None
_executor_lock = threading.Lock()
_pending = 0
_pending_lock = threading.Lock()
# If the writer falls this far behind (a burst of big pages), stop queueing
# more image work rather than hold every page's base64 in memory.
_MAX_PENDING = 32
_IMAGE_ID_LEN = 32
_last_prune = 0.0
_PRUNE_INTERVAL_SECONDS = 30.0


def images_enabled() -> bool:
    return settings.live_ai_log_images if _images_override is None else _images_override


def set_images_enabled(value: Optional[bool]) -> None:
    """Runtime switch (None goes back to the configured default)."""
    global _images_override
    _images_override = value


def images_dir() -> Path:
    return settings.live_ai_log_path.parent / "live_ai_images"


def is_valid_image_id(image_id: str) -> bool:
    return len(image_id) == _IMAGE_ID_LEN and all(c in "0123456789abcdef" for c in image_id)


def find_image_file(image_id: str) -> Optional[Path]:
    """The stored file for a content id, or None. The id is validated to be
    lowercase hex first, so it can never escape the images directory."""
    if not is_valid_image_id(image_id):
        return None
    directory = images_dir()
    if not directory.is_dir():
        return None
    for candidate in directory.glob(f"{image_id}.*"):
        if candidate.suffix != ".tmp":
            return candidate
    return None


_SNIFF = (
    (b"\x89PNG\r\n\x1a\n", "image/png", "png"),
    (b"\xff\xd8\xff", "image/jpeg", "jpg"),
    (b"GIF8", "image/gif", "gif"),
)


_MEDIA_TYPES = {"png": "image/png", "jpg": "image/jpeg", "webp": "image/webp", "gif": "image/gif"}


def image_media_type(path: Path) -> str:
    """Content type of a stored image, from its extension (chosen by sniffing
    the bytes when it was saved)."""
    return _MEDIA_TYPES.get(path.suffix.lstrip("."), "application/octet-stream")


def _sniff(raw: bytes, declared: Optional[str]) -> tuple[str, str]:
    for magic, mime, ext in _SNIFF:
        if raw.startswith(magic):
            return mime, ext
    if raw[:4] == b"RIFF" and raw[8:12] == b"WEBP":
        return "image/webp", "webp"
    ext = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}.get(declared or "")
    return (declared or "application/octet-stream"), (ext or "bin")


def _image_payloads(parts: list[dict[str, Any]]) -> list[tuple[str, Optional[str]]]:
    """(base64 data, declared mime) for each part that carries an image."""
    out = []
    for part in parts:
        data = part.get("inline_data") if isinstance(part, dict) else None
        if isinstance(data, dict) and isinstance(data.get("data"), str):
            out.append((data["data"], data.get("mime_type")))
    return out


def _estimate_kb(parts: list[dict[str, Any]]) -> float:
    """Approximate wire size of the parts. Measures the base64 strings
    directly — the old json.dumps of the whole payload copied megabytes just
    to count them."""
    total = 0
    for part in parts:
        data = part.get("inline_data") if isinstance(part, dict) else None
        if isinstance(data, dict) and isinstance(data.get("data"), str):
            total += len(data["data"])
        else:
            total += len(json.dumps(part, default=str))
    return round(total / 1024, 1)


def _save_image(base64_data: str, declared_mime: Optional[str]) -> Optional[dict[str, Any]]:
    """Writes one image (once — same content, same file) and returns its
    reference for the entry, or None if it can't be decoded."""
    image_id = hashlib.sha256(base64_data.encode("ascii", "ignore")).hexdigest()[:_IMAGE_ID_LEN]
    try:
        raw = base64.b64decode(base64_data, validate=False)
    except (binascii.Error, ValueError):
        return None
    if not raw:
        return None
    mime, ext = _sniff(raw, declared_mime)
    existing = find_image_file(image_id)
    if existing is None:
        directory = images_dir()
        directory.mkdir(parents=True, exist_ok=True)
        target = directory / f"{image_id}.{ext}"
        tmp = directory / f"{image_id}.{ext}.tmp"
        tmp.write_bytes(raw)
        tmp.replace(target)  # never leave a half-written file for the viewer to fetch
    return {"id": image_id, "mime": mime, "kb": round(len(raw) / 1024, 1)}


def _prune_images() -> None:
    """Keeps the images directory under the size cap by deleting the oldest
    files. Throttled: called after writes, scans at most twice a minute."""
    global _last_prune
    now = time.monotonic()
    if now - _last_prune < _PRUNE_INTERVAL_SECONDS:
        return
    _last_prune = now
    directory = images_dir()
    if not directory.is_dir():
        return
    files = []
    for f in directory.iterdir():
        try:
            st = f.stat()
        except OSError:
            continue
        files.append((st.st_mtime, st.st_size, f))
    limit = max(1, settings.live_ai_images_max_mb) * 1024 * 1024
    total = sum(size for _, size, _ in files)
    if total <= limit:
        return
    for _, size, f in sorted(files):  # oldest first, down to 90% of the cap
        if total <= limit * 0.9:
            break
        try:
            f.unlink()
            total -= size
        except OSError:
            pass


def _append_entry(entry: dict[str, Any]) -> None:
    path = settings.live_ai_log_path
    path.parent.mkdir(parents=True, exist_ok=True)
    with _lock:
        _rotate_if_needed(path)
        with path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(entry, ensure_ascii=False) + "\n")


def _finish_entry(entry: dict[str, Any], payloads: list[tuple[str, Optional[str]]]) -> None:
    """Background thread: save the images, then append the entry that refers
    to them (so an entry the viewer can see always has its images on disk)."""
    global _pending
    try:
        refs = []
        for data, mime in payloads:
            try:
                ref = _save_image(data, mime)
            except OSError:
                ref = None
            if ref:
                refs.append(ref)
        entry["images"] = refs
        _append_entry(entry)
        _prune_images()
    except Exception:
        pass
    finally:
        with _pending_lock:
            _pending -= 1


def flush_image_writes(timeout: float = 10.0) -> None:
    """Blocks until everything queued so far has been written (tests, and
    shutdown-style callers)."""
    executor = _executor
    if executor is not None:
        executor.submit(lambda: None).result(timeout=timeout)


def _get_executor() -> ThreadPoolExecutor:
    global _executor
    with _executor_lock:
        if _executor is None:
            _executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="live-ai-log")
        return _executor


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
    global _pending
    if not settings.live_ai_log_enabled:
        return
    try:
        entry = {
            "timestamp": time.time(),
            "provider": provider,
            "model": model_name,
            "call_type": call_type,
            "system_prompt": system_prompt,
            "prompt_text": prompt_text,
            "images_count": len(parts_for_size_estimate),
            "images_kb": _estimate_kb(parts_for_size_estimate),
            "response_text": response_text,
            "error": error,
            "latency_ms": round(latency_ms, 1),
        }
        with _pending_lock:
            backlog = _pending
            # Anything queued ahead must be written first, or this entry
            # would land in the file out of timestamp order.
            use_worker = backlog > 0 or images_enabled()
            if use_worker and backlog < _MAX_PENDING:
                _pending += 1
            elif use_worker:
                use_worker = False  # overloaded: keep the entry, drop its images
        if use_worker:
            payloads = _image_payloads(parts_for_size_estimate) if images_enabled() else []
            _get_executor().submit(_finish_entry, entry, payloads)
        else:
            _append_entry(entry)
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
