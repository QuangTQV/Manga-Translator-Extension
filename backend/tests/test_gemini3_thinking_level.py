"""core/services/translation.py:_build_generation_config — Gemini 3's
thinkingLevel enum only accepts minimal/low/medium/high. This app's
Reasoning Effort dropdown also offers "none" and "xhigh", which aren't
valid Gemini 3 values and were previously forwarded as-is, producing a
real 400 from Google confirmed against production: "Invalid value at
'generation_config.thinking_config.thinking_level' ... 'none'".
"""
from core.config import TranslationConfig
from core.services.translation import _build_generation_config


def test_none_is_mapped_to_minimal_for_gemini_3():
    config = TranslationConfig(provider="Google", reasoning_effort="none")
    generation_config = _build_generation_config("Google", "gemini-3.6-flash", config)
    assert generation_config["thinkingConfig"]["thinkingLevel"] == "minimal"


def test_xhigh_is_mapped_to_high_for_gemini_3():
    config = TranslationConfig(provider="Google", reasoning_effort="xhigh")
    generation_config = _build_generation_config("Google", "gemini-3.6-flash", config)
    assert generation_config["thinkingConfig"]["thinkingLevel"] == "high"


def test_valid_levels_pass_through_unchanged_for_gemini_3():
    for level in ("minimal", "low", "medium", "high"):
        config = TranslationConfig(provider="Google", reasoning_effort=level)
        generation_config = _build_generation_config("Google", "gemini-3.6-flash", config)
        assert generation_config["thinkingConfig"]["thinkingLevel"] == level


def test_unset_defaults_to_high_for_gemini_3():
    config = TranslationConfig(provider="Google", reasoning_effort=None)
    generation_config = _build_generation_config("Google", "gemini-3.6-flash", config)
    assert generation_config["thinkingConfig"]["thinkingLevel"] == "high"


def test_none_is_mapped_to_minimal_for_gemma_too():
    # Gemma models share the same thinkingLevel code path as Gemini 3.
    config = TranslationConfig(provider="Google", reasoning_effort="none")
    generation_config = _build_generation_config("Google", "gemma-4-31b-it", config)
    assert generation_config["thinkingConfig"]["thinkingLevel"] == "minimal"
