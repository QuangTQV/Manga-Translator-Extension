"""Small SearXNG JSON API adapter for optional, user-triggered web search."""

from __future__ import annotations

import html
import re
import subprocess
import time
from typing import Any
from urllib.parse import urlsplit

import httpx
from config import settings


class WebSearchError(RuntimeError):
    """Raised when the configured local search service cannot return results."""


def _configured_base_url() -> str:
    base = settings.searxng_url.strip().rstrip("/")
    parsed = urlsplit(base)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username
        or parsed.password
    ):
        raise WebSearchError(
            "MT_SEARXNG_URL must be an http(s) URL without embedded credentials."
        )
    return base


def _is_bundled_local_url(base: str) -> bool:
    parsed = urlsplit(base)
    try:
        return (
            parsed.scheme == "http"
            and parsed.hostname in {"localhost", "127.0.0.1", "::1"}
            and parsed.port == 8080
            and parsed.path in {"", "/"}
        )
    except ValueError:
        return False


def _http_service_responds(base: str) -> bool:
    try:
        response = httpx.get(f"{base}/", timeout=2.0, follow_redirects=True)
        return response.status_code < 500
    except httpx.HTTPError:
        return False


def ensure_searxng_running() -> bool:
    """Ensure SearXNG can answer JSON search requests.

    Returns True if the bundled Compose service had to be started. Only the
    exact loopback URL published by backend/docker-compose.yml is auto-started;
    custom/external instances are checked but never managed by this backend.
    """
    base = _configured_base_url()
    try:
        search_searxng("SearXNG readiness check")
        return False
    except WebSearchError as initial_error:
        if _http_service_responds(base):
            raise initial_error
        if not settings.searxng_auto_start or not _is_bundled_local_url(base):
            raise WebSearchError(
                f"SearXNG is not reachable at {base}. Start it or configure MT_SEARXNG_URL."
            ) from initial_error

    compose_file = settings.backend_dir / "docker-compose.yml"
    command = [
        "docker",
        "compose",
        "-f",
        str(compose_file),
        "--profile",
        "web-search",
        "up",
        "-d",
        "searxng",
    ]
    try:
        result = subprocess.run(
            command,
            cwd=settings.backend_dir,
            capture_output=True,
            text=True,
            timeout=240,
            check=False,
        )
    except FileNotFoundError as exc:
        raise WebSearchError(
            "Docker CLI was not found. Install/start Docker Desktop or set MT_SEARXNG_AUTO_START=false and run SearXNG yourself."
        ) from exc
    except subprocess.TimeoutExpired as exc:
        raise WebSearchError(
            "Timed out starting SearXNG with Docker Compose. Check Docker Desktop and try again."
        ) from exc

    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "Docker Compose failed").strip()[
            -1200:
        ]
        raise WebSearchError(f"Could not start SearXNG with Docker Compose: {detail}")

    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        if _http_service_responds(base):
            try:
                search_searxng("SearXNG readiness check")
                return True
            except WebSearchError as exc:
                raise WebSearchError(
                    f"SearXNG started but search is not ready: {exc}"
                ) from exc
        time.sleep(1)

    raise WebSearchError(
        "Docker started the SearXNG container, but it did not become ready at http://localhost:8080 within 60 seconds."
    )


def _plain_text(value: Any, limit: int) -> str:
    text = html.unescape(re.sub(r"<[^>]*>", " ", str(value or "")))
    return " ".join(text.split())[:limit]


def search_searxng(query: str) -> str:
    """Search the configured SearXNG JSON endpoint and format bounded results.

    The instance URL is backend configuration, never supplied by the client,
    which avoids turning these helper routes into an arbitrary URL fetcher.
    """
    query = " ".join(query.split())[:500]
    if not query:
        raise WebSearchError("A non-empty search query is required.")

    base = _configured_base_url()

    try:
        response = httpx.get(
            f"{base}/search",
            params={"q": query, "format": "json"},
            headers={"Accept": "application/json"},
            timeout=settings.web_search_timeout_seconds,
            follow_redirects=False,
        )
        response.raise_for_status()
        payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise WebSearchError(f"SearXNG search failed: {exc}") from exc

    results = payload.get("results") if isinstance(payload, dict) else None
    if not isinstance(results, list):
        raise WebSearchError(
            "SearXNG returned an invalid JSON response; enable the JSON search format."
        )

    formatted: list[str] = []
    for item in results:
        if not isinstance(item, dict):
            continue
        url = _plain_text(item.get("url"), 1000)
        if urlsplit(url).scheme not in {"http", "https"}:
            continue
        title = _plain_text(item.get("title"), 300)
        content = _plain_text(item.get("content"), 1200)
        if not title and not content:
            continue
        formatted.append(
            f"{len(formatted) + 1}. {title}\nURL: {url}\nSnippet: {content}"
        )
        if len(formatted) >= max(1, min(settings.web_search_max_results, 10)):
            break

    if not formatted:
        return "No usable results were returned."
    return "\n\n".join(formatted)
