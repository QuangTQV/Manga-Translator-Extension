"""Small SearXNG JSON API adapter for optional, user-triggered web search."""

from __future__ import annotations

import html
import ipaddress
import re
import socket
import subprocess
import time
from html.parser import HTMLParser
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


def build_story_search_query(story_title: str | None, fallback_text: str = "") -> str:
    """Build a query for looking up a story by title.

    Just the bare title, deliberately: an earlier version appended "wiki
    characters" plus a prefix of any extra context (e.g. a story-update
    description) to bias general engines toward wiki-style pages. Verified
    live, that padding does more harm than good — it broke exact/fuzzy
    title matching on both Bing and the dedicated `mangadex` SearXNG engine
    (searxng/settings.yml) for several real, if less mainstream, titles
    (MangaDex's own title search went from finding the right manga to
    zero results the moment "wiki characters" was appended), while a bare
    title still ranks wiki/database results near the top on its own once
    `_is_reference_domain` below and the mangadex engine's weight are in
    play. Any extra context beyond the title (e.g. to narrow to a specific
    chapter/arc) is left to the model's own follow-up search request
    instead (see `_run_searxng_react_round` in
    core/services/translation.py) — it can see round 1's results before
    deciding whether more specific terms would actually help, which a
    fixed Python-side heuristic can't. With no title at all there's
    nothing to anchor on, so the raw text (already length-capped by
    search_searxng) is used as-is.
    """
    title = (story_title or "").strip()
    return title or fallback_text.strip()


NO_USABLE_RESULTS = "No usable results were returned."


