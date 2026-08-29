"""core/services/translation.py:_build_generation_config — a broader audit
triggered by the Gemini 3 thinking_level bug (see
test_gemini3_thinking_level.py): several other providers had the same
category of issue, where a model that can't fully disable reasoning either
silently dropped the reasoning_effort field entirely (leaving the model's
own — possibly high — default in effect) instead of respecting the user's
choice, or would have forwarded an invalid raw string. Rule applied
throughout: if a model doesn't have a true "none", use its lowest real
level instead of doing nothing.
"""
from core.config import TranslationConfig
from core.services.translation import _build_generation_config


# ---------------------------------------------------------------------------
# xAI: reasoning_effort only has low/medium/high/xhigh — no "none", no
# "minimal". Previously forwarded either raw, which xAI would reject.
# ---------------------------------------------------------------------------
def test_xai_none_maps_to_low():
    config = TranslationConfig(provider="xAI", reasoning_effort="none")
    generation_config = _build_generation_config("xAI", "grok-4-multi-agent", config)
    assert generation_config["reasoning_effort"] == "low"


def test_xai_minimal_maps_to_low():
    config = TranslationConfig(provider="xAI", reasoning_effort="minimal")
    generation_config = _build_generation_config("xAI", "grok-4-multi-agent", config)
    assert generation_config["reasoning_effort"] == "low"


def test_xai_xhigh_passes_through_unchanged():
    # xAI itself clamps xhigh->high server-side on older models — no local
    # mapping needed, unlike none/minimal which it has no server-side
    # fallback for at all.
    config = TranslationConfig(provider="xAI", reasoning_effort="xhigh")
    generation_config = _build_generation_config("xAI", "grok-4-multi-agent", config)
    assert generation_config["reasoning_effort"] == "xhigh"


# ---------------------------------------------------------------------------
# OpenAI: base "gpt-5" generation can't fully disable reasoning
# (none_capable requires gen != "5") — "none" used to be dropped entirely.
# ---------------------------------------------------------------------------
def test_openai_gpt5_base_none_maps_to_minimal():
    config = TranslationConfig(provider="OpenAI", reasoning_effort="none")
    generation_config = _build_generation_config("OpenAI", "gpt-5", config)
    assert generation_config["reasoning_effort"] == "minimal"


def test_openai_gpt51_none_capable_sends_none_unchanged():
    config = TranslationConfig(provider="OpenAI", reasoning_effort="none")
    generation_config = _build_generation_config("OpenAI", "gpt-5.1", config)
    assert generation_config["reasoning_effort"] == "none"


# ---------------------------------------------------------------------------
# Azure OpenAI: hosts the same GPT-5 family as the "OpenAI" branch, but
# previously had no per-generation check at all — "none" was always
# dropped regardless of whether the specific generation actually supports it.
# ---------------------------------------------------------------------------
def test_azure_gpt5_base_none_maps_to_minimal():
    config = TranslationConfig(provider="Azure OpenAI", reasoning_effort="none")
    generation_config = _build_generation_config("Azure OpenAI", "gpt-5", config)
    assert generation_config["reasoning_effort"] == "minimal"


def test_azure_gpt51_none_capable_sends_none_unchanged():
    config = TranslationConfig(provider="Azure OpenAI", reasoning_effort="none")
    generation_config = _build_generation_config("Azure OpenAI", "gpt-5.1", config)
    assert generation_config["reasoning_effort"] == "none"


def test_azure_xhigh_capped_to_high_on_non_capable_generation():
    config = TranslationConfig(provider="Azure OpenAI", reasoning_effort="xhigh")
    generation_config = _build_generation_config("Azure OpenAI", "gpt-5.1", config)
    assert generation_config["reasoning_effort"] == "high"


def test_azure_xhigh_passes_through_on_capable_generation():
    config = TranslationConfig(provider="Azure OpenAI", reasoning_effort="xhigh")
    generation_config = _build_generation_config("Azure OpenAI", "gpt-5.2", config)
    assert generation_config["reasoning_effort"] == "xhigh"


# ---------------------------------------------------------------------------
# OpenRouter: its own reasoning.effort field is a unified abstraction that
# accepts the full none/minimal/low/medium/high/xhigh range regardless of
# underlying model (OpenRouter translates per-model itself) — one
# sub-branch was needlessly dropping "none" instead of forwarding it.
# ---------------------------------------------------------------------------
def test_openrouter_openai_reasoning_none_is_forwarded_not_dropped():
    config = TranslationConfig(provider="OpenRouter", reasoning_effort="none")
    generation_config = _build_generation_config("OpenRouter", "openai/gpt-5.2", config)
    assert generation_config["reasoning_effort"] == "none"
