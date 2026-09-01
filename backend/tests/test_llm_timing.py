"""Covers collect_llm_seconds / _record_llm_seconds in
core/services/translation.py — the per-request accumulator the /translate
endpoint uses to report how much of its wall time was spent inside the LLM
(separately from the detection/cleaning/rendering pipeline).
"""
import time
from unittest.mock import patch

import pytest

from core.config import FallbackProviderConfig, TranslationConfig
from core.services.translation import (
    _call_llm_endpoint,
    _record_llm_seconds,
    collect_llm_seconds,
)
from utils.exceptions import TranslationError


def test_record_is_a_noop_when_nobody_is_collecting():
    # Must not raise when there's no open collect_llm_seconds() context.
    _record_llm_seconds(1.23)


def test_collect_accumulates_and_resets():
    with collect_llm_seconds() as sink:
        _record_llm_seconds(0.5)
        _record_llm_seconds(1.5)
        assert sink == [0.5, 1.5]
    # Outside the context the sink is detached again.
    _record_llm_seconds(9.9)
    assert sink == [0.5, 1.5]


def test_nested_contexts_are_isolated():
    with collect_llm_seconds() as outer:
        _record_llm_seconds(1.0)
        with collect_llm_seconds() as inner:
            _record_llm_seconds(2.0)
        assert inner == [2.0]
        _record_llm_seconds(3.0)
    assert outer == [1.0, 3.0]


def test_call_llm_endpoint_records_one_sample_per_attempt_including_rotation():
    config = TranslationConfig(
        provider="Google", google_api_key="g1", backup_api_keys=["g2"],
        model_name="m", rotation_strategy="sequential",
    )

    def impl(candidate, parts, prompt_text, debug, system_prompt):
        time.sleep(0.01)
        if candidate.google_api_key == "g1":
            raise TranslationError("Rate limited after 4 attempts", retry_after_seconds=5.0)
        return "1: translated"

    with collect_llm_seconds() as sink:
        with patch("core.services.translation._call_llm_endpoint_impl", side_effect=impl):
            result = _call_llm_endpoint(config, [], "prompt")

    assert result == "1: translated"
    # One failed attempt + one successful attempt = two recorded samples.
    assert len(sink) == 2
    assert all(s > 0 for s in sink)
