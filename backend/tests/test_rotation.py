"""Covers the key/provider rotation core in core/services/translation.py:
candidate enumeration + dedup, weighted "random" starting-offset selection,
and the full _call_llm_endpoint flow (cooldown skip, Retry-After-driven
cooldown, credit-error cooldown, rotation-on-failure).
"""
from dataclasses import replace
from unittest.mock import patch

import pytest

from core.config import FallbackProviderConfig, TranslationConfig
from core.services.translation import (
    _call_llm_endpoint,
    _cooldown_remaining,
    _iter_llm_candidates,
    _starting_offset,
)
from utils.exceptions import TranslationError


# ---------------------------------------------------------------------------
# _iter_llm_candidates: dedup + weight defaults
# ---------------------------------------------------------------------------
def test_primary_only_yields_one_candidate_with_default_weight():
    config = TranslationConfig(provider="Google", google_api_key="key-A", model_name="gemini-3.1-flash")
    candidates = list(_iter_llm_candidates(config))
    assert len(candidates) == 1
    assert candidates[0].google_api_key == "key-A"
    assert candidates[0].candidate_weight == 1.0


def test_backup_keys_are_yielded_with_their_own_weights():
    config = TranslationConfig(
        provider="Google", google_api_key="key-A", api_key_weight=1.0,
        backup_api_keys=["key-B", "key-C"], backup_api_key_weights=[5.0, 0.0],
        model_name="gemini-3.1-flash",
    )
    candidates = list(_iter_llm_candidates(config))
    weights_by_key = {c.google_api_key: c.candidate_weight for c in candidates}
    assert weights_by_key["key-A"] == 1.0
    assert weights_by_key["key-B"] == 5.0
    # A non-positive configured weight (0.0) is invalid and falls back to
    # the neutral default (1.0) rather than making the key unpickable.
    assert weights_by_key["key-C"] == 1.0


def test_same_key_same_model_across_backup_and_fallback_is_deduped():
    """A (provider, key, model) triple must only ever be tried once — the
    same account/model combination configured twice (accidentally, e.g. as
    both a backup key and inside a fallback provider) should not burn two
    requests against the same rate-limited quota."""
    config = TranslationConfig(
        provider="Google", google_api_key="key-A", model_name="gemini-3.1-flash",
        backup_api_keys=["key-A"],  # exact duplicate of the primary
        fallback_providers=[
            FallbackProviderConfig(provider="Google", model_name="gemini-3.1-flash", api_keys=["key-A"]),
        ],
    )
    candidates = list(_iter_llm_candidates(config))
    assert len(candidates) == 1


def test_same_key_different_model_is_not_deduped():
    """The same key against a *different* model IS a legitimate, distinct
    candidate — many providers (Gemini's free tier especially) meter rate
    limits per model, not per account."""
    config = TranslationConfig(
        provider="Google", google_api_key="key-A", model_name="gemini-3.1-flash",
        fallback_providers=[
            FallbackProviderConfig(provider="Google", model_name="gemini-3.1-pro", api_keys=["key-A"]),
        ],
    )
    candidates = list(_iter_llm_candidates(config))
    assert len(candidates) == 2
    assert {c.model_name for c in candidates} == {"gemini-3.1-flash", "gemini-3.1-pro"}


def test_fallback_provider_missing_key_field_is_skipped():
    """A fallback provider whose name doesn't map to a known API-key field
    (e.g. a typo, or a provider that requires config this test doesn't
    set up) must be skipped, not raise."""
    config = TranslationConfig(provider="Google", google_api_key="key-A", model_name="m")
    config = replace(config, fallback_providers=[
        FallbackProviderConfig(provider="NotARealProvider", api_keys=["x"]),
    ])
    candidates = list(_iter_llm_candidates(config))
    assert len(candidates) == 1


# ---------------------------------------------------------------------------
# _starting_offset
# ---------------------------------------------------------------------------
def test_sequential_always_starts_at_zero():
    assert _starting_offset("sequential", (), 5) == 0


def test_round_robin_advances_across_calls():
    signature = (("Google", "key-A", "m"), ("Google", "key-B", "m"))
    offsets = [_starting_offset("round_robin", signature, 2) for _ in range(4)]
    assert offsets == [0, 1, 0, 1]


def test_weighted_random_skews_toward_higher_weight_candidate():
    weights = [1.0, 9.0]
    counts = [0, 0]
    for _ in range(4000):
        counts[_starting_offset("random", (), 2, weights)] += 1
    # Expected ~10%/90% split; allow generous slack to keep this non-flaky.
    assert counts[1] / sum(counts) > 0.75


def test_random_without_weights_falls_back_to_uniform():
    counts = [0, 0]
    for _ in range(4000):
        counts[_starting_offset("random", (), 2, None)] += 1
    ratio = counts[0] / sum(counts)
    assert 0.4 < ratio < 0.6


