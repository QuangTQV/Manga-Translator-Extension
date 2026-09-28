import socket
from unittest.mock import Mock

import httpx
import main
import pytest
from config import settings
from core.websearch import (
    WebSearchError,
    _extract_page_text,
    _fetch_page_excerpt,
    _is_public_hostname,
    search_searxng,
)
from fastapi.testclient import TestClient

client = TestClient(main.app, raise_server_exceptions=False)


class _FakeStreamContext:
    """Mimics `with httpx.stream(...) as response:` for a canned response."""

    def __init__(self, response):
        self._response = response

    def __enter__(self):
        return self._response

    def __exit__(self, *exc_info):
        return False


def _fake_response(status_code=200, headers=None, body=b"", is_redirect=False):
    response = Mock()
    response.status_code = status_code
    response.headers = headers or {}
    response.is_redirect = is_redirect
    response.encoding = "utf-8"
    response.iter_bytes = Mock(return_value=iter([body] if body else []))
    return response


def test_search_calls_configured_searxng_json_api_and_formats_results(monkeypatch):
    monkeypatch.setattr(settings, "searxng_url", "http://searxng:8080/")
    # This test only cares about the SearXNG JSON parsing/formatting, not
    # the separate page-fetch enrichment (covered by its own tests below).
    monkeypatch.setattr(settings, "web_search_fetch_top_n", 0)
    response = Mock()
    response.json.return_value = {
        "results": [
            {
                "title": "<b>Official</b> page",
                "url": "https://example.org/story",
                "content": "Canon&nbsp; facts<br>and details",
            },
            {
                "title": "invalid scheme",
                "url": "file:///etc/passwd",
                "content": "ignore",
            },
        ]
    }
    response.raise_for_status.return_value = None
    request = Mock(return_value=response)
    monkeypatch.setattr(httpx, "get", request)

    result = search_searxng("  My   Story  ")

    request.assert_called_once()
    assert request.call_args.args[0] == "http://searxng:8080/search"
    assert request.call_args.kwargs["params"] == {
        "q": "My Story",
        "format": "json",
        "safesearch": "2",
    }
    assert "Official page" in result
    assert "Canon facts and details" in result
    assert "file:///" not in result


def test_search_rejects_invalid_configured_url(monkeypatch):
    monkeypatch.setattr(settings, "searxng_url", "file:///etc")
    with pytest.raises(WebSearchError, match=r"http\(s\) URL"):
        search_searxng("My Story")


def test_search_surfaces_service_errors(monkeypatch):
    monkeypatch.setattr(settings, "searxng_url", "http://localhost:8080")
    monkeypatch.setattr(httpx, "get", Mock(side_effect=httpx.ConnectError("offline")))
    with pytest.raises(WebSearchError, match="SearXNG search failed"):
        search_searxng("My Story")


def test_search_rejects_invalid_json_shape(monkeypatch):
    monkeypatch.setattr(settings, "searxng_url", "http://localhost:8080")
    response = Mock()
    response.json.return_value = {"unexpected": []}
    response.raise_for_status.return_value = None
    monkeypatch.setattr(httpx, "get", Mock(return_value=response))
    with pytest.raises(WebSearchError, match="invalid JSON response"):
        search_searxng("My Story")


def test_web_search_test_endpoint_returns_results_without_llm(monkeypatch):
    import endpoints.translate as translate_module

    monkeypatch.setattr(
        translate_module,
        "search_searxng",
        lambda query: f"1. Result for {query}\nURL: https://example.org\nSnippet: Found it",
    )
    response = client.post("/web-search/test", json={"query": "  manga  "})
    assert response.status_code == 200
    assert response.json() == {
        "query": "manga",
        "result_count": 1,
        "results": "1. Result for manga\nURL: https://example.org\nSnippet: Found it",
    }


def test_web_search_test_endpoint_surfaces_connection_errors(monkeypatch):
    import endpoints.translate as translate_module

    def fail(_query):
        raise WebSearchError("SearXNG search failed: connection refused")

    monkeypatch.setattr(translate_module, "search_searxng", fail)
    response = client.post("/web-search/test", json={"query": "manga"})
    assert response.status_code == 502
    assert "connection refused" in response.json()["detail"]


def test_is_public_hostname_rejects_private_and_loopback_addresses(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))],
    )
    assert _is_public_hostname("localhost") is False

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.5.2", 0))],
    )
    assert _is_public_hostname("internal.example") is False


def test_is_public_hostname_accepts_a_public_address(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))],
    )
    assert _is_public_hostname("example.org") is True


def test_is_public_hostname_rejects_unresolvable_hosts(monkeypatch):
    def fail(host, port):
        raise socket.gaierror("not found")

    monkeypatch.setattr(socket, "getaddrinfo", fail)
    assert _is_public_hostname("does-not-resolve.invalid") is False


def test_extract_page_text_strips_scripts_styles_and_non_body_content():
    html_doc = """
    <html><head><style>.x{color:red}</style><title>ignored</title></head>
    <body>
      <script>trackPageview();</script>
      <h1>Hina</h1>
      <p>Childhood friend of Akira.</p>
      <!-- a comment -->
    </body></html>
    """
    text = _extract_page_text(html_doc, limit=1000)
    assert "Hina" in text
    assert "Childhood friend of Akira." in text
    assert "trackPageview" not in text
    assert "color:red" not in text
    assert "ignored" not in text
    assert "a comment" not in text


