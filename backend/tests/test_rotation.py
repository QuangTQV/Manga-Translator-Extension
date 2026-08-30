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
    _cooldowns,
    _iter_llm_candidates,
    _looks_like_a_refusal,
    _starting_offset,
    _weighted_shuffle,
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


def test_fallback_provider_with_own_reasoning_effort_overrides_primary():
    """A fallback provider with its own reasoning_effort must use it instead
    of whatever the primary/general config set."""
    config = TranslationConfig(
        provider="Google", google_api_key="key-A", model_name="m", reasoning_effort="high",
        fallback_providers=[
            FallbackProviderConfig(provider="Google", model_name="m2", api_keys=["key-B"], reasoning_effort="none"),
        ],
    )
    candidates = list(_iter_llm_candidates(config))
    by_model = {c.model_name: c.reasoning_effort for c in candidates}
    assert by_model["m"] == "high"
    assert by_model["m2"] == "none"


def test_fallback_provider_without_own_reasoning_effort_inherits_primary():
    """A fallback provider that doesn't set its own reasoning_effort must
    inherit the primary/general config's value, not run with none set."""
    config = TranslationConfig(
        provider="Google", google_api_key="key-A", model_name="m", reasoning_effort="high",
        fallback_providers=[
            FallbackProviderConfig(provider="Google", model_name="m2", api_keys=["key-B"]),
        ],
    )
    candidates = list(_iter_llm_candidates(config))
    by_model = {c.model_name: c.reasoning_effort for c in candidates}
    assert by_model["m"] == "high"
    assert by_model["m2"] == "high"


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


def test_content_filter_candidate_rotates_to_next_provider_without_cooldown():
    """A provider blocking one request under its own content policy (Azure
    OpenAI's stricter-than-default filter tripping on ordinary manga
    violence/fan-service) shouldn't fail the whole page if a different
    configured provider is willing to translate the same content — and
    unlike a rate limit, there's nothing to cool down (the same key would
    hit the same block again on retry of the same content, but is perfectly
    fine for the next page)."""
    config = TranslationConfig(
        provider="Azure OpenAI", azure_openai_api_key="az1",
        backup_api_keys=["g2"], model_name="m", rotation_strategy="sequential",
        fallback_providers=[
            FallbackProviderConfig(provider="Google", api_keys=["g2"], model_name="m"),
        ],
    )

    def impl(candidate, parts, prompt_text, debug, system_prompt):
        if candidate.provider == "Azure OpenAI":
            raise TranslationError(
                'Azure OpenAI API HTTP Error: Status 400: {"error": {"message": '
                '"The response was filtered due to the prompt triggering Azure '
                'OpenAI’s content management policy.", "code": "content_filter"}} '
                "(Check payload/deployment name/api-version)"
            )
        return "1: translated"

    with patch("core.services.translation._call_llm_endpoint_impl", side_effect=impl):
        result = _call_llm_endpoint(config, [], "prompt")

    assert result == "1: translated"
    assert _cooldown_remaining("Azure OpenAI", "az1", "m") == 0.0


def test_generic_400_error_without_content_filter_marker_is_not_rotated():
    """A plain "Status 400" from a genuine misconfiguration (bad deployment
    name, malformed payload) is not a content-filter block — it would fail
    identically on every other candidate too, so it must NOT be silently
    rotated past like one. Confirms the marker match is specific, not a
    blanket "any 400 is retryable"."""
    config = TranslationConfig(
        provider="Azure OpenAI", azure_openai_api_key="az1",
        backup_api_keys=["g2"], model_name="m", rotation_strategy="sequential",
    )
    attempts = []

    def impl(candidate, parts, prompt_text, debug, system_prompt):
        attempts.append(candidate.azure_openai_api_key)
        raise TranslationError(
            "Azure OpenAI API HTTP Error: Status 400: {\"error\": {\"message\": "
            "\"Unknown parameter\"}} (Check payload/deployment name/api-version)"
        )

    with patch("core.services.translation._call_llm_endpoint_impl", side_effect=impl):
        with pytest.raises(TranslationError, match="Unknown parameter"):
            _call_llm_endpoint(config, [], "prompt")

    # Only the primary was attempted — a genuine misconfiguration must not
    # burn through the whole rotation chain pretending a different key on
    # the same broken deployment might succeed.
    assert attempts == ["az1"]


# ---------------------------------------------------------------------------
# _looks_like_a_refusal: a "successful" (no exception) response that's
# actually the provider declining in plain text, not a content_filter error
# ---------------------------------------------------------------------------
def test_plain_refusal_sentence_is_detected():
    assert _looks_like_a_refusal("I'm sorry, but I cannot assist with that request.")


