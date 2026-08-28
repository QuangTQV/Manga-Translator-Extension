"""Covers the Anthropic prompt-caching payload shape in
utils/endpoints/anthropic.py: the system prompt (identical across every
page of a batch/auto-translate run) must be marked as an ephemeral cache
breakpoint so repeat pages read from cache instead of paying full price."""
from unittest.mock import MagicMock, patch

from utils.endpoints.anthropic import call_anthropic_endpoint


def _ok_response(text="1: hello", usage=None):
    resp = MagicMock()
    resp.raise_for_status = lambda: None
    resp.json = lambda: {
        "content": [{"type": "text", "text": text}],
        "usage": usage or {},
    }
    return resp


def test_system_prompt_is_marked_as_a_cache_breakpoint():
    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["payload"] = json
        return _ok_response()

    with patch("requests.post", side_effect=fake_post):
        call_anthropic_endpoint(
            api_key="k", model_name="claude-sonnet-5",
            parts=[{"text": "translate this"}],
            generation_config={"max_tokens": 100},
            system_prompt="STATIC SYSTEM PROMPT",
        )

    system = captured["payload"]["system"]
    assert isinstance(system, list)
    assert system[0]["text"] == "STATIC SYSTEM PROMPT"
    assert system[0]["cache_control"] == {"type": "ephemeral"}


def test_no_system_prompt_omits_the_system_field_entirely():
    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["payload"] = json
        return _ok_response()

    with patch("requests.post", side_effect=fake_post):
        call_anthropic_endpoint(
            api_key="k", model_name="claude-sonnet-5",
            parts=[{"text": "hi"}],
            generation_config={"max_tokens": 100},
            system_prompt=None,
        )

    assert "system" not in captured["payload"]


def test_cache_usage_is_read_without_raising_when_absent():
    """usage.cache_read_input_tokens/cache_creation_input_tokens are only
    present on some responses — must not KeyError when absent."""
    with patch("requests.post", return_value=_ok_response(usage={})):
        result = call_anthropic_endpoint(
            api_key="k", model_name="claude-sonnet-5",
            parts=[{"text": "hi"}],
            generation_config={"max_tokens": 100},
            system_prompt="sys",
        )
    assert result == "1: hello"