def search_searxng(query: str) -> str:
    """Search the configured SearXNG JSON endpoint and format bounded results.

    The instance URL is backend configuration, never supplied by the client,
    which avoids turning these helper routes into an arbitrary URL fetcher.
    `safesearch=2` (strict) is forced on every request rather than relying
    on the instance's own default — a per-instance setting an operator
    could change (or leave off) via the SearXNG web UI, and the difference
    is not cosmetic: verified live, an unfiltered query for a perfectly
    ordinary story title returned explicit adult content ranked first,
    which would otherwise flow straight into an LLM prompt and into this
    module's own debug-test output.
    """
    query = " ".join(query.split())[:500]
    if not query:
        raise WebSearchError("A non-empty search query is required.")

    base = _configured_base_url()

    try:
        response = httpx.get(
            f"{base}/search",
            params={"q": query, "format": "json", "safesearch": "2"},
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

    candidates: list[tuple[str, str, str]] = []
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
        candidates.append((url, title, content))

    # SearXNG merges/ranks across whatever general-web engines are enabled,
    # which routinely put storefront/streaming-site results ahead of the
    # wiki/character pages these callers actually want. A stable sort that
    # promotes known reference sites (without dropping anything) fixes that
    # while preserving each engine's relative ranking within its own tier.
    candidates.sort(key=lambda c: 0 if _is_reference_domain(c[0]) else 1)

    max_results = max(1, min(settings.web_search_max_results, 10))
    top = candidates[:max_results]

    # A SearXNG snippet is a 1-2 sentence blurb — rarely enough to draft
    # character/relationship notes from. Fetch the real page for the
    # top-ranked (reference sites first, see above) few results and use
    # its extracted text instead; fall back to the snippet on any failure
    # (blocked, non-HTML, timed out) rather than dropping the result.
    # `mangadex` never gets a fetch attempt at all (doesn't consume the
    # budget, unlike a fetch that's attempted and merely fails) — verified
    # live, its page is a client-rendered React SPA with ~0 bytes of real
    # text in the server-side HTML, and its own API `content_query`
    # (settings.yml) already gives the richest text available for it. The
    # budget those slots would've wasted instead reaches the next
    # candidates in rank order (typically a real Wikipedia/Fandom page).
    fetch_n = max(0, min(settings.web_search_fetch_top_n, len(top)))
    entries: list[tuple[str, str, str, bool]] = []
    for url, title, snippet in top:
        excerpt = None
        if fetch_n > 0 and not _is_spa_only_domain(url):
            excerpt = _fetch_page_excerpt(url, limit=4000)
            fetch_n -= 1
        entries.append((url, title, excerpt or snippet, excerpt is not None))

    formatted = [
        f"{i + 1}. {title}\nURL: {url}\n{'Excerpt' if is_excerpt else 'Snippet'}: {content}"
        for i, (url, title, content, is_excerpt) in enumerate(entries)
    ]

    if not formatted:
        return NO_USABLE_RESULTS + _unresponsive_engines_detail(payload)
    return "\n\n".join(formatted)


def _unresponsive_engines_detail(payload: Any) -> str:
    """Append which engines SearXNG couldn't reach, when it says why.

    Self-hosted general-web engines (duckduckgo/brave/startpage/...) are
    routinely CAPTCHA'd or rate-limited from a non-residential IP — the
    single largest cause of an empty result set that has nothing to do
    with the query itself. Surfacing SearXNG's own `unresponsive_engines`
    turns a silent "no results" into something actionable instead of
    looking like a bug in query construction.
    """
    unresponsive = (
        payload.get("unresponsive_engines") if isinstance(payload, dict) else None
    )
    if not isinstance(unresponsive, list) or not unresponsive:
        return ""
    reasons = [
        f"{_plain_text(entry[0], 60)}: {_plain_text(entry[1], 120)}"
        for entry in unresponsive
        if isinstance(entry, (list, tuple)) and len(entry) == 2
    ]
    if not reasons:
        return ""
    return f" (SearXNG engines unavailable: {'; '.join(reasons)})"


_REFERENCE_DOMAINS = (
    "wikipedia.org",
    "fandom.com",
    "wikia.org",
    "wiki.com",
    "mangadex.org",
)


def _is_reference_domain(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return any(host == d or host.endswith(f".{d}") for d in _REFERENCE_DOMAINS)


# Ranked ahead of everything else by _is_reference_domain (good — its API
# snippet is already a real synopsis), but its *website* is a
# client-rendered SPA with no server-side text to fetch — verified live
# (a 200 OK with ~5KB of loading-shell HTML, 0 characters of extractable
# text). Excluding it from the fetch step isn't just skipping a wasted
# request: since it always ranks first, leaving it in would burn the
# fetch budget's best slots on it before genuinely fetchable pages
# (Wikipedia, Fandom) ever got a turn.
_SPA_ONLY_DOMAINS = ("mangadex.org",)


def _is_spa_only_domain(url: str) -> bool:
    host = (urlsplit(url).hostname or "").lower()
    return any(host == d or host.endswith(f".{d}") for d in _SPA_ONLY_DOMAINS)


def _is_public_hostname(hostname: str) -> bool:
    """Reject a host that resolves to a private/loopback/link-local address.

    Search-result URLs come from third-party web content SearXNG indexed,
    not from the deployment operator — fetching them for a fuller excerpt
    means the backend makes an outbound request driven by that content, so
    a malicious/compromised page could try to point it at an internal
    service (localhost, a Docker-internal host, a cloud metadata endpoint)
    instead of a real page. Resolving and checking every returned address
    is a proportionate guard for a local, single-tenant tool; it isn't a
    defense against a determined DNS-rebinding attacker, which would need
    pinning the resolved IP through the actual connection.
    """
    try:
        infos = socket.getaddrinfo(hostname, None)
    except OSError:
        return False
    if not infos:
        return False
    for info in infos:
        try:
            ip = ipaddress.ip_address(info[4][0])
        except ValueError:
            return False
        if (
            ip.is_private
            or ip.is_loopback
            or ip.is_link_local
            or ip.is_multicast
            or ip.is_reserved
            or ip.is_unspecified
        ):
            return False
    return True


class _MainContentExtractor(HTMLParser):
    """Pulls visible text out of a page, skipping chrome regions.

    A flat "strip every tag" pass (fine for the short single-field
    title/snippet strings SearXNG already returns — see `_plain_text`) is
    not enough for a *whole fetched page*: wiki-style sites in particular
    put a large, unbroken navigation/sidebar/table-of-contents block
    ahead of the actual article, and a length-capped excerpt would
    otherwise be almost entirely chrome instead of the character/plot
    text these callers fetched the page for (this was verified live
    against Wikipedia — without this skip list the excerpt was 100% nav
    links, none of it article text). Wikipedia and Fandom both run
    MediaWiki, so those id/class markers cover the single biggest source
    (this module's own reference-domain priority list), with generic
    nav/header/footer/aside tags as a fallback for other sites. Tracks
    its own open-tag stack instead of relying on regex nesting, since a
    regex can't correctly bound a chrome `<div>` that contains further
    nested `<div>`s (the article content itself, in MediaWiki's layout).
    """

    _SKIP_TAGS = {
        "script", "style", "noscript", "template",
        "nav", "header", "footer", "aside", "title",
    }
    _SKIP_MARKERS = (
        "mw-panel", "mw-head", "mw-navigation", "catlinks", "printfooter",
        "navbox", "vector-header", "site-header", "site-footer", "sitenotice",
        "mw-editsection", "toc", "sidebar", "comments",
    )
    # HTML5 void elements never get a matching handle_endtag call (no close
    # tag exists to fire one) — pushing a skip-stack entry for them in
    # handle_starttag would never get popped, permanently desyncing every
    # push/pop pair for the rest of the document (the entire skip-state
    # tracking silently corrupts after the first stray <meta>/<link>/<img>,
    # which is on essentially every real page). They can't contain data of
    # their own either, so simply never touching the stack for them is
    # correct, not just a workaround.
    _VOID_TAGS = {
        "area", "base", "br", "col", "embed", "hr", "img", "input",
        "link", "meta", "param", "source", "track", "wbr",
    }

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self._skip_stack: list[bool] = []
        self._skip_depth = 0
        self.chunks: list[str] = []

    def _is_skip_element(self, tag: str, attrs: list[tuple[str, str | None]]) -> bool:
        if tag in self._SKIP_TAGS:
            return True
        attr_text = " ".join(v for k, v in attrs if k in ("id", "class") and v).lower()
        return any(marker in attr_text for marker in self._SKIP_MARKERS)

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in self._VOID_TAGS:
            return
        skip_here = self._is_skip_element(tag, attrs)
        if skip_here:
            self._skip_depth += 1
        self._skip_stack.append(skip_here)

    def handle_endtag(self, tag: str) -> None:
        if tag in self._VOID_TAGS:
            return
        if self._skip_stack and self._skip_stack.pop():
            self._skip_depth = max(0, self._skip_depth - 1)

    def handle_data(self, data: str) -> None:
        if self._skip_depth == 0:
            text = data.strip()
            if text:
                self.chunks.append(text)


_HTML_BODY_RE = re.compile(r"<body\b[^>]*>(.*)</body>", re.IGNORECASE | re.DOTALL)
_MAX_PAGE_FETCH_BYTES = 1_500_000


def _extract_page_text(html_text: str, limit: int) -> str:
    body_match = _HTML_BODY_RE.search(html_text)
    if body_match:
        html_text = body_match.group(1)
    parser = _MainContentExtractor()
    try:
        parser.feed(html_text)
        parser.close()
    except Exception:
        return _plain_text(html_text, limit)
    return " ".join(" ".join(parser.chunks).split())[:limit]


def _fetch_page_excerpt(url: str, limit: int) -> str | None:
    """Best-effort: fetch a search result's actual page and extract its text.

    Every hop (including redirects) is re-validated with
    `_is_public_hostname` before connecting — a redirect is exactly where a
    naive check-then-fetch would be bypassed, since the final destination
    could differ from the URL that was validated. Any failure (blocked,
    non-HTML, too many redirects, timeout) returns None so the caller can
    fall back to the search snippet instead of dropping the result.
    """
    timeout = settings.web_search_fetch_timeout_seconds
    for _ in range(4):  # original request + up to 3 redirects
        parsed = urlsplit(url)
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            return None
        if not _is_public_hostname(parsed.hostname):
            return None
        try:
            with httpx.stream(
                "GET",
                url,
                timeout=timeout,
                follow_redirects=False,
                headers={
                    "User-Agent": "Mozilla/5.0 (compatible; MangaTranslatorBot/1.0)",
                    "Accept": "text/html",
                },
            ) as response:
                if response.is_redirect:
                    location = response.headers.get("location")
                    if not location:
                        return None
                    url = str(httpx.URL(url).join(location))
                    continue
                if response.status_code >= 400:
                    return None
                content_type = response.headers.get("content-type", "").split(";")[0]
                if content_type and "html" not in content_type.lower():
                    return None
                chunks: list[bytes] = []
                total = 0
                for chunk in response.iter_bytes():
                    chunks.append(chunk)
                    total += len(chunk)
                    if total >= _MAX_PAGE_FETCH_BYTES:
                        break
                encoding = response.encoding or "utf-8"
        except (httpx.HTTPError, OSError):
            return None
        try:
            html_text = b"".join(chunks).decode(encoding, errors="ignore")
        except LookupError:
            html_text = b"".join(chunks).decode("utf-8", errors="ignore")
        return _extract_page_text(html_text, limit) or None
    return None
