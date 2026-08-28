"""Covers pipeline/wrapper.py's request -> TranslationConfig assembly:
URL normalization, key/weight filtering, fallback-provider construction,
and _build_config's own validation/clamping of rotation settings."""
from pathlib import Path

import pytest

from pipeline.wrapper import (
    _build_config,
    _build_fallback_provider_configs,
    _filter_keys_with_weights,
    _normalize_azure_openai_endpoint,
    _normalize_openai_compatible_base_url,
)

MODELS_DIR = Path("/tmp/mt-tests-nonexistent-models")
FONTS_DIR = Path("/tmp/mt-tests-nonexistent-fonts")


# ---------------------------------------------------------------------------
# _filter_keys_with_weights
# ---------------------------------------------------------------------------
def test_blank_keys_are_dropped_without_shifting_later_weights():
    """A blank key earlier in the list must not shift a later key's weight
    onto the wrong key — weights are matched by original (pre-filter)
    index, not by position in the filtered output."""
    keys, weights = _filter_keys_with_weights(["", "b1", "b2"], [10, 0, 3])
    assert keys == ["b1", "b2"]
    assert weights == [1.0, 3.0]  # index 1's weight (0, invalid) -> default 1.0; index 2's weight (3) kept


def test_missing_or_short_weights_list_defaults_to_one():
    keys, weights = _filter_keys_with_weights(["a", "b"], None)
    assert keys == ["a", "b"]
    assert weights == [1.0, 1.0]

    keys2, weights2 = _filter_keys_with_weights(["a", "b"], [5.0])  # weights shorter than keys
    assert weights2 == [5.0, 1.0]


def test_non_positive_weight_defaults_to_one():
    keys, weights = _filter_keys_with_weights(["a", "b", "c"], [0, -1, 2.5])
    assert weights == [1.0, 1.0, 2.5]


# ---------------------------------------------------------------------------
# _build_fallback_provider_configs
# ---------------------------------------------------------------------------
def test_fallback_provider_without_keys_is_dropped():
    result = _build_fallback_provider_configs([{"provider": "Google", "api_keys": []}])
    assert result == []


def test_fallback_provider_weights_survive_normalization():
    result = _build_fallback_provider_configs([
        {"provider": "Anthropic", "model_name": "claude-sonnet-5", "api_keys": ["a1", "a2"], "api_key_weights": [1, 4]},
    ])
    assert len(result) == 1
    assert result[0].api_keys == ["a1", "a2"]
    assert result[0].api_key_weights == [1.0, 4.0]


def test_azure_fallback_without_valid_endpoint_is_dropped():
    result = _build_fallback_provider_configs([
        {"provider": "Azure OpenAI", "api_keys": ["key"], "base_url": "not a url"},
    ])
    assert result == []


def test_azure_fallback_extracts_deployment_and_api_version():
    result = _build_fallback_provider_configs([{
        "provider": "Azure OpenAI",
        "api_keys": ["key"],
        "base_url": "https://my-resource.openai.azure.com/openai/deployments/gpt-5-mini/chat/completions?api-version=2024-10-01",
    }])
    assert len(result) == 1
    assert result[0].model_name == "gpt-5-mini"
    assert result[0].azure_openai_api_version == "2024-10-01"
    assert result[0].azure_openai_endpoint == "https://my-resource.openai.azure.com"


def test_openai_compatible_fallback_without_valid_url_is_dropped():
    result = _build_fallback_provider_configs([
        {"provider": "OpenAI-Compatible", "api_keys": ["key"], "base_url": ""},
    ])
    assert result == []


# ---------------------------------------------------------------------------
# URL normalization helpers
# ---------------------------------------------------------------------------
def test_openai_compatible_url_strips_chat_completions_suffix():
    assert _normalize_openai_compatible_base_url("https://host/v1/chat/completions") == "https://host/v1"


def test_openai_compatible_url_strips_models_suffix():
    assert _normalize_openai_compatible_base_url("https://host/v1/models/") == "https://host/v1"


def test_openai_compatible_url_none_when_empty():
    assert _normalize_openai_compatible_base_url("") is None
    assert _normalize_openai_compatible_base_url(None) is None


