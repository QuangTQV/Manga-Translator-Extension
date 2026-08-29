"""reasoning_effort for the OpenAI-Compatible provider — was silently
dropped end-to-end, so a user setting Reasoning Effort in the popup never
actually reached the backend. Confirmed against a real endpoint
(b.ai/deepseek-v4-flash-vision-exp): without reasoning_effort, that
reasoning model can burn its entire max_tokens budget on internal
"thinking" and return completely empty content; sending
reasoning_effort="low" left enough of the budget for an actual answer.

Two layers: core/services/translation.py:_build_generation_config decides
*whether* to include it (only when the user explicitly picked a value —
never for users who left the default, since a strict/self-hosted backend
could reject an unrecognized field), and
utils/endpoints/openai_compatible.py forwards it into the actual request
payload."""
from unittest.mock import MagicMock, patch

from core.config import TranslationConfig
from core.services.translation import _build_generation_config
from utils.endpoints.openai_compatible import call_openai_compatible_endpoint


def test_reasoning_effort_included_when_explicitly_set():
    config = TranslationConfig(provider="OpenAI-Compatible", reasoning_effort="low")
    generation_config = _build_generation_config("OpenAI-Compatible", "some-model", config)
    assert generation_config["reasoning_effort"] == "low"


def test_reasoning_effort_absent_when_unset():
    config = TranslationConfig(provider="OpenAI-Compatible", reasoning_effort=None)
    generation_config = _build_generation_config("OpenAI-Compatible", "some-model", config)
    assert "reasoning_effort" not in generation_config


def test_reasoning_effort_none_is_sent_explicitly_to_actually_disable_reasoning():
    # "none" must be sent, not omitted — omitting the field leaves a
    # reasoning-by-default model (like deepseek-v4-flash-vision-exp)
    # reasoning unconditionally, which is the exact failure this exists to
    # prevent. Confirmed against the real endpoint: sending "none" produces
    # 0 reasoning tokens and a clean finish_reason "stop".
    config = TranslationConfig(provider="OpenAI-Compatible", reasoning_effort="none")
    generation_config = _build_generation_config("OpenAI-Compatible", "some-model", config)
    assert generation_config["reasoning_effort"] == "none"


def test_xhigh_is_remapped_to_high():
    # "xhigh" is this codebase's own internal value (used for Claude Opus) —
    # not something a generic OpenAI-Compatible backend is expected to
    # recognize.
    config = TranslationConfig(provider="OpenAI-Compatible", reasoning_effort="xhigh")
    generation_config = _build_generation_config("OpenAI-Compatible", "some-model", config)
    assert generation_config["reasoning_effort"] == "high"


def _mock_response(content="1: translated"):
    resp = MagicMock()
    resp.raise_for_status.return_value = None
    resp.json.return_value = {
        "choices": [{"message": {"content": content}, "finish_reason": "stop"}]
    }
    return resp


def test_payload_includes_reasoning_effort_when_present_in_generation_config():
    with patch("utils.endpoints.openai_compatible.requests.post", return_value=_mock_response()) as mock_post:
        call_openai_compatible_endpoint(
            base_url="https://api.b.ai/v1",
            api_key="k",
            model_name="deepseek-v4-flash-vision-exp",
            parts=[{"text": "hello"}],
            generation_config={"temperature": 0.1, "top_p": 0.95, "max_tokens": 4096, "reasoning_effort": "low"},
        )
    payload = mock_post.call_args.kwargs["json"]
    assert payload["reasoning_effort"] == "low"


def test_payload_omits_reasoning_effort_when_absent_from_generation_config():
    with patch("utils.endpoints.openai_compatible.requests.post", return_value=_mock_response()) as mock_post:
        call_openai_compatible_endpoint(
            base_url="https://api.b.ai/v1",
            api_key="k",
            model_name="some-model",
            parts=[{"text": "hello"}],
            generation_config={"temperature": 0.1, "top_p": 0.95, "max_tokens": 4096},
        )
    payload = mock_post.call_args.kwargs["json"]
    assert "reasoning_effort" not in payload
