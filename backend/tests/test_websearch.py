from unittest.mock import Mock

import httpx
import main
import pytest
from config import settings
from core.websearch import WebSearchError, search_searxng
from fastapi.testclient import TestClient

client = TestClient(main.app, raise_server_exceptions=False)


def test_search_calls_configured_searxng_json_api_and_formats_results(monkeypatch):
    monkeypatch.setattr(settings, "searxng_url", "http://searxng:8080/")
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
    assert request.call_args.kwargs["params"] == {"q": "My Story", "format": "json"}
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