def test_azure_endpoint_classic_surface_extracts_deployment_and_version():
    endpoint, deployment, api_version, is_v1 = _normalize_azure_openai_endpoint(
        "https://my-resource.openai.azure.com/openai/deployments/gpt-5-mini/chat/completions?api-version=2024-10-01"
    )
    assert endpoint == "https://my-resource.openai.azure.com"
    assert deployment == "gpt-5-mini"
    assert api_version == "2024-10-01"
    assert is_v1 is False


def test_azure_endpoint_v1_surface_detected():
    endpoint, deployment, api_version, is_v1 = _normalize_azure_openai_endpoint(
        "https://my-resource.services.ai.azure.com/api/projects/proj/openai/v1/responses"
    )
    assert endpoint == "https://my-resource.services.ai.azure.com/api/projects/proj/openai/v1"
    assert deployment is None
    assert api_version is None
    assert is_v1 is True


def test_azure_endpoint_invalid_url_returns_all_none():
    assert _normalize_azure_openai_endpoint("not a url") == (None, None, None, False)
    assert _normalize_azure_openai_endpoint(None) == (None, None, None, False)


# ---------------------------------------------------------------------------
# _build_config: validation/clamping of rotation-related fields
# ---------------------------------------------------------------------------
def _build_minimal_config(**overrides):
    kwargs = dict(
        input_language="Japanese", output_language="English", provider="Google",
        model_name=None, api_key="k", temperature=0.1, top_p=0.95, top_k=40,
        max_tokens=None, translation_mode="one-step", ocr_method="LLM",
        reasoning_effort=None, special_instructions=None, font_dir=None,
        max_font_size=16, min_font_size=8, supersampling_factor=4,
        send_full_page_context=True, image_detail="auto", outside_text_enabled=False,
        models_dir=MODELS_DIR, fonts_base_dir=FONTS_DIR,
    )
    kwargs.update(overrides)
    return _build_config(**kwargs)


def test_invalid_rotation_strategy_falls_back_to_round_robin():
    cfg = _build_minimal_config(rotation_strategy="not-a-real-strategy")
    assert cfg.translation.rotation_strategy == "round_robin"


@pytest.mark.parametrize("strategy", ["round_robin", "random", "sequential"])
def test_valid_rotation_strategies_pass_through(strategy):
    cfg = _build_minimal_config(rotation_strategy=strategy)
    assert cfg.translation.rotation_strategy == strategy


def test_negative_cooldown_clamps_to_zero():
    cfg = _build_minimal_config(cooldown_seconds=-5)
    assert cfg.translation.cooldown_seconds == 0.0


def test_missing_cooldown_defaults_to_fifteen():
    cfg = _build_minimal_config(cooldown_seconds=None)
    assert cfg.translation.cooldown_seconds == 15.0


def test_non_positive_api_key_weight_defaults_to_one():
    cfg = _build_minimal_config(api_key_weight=-3)
    assert cfg.translation.api_key_weight == 1.0


def test_valid_api_key_weight_passes_through():
    cfg = _build_minimal_config(api_key_weight=7.5)
    assert cfg.translation.api_key_weight == 7.5


def test_backup_keys_and_weights_filtered_and_aligned():
    cfg = _build_minimal_config(
        backup_api_keys=["", "b1", "b2"],
        backup_api_key_weights=[10, 0, 3],
    )
    assert cfg.translation.backup_api_keys == ["b1", "b2"]
    assert cfg.translation.backup_api_key_weights == [1.0, 3.0]


def test_openai_compatible_requires_base_url():
    with pytest.raises(ValueError, match="Base URL"):
        _build_minimal_config(provider="OpenAI-Compatible", base_url=None, model_name="local-model")


def test_openai_compatible_requires_model_name():
    with pytest.raises(ValueError, match="model name"):
        _build_minimal_config(provider="OpenAI-Compatible", base_url="http://localhost:8080/v1", model_name=None)


def test_azure_openai_requires_valid_endpoint():
    with pytest.raises(ValueError, match="endpoint"):
        _build_minimal_config(provider="Azure OpenAI", base_url=None, model_name="gpt-5-mini")


def test_azure_openai_deployment_can_come_from_url():
    cfg = _build_minimal_config(
        provider="Azure OpenAI",
        base_url="https://res.openai.azure.com/openai/deployments/gpt-5-mini/chat/completions?api-version=2024-10-01",
        model_name=None,
    )
    assert cfg.translation.model_name == "gpt-5-mini"