def test_refusal_detection_is_case_insensitive():
    assert _looks_like_a_refusal("I CANNOT ASSIST with that.")


def test_long_multiline_translation_is_not_a_refusal():
    # The real shape of a successful batch response — several numbered
    # lines, well past the length a flat refusal sentence would ever be.
    translation = "\n".join(f"{i}: some translated dialogue line here" for i in range(1, 14))
    assert not _looks_like_a_refusal(translation)


def test_dialogue_containing_apologetic_words_is_not_a_refusal():
    # A character's own line can legitimately contain "sorry" — must not
    # false-positive on translated *content*, only on the model talking
    # about itself refusing the request.
    assert not _looks_like_a_refusal("1: I'm so sorry for what I did to you.")


def test_empty_or_none_is_not_a_refusal():
    assert not _looks_like_a_refusal("")
    assert not _looks_like_a_refusal(None)


def test_refusal_candidate_rotates_to_next_provider_without_cooldown():
    """The exact bug scenario: Azure's safety layer replies in plain text
    ("I'm sorry, but I cannot assist with that request.") instead of
    raising a structured content_filter error — a 200 OK with unusable
    content. Previously this returned successfully from _call_llm_endpoint,
    only to fail parsing far downstream with an opaque "All bubbles
    failed" and no rotation to the configured fallback at all."""
    config = TranslationConfig(
        provider="Azure OpenAI", azure_openai_api_key="az1",
        backup_api_keys=["g2"], model_name="m", rotation_strategy="sequential",
        fallback_providers=[
            FallbackProviderConfig(provider="Google", api_keys=["g2"], model_name="m"),
        ],
    )

    def impl(candidate, parts, prompt_text, debug, system_prompt):
        if candidate.provider == "Azure OpenAI":
            return "I'm sorry, but I cannot assist with that request."
        return "1: translated"

    with patch("core.services.translation._call_llm_endpoint_impl", side_effect=impl):
        result = _call_llm_endpoint(config, [], "prompt")

    assert result == "1: translated"
    assert _cooldown_remaining("Azure OpenAI", "az1", "m") == 0.0


def test_refusal_on_last_candidate_raises_a_clear_error():
    config = TranslationConfig(
        provider="Azure OpenAI", azure_openai_api_key="az1", model_name="m",
    )

    def impl(candidate, parts, prompt_text, debug, system_prompt):
        return "I cannot assist with that."

    with patch("core.services.translation._call_llm_endpoint_impl", side_effect=impl):
        with pytest.raises(TranslationError, match="refused"):
            _call_llm_endpoint(config, [], "prompt")


# ---------------------------------------------------------------------------
# enable_web_search: try a search-capable candidate before an incapable one
# ---------------------------------------------------------------------------
def test_web_search_enabled_tries_capable_fallback_before_incapable_primary():
    # DeepSeek has no web-search implementation at all — sending a search
    # request to it silently does a normal, non-search call. With
    # enable_web_search on, a capable fallback (Google) should be tried
    # first instead, or the whole point of the toggle is defeated whenever
    # an incapable candidate happens to be configured first.
    config = TranslationConfig(
        provider="DeepSeek", deepseek_api_key="ds1", model_name="m",
        rotation_strategy="sequential", enable_web_search=True,
        fallback_providers=[
            FallbackProviderConfig(provider="Google", api_keys=["g1"], model_name="m"),
        ],
    )
    attempts = []

    def impl(candidate, parts, prompt_text, debug, system_prompt):
        attempts.append(candidate.provider)
        return "1: translated"

    with patch("core.services.translation._call_llm_endpoint_impl", side_effect=impl):
        result = _call_llm_endpoint(config, [], "prompt")

    assert result == "1: translated"
    assert attempts == ["Google"]


def test_web_search_disabled_keeps_configured_order():
    config = TranslationConfig(
        provider="DeepSeek", deepseek_api_key="ds1", model_name="m",
        rotation_strategy="sequential", enable_web_search=False,
        fallback_providers=[
            FallbackProviderConfig(provider="Google", api_keys=["g1"], model_name="m"),
        ],
    )
    attempts = []

    def impl(candidate, parts, prompt_text, debug, system_prompt):
        attempts.append(candidate.provider)
        return "1: translated"

    with patch("core.services.translation._call_llm_endpoint_impl", side_effect=impl):
        _call_llm_endpoint(config, [], "prompt")

    assert attempts == ["DeepSeek"]


