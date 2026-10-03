"""Which ML weights the backend is downloading right now.

Models are fetched lazily the first time a feature needs them (LaMa ~0.2 GB,
manga-ocr ~0.9 GB, PaddleOCR-VL ~1.9 GB, ...). For a user that just looks
like a page that never finishes translating, so ModelManager registers every
download here and GET /health lists the active ones — the extension polls it
while a request is slow and tells the user what is going on.

Sizes are the real on-disk/download sizes of the Hugging Face repos, looked up
once; anything not listed is reported by name only rather than guessed.
"""
import threading
import time
from contextlib import contextmanager
from typing import Dict, Iterator, List, Optional, Tuple

# repo id (or plain filename for direct URL downloads) -> (label, approx MB)
_KNOWN: Dict[str, Tuple[str, int]] = {
    "JosephCatrambone/big-lama-torchscript": ("LaMa inpainting", 206),
    "anime-manga-big-lama.pt": ("LaMa Manga inpainting", 204),
    "kha-white/manga-ocr-base": ("manga-ocr", 890),
    "PaddlePaddle/PaddleOCR-VL-1.5": ("PaddleOCR-VL", 1930),
}

_lock = threading.Lock()
_active: Dict[str, dict] = {}

# A failed download (most commonly: a repo that's gated/requires a Hugging
# Face token the user hasn't configured) used to be retried from scratch on
# every single translate request that needed the model — each attempt fails
# fast (well under a second for an auth error), but it's retried often enough
# relative to how long a normal translate request already takes that the
# extension's /health-polling toast ("first-time setup: downloading X") kept
# reappearing instead of showing once and resolving, even though the
# download was never actually going to succeed without the user fixing their
# token. Remembering a recent failure here lets the caller skip straight to
# re-raising instead of hitting the network (and registering as "active" in
# the table above) again until the cooldown passes.
_FAILURE_COOLDOWN_SECONDS = 1800  # 30 minutes
_failures: Dict[str, Tuple[float, str]] = {}


def record_download_failure(key: str, error: str) -> None:
    with _lock:
        _failures[key] = (time.monotonic(), error)


def recent_failure(key: str) -> Optional[str]:
    """The error message from a recent failed download of `key`, or None if
    there wasn't one or its cooldown has already passed."""
    with _lock:
        entry = _failures.get(key)
    if entry is None:
        return None
    started, error = entry
    if time.monotonic() - started > _FAILURE_COOLDOWN_SECONDS:
        return None
    return error


@contextmanager
def track_download(key: str) -> Iterator[None]:
    """Mark `key` (a repo id or filename) as downloading for the duration of
    the block. Re-entrant across threads: two requests triggering the same
    download show up once, until the last of them finishes."""
    name, approx_mb = _KNOWN.get(key, (key, None))
    with _lock:
        entry = _active.get(key)
        if entry is None:
            entry = _active[key] = {
                "name": name,
                "approx_mb": approx_mb,
                "started": time.monotonic(),
                "count": 0,
            }
        entry["count"] += 1
    try:
        yield
    finally:
        with _lock:
            entry["count"] -= 1
            if entry["count"] <= 0:
                _active.pop(key, None)


def active_downloads() -> List[dict]:
    """[{name, approx_mb (None if unknown), elapsed_seconds}], oldest first."""
    now = time.monotonic()
    with _lock:
        rows = sorted(_active.values(), key=lambda e: e["started"])
        return [
            {
                "name": e["name"],
                "approx_mb": e["approx_mb"],
                "elapsed_seconds": int(now - e["started"]),
            }
            for e in rows
        ]
