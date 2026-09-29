"""Stable, content-derived routing keys for provider prompt caches."""

import hashlib
from typing import Optional


def stable_prompt_cache_key(provider: str, model: str, system_prompt: Optional[str]) -> Optional[str]:
    """Return a bounded opaque key for requests sharing a system prefix.

    The key contains no prompt text or user/page data. Providers still decide
    whether a request is eligible for caching and whether it gets a cache hit.
    """
    if not system_prompt:
        return None
    source = f"{provider.lower()}\0{model}\0{system_prompt}".encode("utf-8")
    return f"mt-{hashlib.sha256(source).hexdigest()[:40]}"