def test_web_search_falls_through_to_incapable_candidate_if_capable_one_fails():
    # Reordering for search-capability must not remove the incapable
    # candidate from the chain — if the prioritized capable one is
    # rate-limited, the incapable one is still a better outcome (a
    # translation without search) than failing the whole request.
    config = TranslationConfig(
        provider="DeepSeek", deepseek_api_key="ds1", model_name="m",
        rotation_strategy="sequential", enable_web_search=True,
        fallback_providers=[
            FallbackProviderConfig(provider="Google", api_keys=["g1"], model_name="m"),
        ],
    )
    attempts = []

    def impl(candidate, parts, prompt_text, debug, system_prompt):
        attempts.append(candidate.provider)
        if candidate.provider == "Google":
            raise TranslationError("Google API HTTP Error: Rate limited after 4 attempts: ...")
        return "1: translated"

    with patch("core.services.translation._call_llm_endpoint_impl", side_effect=impl):
        result = _call_llm_endpoint(config, [], "prompt")

    assert result == "1: translated"
    assert attempts == ["Google", "DeepSeek"]


# ---------------------------------------------------------------------------
# _weighted_shuffle: "random" rotation previously only weighted the first
# pick, then walked the rest of the fallback chain in plain configured-list
# order regardless of weight — meaning several low-weight same-provider
# backup keys (which sort consecutively) failing together would all be
# walked before a much higher-weighted candidate sitting later in the list.
# _weighted_shuffle biases the whole draw order instead, so a high-weight
# candidate is tried early throughout the entire sequence, not just the
# first attempt.
# ---------------------------------------------------------------------------
def test_weighted_shuffle_is_a_permutation_of_the_input():
    items = ["a", "b", "c", "d"]
    result = _weighted_shuffle(items, [1.0, 1.0, 1.0, 1.0])
    assert sorted(result) == sorted(items)
    assert len(result) == len(items)


def test_weighted_shuffle_high_weight_item_sorts_earlier_on_average():
    items = ["low"] * 6 + ["high"]
    weights = [1.0] * 6 + [20.0]
    high_positions = []
    for _ in range(1500):
        order = _weighted_shuffle(items, weights)
        high_positions.append(order.index("high"))
    average_position = sum(high_positions) / len(high_positions)
    # With 7 items, a uniform-random position would average 3.0. A weight of
    # 20 against six weight-1 items should land it far earlier than that —
    # generous slack to keep this non-flaky.
    assert average_position < 1.0


def test_weighted_shuffle_equal_weights_is_roughly_uniform():
    items = ["a", "b", "c"]
    first_slot_counts = {"a": 0, "b": 0, "c": 0}
    for _ in range(3000):
        first_slot_counts[_weighted_shuffle(items, [1.0, 1.0, 1.0])[0]] += 1
    for count in first_slot_counts.values():
        assert 800 < count < 1200  # ~1000 expected each, generous slack


def test_random_rotation_prefers_high_weight_candidate_throughout_fallback_chain():
    # Reproduces the real scenario: 6 same-provider backup keys (weight 1,
    # all rate-limited together — e.g. one shared-quota exhaustion) plus one
    # much higher-weighted fallback provider that actually works. Under the
    # old single-weighted-starting-pick behavior, reaching the working
    # candidate meant walking through however many of the 6 failing ones
    # happened to sort before it in the fixed configured order — here,
    # confirm it's now reached quickly on average instead.
    config = TranslationConfig(
        provider="Google", google_api_key="g1",
        backup_api_keys=["g2", "g3", "g4", "g5", "g6"],
        api_key_weight=1.0,
        backup_api_key_weights=[1.0, 1.0, 1.0, 1.0, 1.0],
        model_name="m", rotation_strategy="random",
        fallback_providers=[
            FallbackProviderConfig(provider="DeepSeek", api_keys=["ds1"], model_name="m", api_key_weights=[20.0]),
        ],
    )

    def impl(candidate, parts, prompt_text, debug, system_prompt, _calls):
        _calls.append(candidate.provider)
        if candidate.provider == "DeepSeek":
            return "1: translated"
        raise TranslationError(
            "Google API HTTP Error: Rate limited after 4 attempts: ...", retry_after_seconds=0.001
        )

    attempts_before_success = []
    for _ in range(300):
        _cooldowns.clear()  # each iteration is an independent trial
        calls = []
        with patch(
            "core.services.translation._call_llm_endpoint_impl",
            side_effect=lambda *a, _calls=calls, **kw: impl(*a, _calls=_calls, **kw),
        ):
            _call_llm_endpoint(config, [], "prompt")
        attempts_before_success.append(len(calls))

    average_attempts = sum(attempts_before_success) / len(attempts_before_success)
    # 6 failing Google keys + 1 working DeepSeek candidate: uniform-random
    # ordering would average ~3.5 attempts before reaching it. Weighted 20
    # against six weight-1 keys should reach it far sooner on average.
    assert average_attempts < 2.0