# ---------------------------------------------------------------------------
# _call_llm_endpoint: cooldown skip, Retry-After, credit errors, rotation
# ---------------------------------------------------------------------------
def test_all_candidates_cooling_down_raises_clear_error():
    config = TranslationConfig(provider="Google", google_api_key="key-A", model_name="m", rotation_strategy="sequential")

    def always_rate_limited(candidate, parts, prompt_text, debug, system_prompt):
        raise TranslationError("Google API HTTP Error: Rate limited after 4 attempts: ...", retry_after_seconds=30.0)

    with patch("core.services.translation._call_llm_endpoint_impl", side_effect=always_rate_limited):
        with pytest.raises(TranslationError):
            _call_llm_endpoint(config, [], "prompt")

        # Second call: the only candidate is now cooling down -> distinct,
        # clearer error path (no candidates left to even attempt).
        with pytest.raises(TranslationError, match="cooling down"):
            _call_llm_endpoint(config, [], "prompt")


def test_retry_after_header_drives_cooldown_duration_over_config_default():
    config = TranslationConfig(
        provider="Google", google_api_key="key-A", backup_api_keys=["key-B"],
        model_name="m", rotation_strategy="sequential", cooldown_seconds=15.0,
    )

    def impl(candidate, parts, prompt_text, debug, system_prompt):
        if candidate.google_api_key == "key-A":
            raise TranslationError("Google API HTTP Error: Rate limited after 4 attempts: ...", retry_after_seconds=200.0)
        return "1: ok"

    with patch("core.services.translation._call_llm_endpoint_impl", side_effect=impl):
        result = _call_llm_endpoint(config, [], "prompt")

    assert result == "1: ok"
    remaining = _cooldown_remaining("Google", "key-A", "m")
    # Should reflect the 200s Retry-After, not the 15s config default.
    assert 195 <= remaining <= 200


def test_retry_after_is_clamped_to_ceiling():
    config = TranslationConfig(provider="OpenAI", openai_api_key="key-C", model_name="m", rotation_strategy="sequential")

    def impl(candidate, parts, prompt_text, debug, system_prompt):
        raise TranslationError("OpenAI API HTTP Error: Rate limited after 4 attempts: ...", retry_after_seconds=999_999.0)

    with patch("core.services.translation._call_llm_endpoint_impl", side_effect=impl):
        with pytest.raises(TranslationError):
            _call_llm_endpoint(config, [], "prompt")

    remaining = _cooldown_remaining("OpenAI", "key-C", "m")
    assert 895 <= remaining <= 900  # clamped to the 900s ceiling, not ~11.5 days


def test_credit_error_uses_fixed_cooldown_regardless_of_retry_after():
    config = TranslationConfig(provider="DeepSeek", deepseek_api_key="dk", model_name="m", rotation_strategy="sequential")

    def impl(candidate, parts, prompt_text, debug, system_prompt):
        # A 402 with a (hypothetical) short Retry-After must still get the
        # long, fixed credit-exhaustion cooldown — retrying a dead account
        # in 5s just wastes another request.
        raise TranslationError("DeepSeek API HTTP Error: Status 402: Insufficient Balance", retry_after_seconds=5.0)

    with patch("core.services.translation._call_llm_endpoint_impl", side_effect=impl):
        with pytest.raises(TranslationError):
            _call_llm_endpoint(config, [], "prompt")

    remaining = _cooldown_remaining("DeepSeek", "dk", "m")
    assert 895 <= remaining <= 900


def test_rotates_past_rate_limited_primary_to_backup_and_skips_it_next_time():
    config = TranslationConfig(
        provider="Google", google_api_key="g1", backup_api_keys=["g2"],
        model_name="m", rotation_strategy="sequential",
    )
    attempts = []

    def impl(candidate, parts, prompt_text, debug, system_prompt):
        attempts.append(candidate.google_api_key)
        if candidate.google_api_key == "g1":
            raise TranslationError("Google API HTTP Error: Rate limited after 4 attempts: ...", retry_after_seconds=5.0)
        return "1: translated"

    with patch("core.services.translation._call_llm_endpoint_impl", side_effect=impl):
        result = _call_llm_endpoint(config, [], "prompt")
        assert result == "1: translated"
        assert attempts == ["g1", "g2"]

        attempts.clear()
        result2 = _call_llm_endpoint(config, [], "prompt")
        # g1 is still cooling down (5s) -> should never be attempted again.
        assert attempts == ["g2"]
        assert result2 == "1: translated"


def test_missing_key_candidate_is_skipped_without_marking_cooldown():
    """An empty/unconfigured key isn't a rate limit — nothing to cool down,
    and it should never block rotation to the next real candidate."""
    config = TranslationConfig(
        provider="Google", google_api_key="", backup_api_keys=["g2"],
        model_name="m", rotation_strategy="sequential",
    )

    def impl(candidate, parts, prompt_text, debug, system_prompt):
        if not candidate.google_api_key:
            raise TranslationError("Google API key is missing.")
        return "1: translated"

    with patch("core.services.translation._call_llm_endpoint_impl", side_effect=impl):
        result = _call_llm_endpoint(config, [], "prompt")

    assert result == "1: translated"
    assert _cooldown_remaining("Google", "", "m") == 0.0