def test_fetch_page_excerpt_rejects_private_host_without_making_a_request(monkeypatch):
    monkeypatch.setattr(socket, "getaddrinfo", lambda host, port: [
        (socket.AF_INET, socket.SOCK_STREAM, 6, "", ("127.0.0.1", 0))
    ])
    stream_called = Mock()
    monkeypatch.setattr(httpx, "stream", stream_called)

    assert _fetch_page_excerpt("http://internal.example/page", limit=500) is None
    stream_called.assert_not_called()


def test_fetch_page_excerpt_revalidates_each_redirect_hop(monkeypatch):
    monkeypatch.setattr(settings, "web_search_fetch_timeout_seconds", 5.0)

    # First hop resolves publicly and redirects; the redirect target
    # resolves to a private address, which must be rejected before ever
    # issuing the second request — this is the SSRF-via-redirect case.
    hosts_seen = []

    def fake_getaddrinfo(host, port):
        hosts_seen.append(host)
        ip = "127.0.0.1" if host == "internal.example" else "93.184.216.34"
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", (ip, 0))]

    monkeypatch.setattr(socket, "getaddrinfo", fake_getaddrinfo)

    redirect_response = _fake_response(
        status_code=302,
        headers={"location": "http://internal.example/secret"},
        is_redirect=True,
    )
    stream_calls = []

    def fake_stream(method, url, **kwargs):
        stream_calls.append(url)
        return _FakeStreamContext(redirect_response)

    monkeypatch.setattr(httpx, "stream", fake_stream)

    result = _fetch_page_excerpt("http://public.example/story", limit=500)

    assert result is None
    # Only the first hop was ever requested — the unsafe redirect target
    # was rejected by the host check before a second request was made.
    assert stream_calls == ["http://public.example/story"]
    assert hosts_seen == ["public.example", "internal.example"]


def test_fetch_page_excerpt_returns_extracted_text_on_success(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))],
    )
    body = b"<html><body><p>Hina is Akira's childhood friend.</p></body></html>"
    response = _fake_response(
        status_code=200, headers={"content-type": "text/html; charset=utf-8"}, body=body
    )
    monkeypatch.setattr(
        httpx, "stream", lambda method, url, **kwargs: _FakeStreamContext(response)
    )

    result = _fetch_page_excerpt("https://wiki.example/Hina", limit=500)
    assert result == "Hina is Akira's childhood friend."


def test_fetch_page_excerpt_returns_none_for_non_html_content(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))],
    )
    response = _fake_response(status_code=200, headers={"content-type": "application/pdf"})
    monkeypatch.setattr(
        httpx, "stream", lambda method, url, **kwargs: _FakeStreamContext(response)
    )
    assert _fetch_page_excerpt("https://example.org/file.pdf", limit=500) is None


def test_fetch_page_excerpt_falls_back_to_none_on_network_error(monkeypatch):
    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))],
    )

    def raise_error(method, url, **kwargs):
        raise httpx.ConnectError("offline")

    monkeypatch.setattr(httpx, "stream", raise_error)
    assert _fetch_page_excerpt("https://example.org/story", limit=500) is None


def test_search_enriches_top_result_with_a_fetched_page_excerpt(monkeypatch):
    monkeypatch.setattr(settings, "searxng_url", "http://searxng:8080")
    monkeypatch.setattr(settings, "web_search_fetch_top_n", 1)

    search_response = Mock()
    search_response.json.return_value = {
        "results": [
            {
                "title": "Hina - Wiki",
                "url": "https://wiki.example/Hina",
                "content": "short blurb",
            }
        ]
    }
    search_response.raise_for_status.return_value = None
    monkeypatch.setattr(httpx, "get", Mock(return_value=search_response))

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))],
    )
    page_body = b"<html><body><p>Hina is Akira's childhood friend, later a rival.</p></body></html>"
    page_response = _fake_response(
        status_code=200,
        headers={"content-type": "text/html"},
        body=page_body,
    )
    monkeypatch.setattr(
        httpx, "stream", lambda method, url, **kwargs: _FakeStreamContext(page_response)
    )

    result = search_searxng("Hina wiki characters")

    assert "Excerpt: Hina is Akira's childhood friend, later a rival." in result
    assert "short blurb" not in result


def test_search_skips_page_fetch_for_mangadex_and_spends_budget_on_the_next_result(
    monkeypatch,
):
    """mangadex.org always ranks first (a reference domain) but its page is
    a client-rendered SPA with nothing to fetch — the single fetch budget
    slot must reach the next (genuinely fetchable) result instead of being
    wasted on a doomed mangadex.org attempt."""
    monkeypatch.setattr(settings, "searxng_url", "http://searxng:8080")
    monkeypatch.setattr(settings, "web_search_fetch_top_n", 1)

    search_response = Mock()
    search_response.json.return_value = {
        "results": [
            {
                "title": "Some Manga",
                "url": "https://mangadex.org/title/abc123",
                "content": "MangaDex API synopsis",
            },
            {
                "title": "Some Manga Wiki",
                "url": "https://wiki.example/SomeManga",
                "content": "short wiki blurb",
            },
        ]
    }
    search_response.raise_for_status.return_value = None
    monkeypatch.setattr(httpx, "get", Mock(return_value=search_response))

    monkeypatch.setattr(
        socket,
        "getaddrinfo",
        lambda host, port: [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))],
    )

    def fake_stream(method, url, **kwargs):
        if "mangadex.org" in url:
            raise AssertionError("mangadex.org must never be fetched")
        body = b"<html><body><p>The full wiki article text.</p></body></html>"
        return _FakeStreamContext(
            _fake_response(status_code=200, headers={"content-type": "text/html"}, body=body)
        )

    monkeypatch.setattr(httpx, "stream", fake_stream)

    result = search_searxng("Some Manga")

    assert "Snippet: MangaDex API synopsis" in result
    assert "Excerpt: The full wiki article text." in result
