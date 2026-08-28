"""Every utils/endpoints/<provider>.py module implements the same 429
retry/give-up/raise pattern independently (CLAUDE.md notes provider support
is intentionally duplicated, not shared, across these files) — so a change
to one doesn't guarantee the other nine still behave the same way. This
file exercises all ten identically to catch a copy-paste slip in any one
of them.
"""
from unittest.mock import MagicMock, patch

import pytest
import requests
from requests.structures import CaseInsensitiveDict

from utils.exceptions import TranslationError
from utils.endpoints.anthropic import call_anthropic_endpoint
from utils.endpoints.azure_openai import call_azure_openai_endpoint
from utils.endpoints.deepseek import call_deepseek_endpoint
from utils.endpoints.google import call_gemini_endpoint
from utils.endpoints.moonshot import call_moonshot_endpoint
from utils.endpoints.openai import call_openai_endpoint
from utils.endpoints.openai_compatible import call_openai_compatible_endpoint
from utils.endpoints.openrouter import call_openrouter_endpoint
from utils.endpoints.xai import call_xai_endpoint
from utils.endpoints.zai import call_zai_endpoint

GEN_CONFIG = {"temperature": 0.1, "top_p": 0.95, "top_k": 40, "max_tokens": 100, "max_output_tokens": 100}
PARTS = [{"text": "hello"}]

PROVIDER_CALLS = {
    "anthropic": lambda: call_anthropic_endpoint(
        api_key="k", model_name="claude-sonnet-5", parts=PARTS,
        generation_config=GEN_CONFIG, max_retries=1, base_delay=0.001,
    ),
    "openai": lambda: call_openai_endpoint(
        api_key="k", model_name="gpt-5-mini", parts=PARTS,
        generation_config=GEN_CONFIG, max_retries=1, base_delay=0.001,
    ),
    "google": lambda: call_gemini_endpoint(
        api_key="k", model_name="gemini-3.1-flash", parts=PARTS,
        generation_config=GEN_CONFIG, max_retries=1, base_delay=0.001,
    ),
    "azure_openai": lambda: call_azure_openai_endpoint(
        endpoint="https://x.openai.azure.com", deployment="gpt-5-mini", api_key="k",
        parts=PARTS, generation_config=GEN_CONFIG, max_retries=1, base_delay=0.001,
    ),
    "xai": lambda: call_xai_endpoint(
        api_key="k", model_name="grok-4", parts=PARTS,
        generation_config=GEN_CONFIG, max_retries=1, base_delay=0.001,
    ),
    "deepseek": lambda: call_deepseek_endpoint(
        api_key="k", model_name="deepseek-chat", parts=PARTS,
        generation_config=GEN_CONFIG, max_retries=1, base_delay=0.001,
    ),
    "zai": lambda: call_zai_endpoint(
        api_key="k", model_name="glm-4.6", parts=PARTS,
        generation_config=GEN_CONFIG, max_retries=1, base_delay=0.001,
    ),
    "moonshot": lambda: call_moonshot_endpoint(
        api_key="k", model_name="kimi-k2", parts=PARTS,
        generation_config=GEN_CONFIG, max_retries=1, base_delay=0.001,
    ),
    "openrouter": lambda: call_openrouter_endpoint(
        api_key="k", model_name="openrouter/auto", parts=PARTS,
        generation_config=GEN_CONFIG, max_retries=1, base_delay=0.001,
    ),
    "openai_compatible": lambda: call_openai_compatible_endpoint(
        base_url="http://localhost:8080/v1", api_key="k", model_name="local-model",
        parts=PARTS, generation_config=GEN_CONFIG, max_retries=1, base_delay=0.001,
    ),
}


def _http_error_response(status_code: int, headers: dict, text: str = "{}"):
    resp = MagicMock()
    resp.status_code = status_code
    resp.headers = CaseInsensitiveDict(headers)
    resp.text = text

    def raise_for_status():
        raise requests.exceptions.HTTPError(response=resp)

    resp.raise_for_status = raise_for_status
    return resp


@pytest.mark.parametrize("provider", PROVIDER_CALLS.keys())
def test_exhausted_429_with_header_carries_retry_after(provider):
    response = _http_error_response(429, {"Retry-After": "63"})
    with patch("requests.post", return_value=response):
        with pytest.raises(TranslationError) as excinfo:
            PROVIDER_CALLS[provider]()
    assert excinfo.value.retry_after_seconds == 63.0


@pytest.mark.parametrize("provider", PROVIDER_CALLS.keys())
def test_exhausted_429_without_header_leaves_retry_after_none(provider):
    response = _http_error_response(429, {})
    with patch("requests.post", return_value=response):
        with pytest.raises(TranslationError) as excinfo:
            PROVIDER_CALLS[provider]()
    assert excinfo.value.retry_after_seconds is None


@pytest.mark.parametrize("provider", PROVIDER_CALLS.keys())
def test_non_429_error_never_sets_retry_after(provider):
    # A stray Retry-After header on a non-429 response (shouldn't happen in
    # practice) must never be trusted — only the 429 path should read it.
    response = _http_error_response(400, {"Retry-After": "999"}, text="bad request")
    with patch("requests.post", return_value=response):
        with pytest.raises(TranslationError) as excinfo:
            PROVIDER_CALLS[provider]()
    assert excinfo.value.retry_after_seconds is None


def test_internal_retry_before_exhaustion_still_succeeds():
    """A single transient 429 followed by a 200 must resolve normally,
    without ever surfacing a TranslationError — the per-call exponential
    backoff loop inside each endpoint module is unrelated to (and must not
    be broken by) the cross-request cooldown/rotation logic."""
    calls = []

    def flaky_then_ok(url, headers=None, json=None, timeout=None):
        calls.append(1)
        if len(calls) == 1:
            return _http_error_response(429, {"Retry-After": "1"})
        ok = MagicMock()
        ok.status_code = 200
        ok.raise_for_status = lambda: None
        ok.json = lambda: {"output_text": "1: hi there"}
        return ok

    with patch("requests.post", side_effect=flaky_then_ok):
        result = call_openai_endpoint(
            api_key="k", model_name="gpt-5-mini", parts=PARTS,
            generation_config=GEN_CONFIG, max_retries=3, base_delay=0.001,
        )

    assert result == "1: hi there"
    assert len(calls) == 2
