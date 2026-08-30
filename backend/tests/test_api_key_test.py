"""The popup's "Test API Key" button: pipeline/wrapper.py:build_test_key_config
(builds a minimal TranslationConfig for one provider/model/key/base_url
combo) and core/services/translation.py:test_api_key (a single, non-
rotating LLM ping — deliberately bypasses _call_llm_endpoint's key/
provider rotation so a failure is reported against exactly the key under
test, not silently retried against a different one)."""
from unittest.mock import MagicMock, patch

import pytest

from core.config import TranslationConfig
from core.services.translation import test_api_key as _test_api_key
from pipeline.wrapper import build_test_key_config


def _mock_response(content="OK"):
    resp = MagicMock()
    resp.raise_for_status.return_value = None
    resp.json.return_value = {
        "choices": [{"message": {"content": content}, "finish_reason": "stop"}]
    }
    return resp


def test_build_test_key_config_defaults_model_when_unset():
    config = build_test_key_config("Google", None, "key-A", None)
    assert config.provider == "Google"
    assert config.google_api_key == "key-A"
    assert config.model_name  # falls back to _get_default_model("Google")


def test_build_test_key_config_uses_the_callers_reasoning_effort_not_a_fixed_value():
    # Some OpenAI-Compatible-shaped backends need "none" sent explicitly to
    # avoid an unconstrained-reasoning model burning its whole token budget
    # (deepseek-v4-flash-vision-exp via b.ai); others reject "none" outright
    # with a 400 because they always think and only accept low/high/max
    # (glm-5.3-flash). Forcing one fixed value here would falsely fail a
    # valid key on whichever kind doesn't accept it — the test must use
    # exactly what the caller's row has configured, same as a real
    # translate request would send.
    config = build_test_key_config("OpenAI-Compatible", "deepseek-v4-flash-vision-exp", "key-A", "https://api.b.ai/v1", "none")
    assert config.reasoning_effort == "none"

    config2 = build_test_key_config("OpenAI-Compatible", "glm-5.3-flash", "key-A", "https://api.b.ai/v1", "high")
    assert config2.reasoning_effort == "high"

    config3 = build_test_key_config("OpenAI-Compatible", "glm-5.3-flash", "key-A", "https://api.b.ai/v1")
    assert config3.reasoning_effort is None


def test_build_test_key_config_uses_a_moderate_max_tokens():
    config = build_test_key_config("OpenAI-Compatible", "deepseek-v4-flash-vision-exp", "key-A", "https://api.b.ai/v1")
    assert config.max_tokens == 1024


def test_build_test_key_config_requires_base_url_for_openai_compatible():
    with pytest.raises(ValueError):
        build_test_key_config("OpenAI-Compatible", "some-model", "key-A", None)


def test_build_test_key_config_requires_model_for_openai_compatible():
    with pytest.raises(ValueError):
        build_test_key_config("OpenAI-Compatible", None, "key-A", "https://api.b.ai/v1")


def test_build_test_key_config_requires_azure_endpoint():
    with pytest.raises(ValueError):
        build_test_key_config("Azure OpenAI", "gpt-5-nano", "key-A", None)


def test_api_key_reports_success():
    config = TranslationConfig(provider="OpenAI-Compatible", model_name="m", openai_compatible_url="https://api.b.ai/v1", openai_compatible_api_key="k")
    with patch("utils.endpoints.openai_compatible.requests.post", return_value=_mock_response("OK")):
        ok, error = _test_api_key(config)
    assert ok is True
    assert error is None


def test_api_key_reports_empty_response_as_failure():
    config = TranslationConfig(provider="OpenAI-Compatible", model_name="m", openai_compatible_url="https://api.b.ai/v1", openai_compatible_api_key="k")
    with patch("utils.endpoints.openai_compatible.requests.post", return_value=_mock_response("")):
        ok, error = _test_api_key(config)
    assert ok is False
    assert error == "Empty response from provider"


def test_api_key_does_not_retry_on_failure():
    # max_retries=0 must actually reach the HTTP layer — a single failed
    # attempt should report failure immediately, not retry.
    resp = MagicMock()
    resp.raise_for_status.side_effect = __import__("requests").exceptions.HTTPError(response=MagicMock(status_code=401, text='{"error":"invalid key"}'))
    config = TranslationConfig(provider="OpenAI-Compatible", model_name="m", openai_compatible_url="https://api.b.ai/v1", openai_compatible_api_key="bad-key")
    with patch("utils.endpoints.openai_compatible.requests.post", return_value=resp) as mock_post:
        ok, error = _test_api_key(config)
    assert ok is False
    assert "401" in error
    assert mock_post.call_count == 1
