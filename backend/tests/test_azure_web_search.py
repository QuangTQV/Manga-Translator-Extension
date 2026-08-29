"""utils/endpoints/azure_openai.py: enable_web_search adds a
`web_search_options` entry to the Chat Completions payload — Azure's
documented equivalent of OpenAI's own Chat Completions web search
parameter (Microsoft's Agent Framework docs state the two Chat Completion
tool surfaces are identical). Requires the deployment itself to be a
search-capable model; this only covers that the payload shape is correct,
not live Azure behavior."""
from unittest.mock import MagicMock, patch

from utils.endpoints.azure_openai import call_azure_openai_endpoint


def _mock_response(text="1: translated"):
    resp = MagicMock()
    resp.raise_for_status.return_value = None
    resp.json.return_value = {
        "choices": [{"message": {"content": text}, "finish_reason": "stop"}]
    }
    return resp


def test_web_search_options_added_when_enabled():
    with patch("utils.endpoints.azure_openai.requests.post", return_value=_mock_response()) as mock_post:
        call_azure_openai_endpoint(
            endpoint="https://my-resource.openai.azure.com",
            deployment="gpt-4o-search-preview",
            api_key="k",
            parts=[{"text": "hello"}],
            generation_config={"temperature": 0.1, "top_p": 0.95, "max_tokens": 100},
            enable_web_search=True,
        )
    payload = mock_post.call_args.kwargs["json"]
    assert "web_search_options" in payload


def test_web_search_options_absent_when_disabled():
    with patch("utils.endpoints.azure_openai.requests.post", return_value=_mock_response()) as mock_post:
        call_azure_openai_endpoint(
            endpoint="https://my-resource.openai.azure.com",
            deployment="gpt-4o-mini",
            api_key="k",
            parts=[{"text": "hello"}],
            generation_config={"temperature": 0.1, "top_p": 0.95, "max_tokens": 100},
            enable_web_search=False,
        )
    payload = mock_post.call_args.kwargs["json"]
    assert "web_search_options" not in payload


def test_web_search_options_absent_by_default():
    # enable_web_search defaults to False — every existing caller that
    # doesn't know about this parameter must see unchanged behavior.
    with patch("utils.endpoints.azure_openai.requests.post", return_value=_mock_response()) as mock_post:
        call_azure_openai_endpoint(
            endpoint="https://my-resource.openai.azure.com",
            deployment="gpt-4o-mini",
            api_key="k",
            parts=[{"text": "hello"}],
            generation_config={"temperature": 0.1, "top_p": 0.95, "max_tokens": 100},
        )
    payload = mock_post.call_args.kwargs["json"]
    assert "web_search_options" not in payload
