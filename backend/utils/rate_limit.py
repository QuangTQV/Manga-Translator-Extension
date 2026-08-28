"""Shared helper for reading a provider's `Retry-After` response header."""
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
from typing import Optional

import requests


def extract_retry_after_seconds(response: "requests.Response") -> Optional[float]:
    """Parses the standard `Retry-After` header (RFC 7231) off a 429
    response, as either a delta-seconds value (what every LLM provider
    actually sends) or an HTTP-date. Returns None if the header is absent
    or unparseable, so callers can fall back to their own default cooldown.
    """
    header = response.headers.get("Retry-After")
    if not header:
        return None
    header = header.strip()
    try:
        return max(0.0, float(header))
    except ValueError:
        pass
    try:
        target = parsedate_to_datetime(header)
        if target.tzinfo is None:
            target = target.replace(tzinfo=timezone.utc)
        return max(0.0, (target - datetime.now(timezone.utc)).total_seconds())
    except (TypeError, ValueError):
        return None
