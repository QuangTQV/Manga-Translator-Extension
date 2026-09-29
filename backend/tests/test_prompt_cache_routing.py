from unittest.mock import MagicMock, patch

from utils.prompt_cache import stable_prompt_cache_key


def _response(body):
    response = MagicMock()
    response.raise_for_status = lambda: None
    response.json = lambda: body
    return response


def test_prompt_cache_key_is_stable_opaque_and_varies_with_prefix():
    key = stable_prompt_cache_key("OpenAI", "model-a", "stable system")
    assert key == stable_prompt_cache_key("openai", "model-a", "stable system")
    assert key != stable_prompt_cache_key("openai", "model-a", "other system")
    assert key != stable_prompt_cache_key("openai", "model-b", "stable system")
    assert len(key) <= 64
    assert "stable system" not in key
    assert stable_prompt_cache_key("openai", "model-a", None) is None


def test_openai_responses_uses_stable_cache_routing_key():
    from utils.endpoints.openai import call_openai_endpoint

    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured.update(url=url, payload=json)
        return _response({"output_text": "ok", "usage": {}})

    with patch("requests.post", side_effect=fake_post):
        call_openai_endpoint(
            api_key="k", model_name="gpt-5-mini", parts=[{"text": "page one"}],
            generation_config={}, system_prompt="stable system",
        )

    assert captured["payload"]["prompt_cache_key"] == stable_prompt_cache_key(
        "openai", "gpt-5-mini", "stable system"
    )


def test_openai_compatible_responses_surface_does_not_get_openai_only_cache_field():
    from utils.endpoints.openai import call_openai_endpoint

    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured.update(url=url, payload=json)
        return _response({"output_text": "ok", "usage": {}})

    with patch("requests.post", side_effect=fake_post):
        call_openai_endpoint(
            api_key="k", model_name="deployment", base_url="https://resource.example/v1",
            parts=[{"text": "page one"}], generation_config={},
            system_prompt="stable system",
        )

    assert "prompt_cache_key" not in captured["payload"]


def test_explicitly_supported_azure_responses_surface_gets_cache_routing_key():
    from utils.endpoints.openai import call_openai_endpoint

    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["payload"] = json
        return _response({"output_text": "ok", "usage": {}})

    with patch("requests.post", side_effect=fake_post):
        call_openai_endpoint(
            api_key="k", model_name="deployment",
            base_url="https://resource.services.ai.azure.com/api/projects/p/openai/v1",
            enable_prompt_cache_key=True,
            parts=[{"text": "page one"}], generation_config={},
            system_prompt="stable system",
        )

    assert captured["payload"]["prompt_cache_key"] == stable_prompt_cache_key(
        "openai", "deployment", "stable system"
    )


def test_xai_uses_stable_cache_routing_key():
    from utils.endpoints.xai import call_xai_endpoint

    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["payload"] = json
        return _response({"output": [{"content": "ok"}], "usage": {}})

    with patch("requests.post", side_effect=fake_post):
        call_xai_endpoint(
            api_key="k", model_name="grok-4", parts=[{"text": "page one"}],
            generation_config={}, system_prompt="stable system",
        )

    assert captured["payload"]["prompt_cache_key"] == stable_prompt_cache_key(
        "xai", "grok-4", "stable system"
    )


def test_openrouter_uses_sticky_session_for_reusable_system_prefix():
    from utils.endpoints.openrouter import call_openrouter_endpoint

    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["payload"] = json
        return _response({"choices": [{"message": {"content": "ok"}}], "usage": {}})

    with patch("requests.post", side_effect=fake_post):
        call_openrouter_endpoint(
            api_key="k", model_name="openai/gpt-5-mini", parts=[{"text": "page one"}],
            generation_config={"_metadata": {"is_openai_model": True}},
            system_prompt="stable system",
        )

    assert captured["payload"]["session_id"] == stable_prompt_cache_key(
        "openrouter", "openai/gpt-5-mini", "stable system"
    )


def test_openrouter_anthropic_model_marks_system_prompt_cache_breakpoint():
    from utils.endpoints.openrouter import call_openrouter_endpoint

    captured = {}

    def fake_post(url, headers=None, json=None, timeout=None):
        captured["payload"] = json
        return _response({"choices": [{"message": {"content": "ok"}}], "usage": {}})

    with patch("requests.post", side_effect=fake_post):
        call_openrouter_endpoint(
            api_key="k", model_name="anthropic/claude-sonnet-4",
            parts=[{"text": "page one"}],
            generation_config={"_metadata": {"is_anthropic_model": True}},
            system_prompt="stable system",
        )

    system_content = captured["payload"]["messages"][0]["content"]
    assert system_content == [{
        "type": "text", "text": "stable system",
        "cache_control": {"type": "ephemeral"},
    }]
