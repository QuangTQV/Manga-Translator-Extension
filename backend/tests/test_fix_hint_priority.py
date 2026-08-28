"""endpoints/translate.py: _pipeline_slot() reserves a slice of the total
ML pipeline concurrency (_pipeline_semaphore) exclusively for fix_hint
requests ("re-translate this bubble/page with a correction") via a second,
smaller gate (_regular_pipeline_gate) that only non-fix requests must also
pass through. Without this, a fix — a single action the UI is synchronously
spinner-blocked on — would queue FIFO behind whatever auto-translate/batch
backlog happened to already be running, with no priority at all."""
import asyncio
import time

import pytest

import endpoints.translate as translate_endpoints
from schemas import FixHintConfig, TranslateRequest


def _make_request(with_fix: bool) -> TranslateRequest:
    return TranslateRequest(
        input_language="Auto",
        output_language="English",
        provider="Google",
        image="",
        fix_hint=FixHintConfig(instruction="make it more formal") if with_fix else None,
    )


def _patch_pipeline(monkeypatch, delay_seconds: float):
    def fake_translate_image_base64(image, config, previous_context_texts):
        time.sleep(delay_seconds)
        return ("fake-image", [], delay_seconds, [], None)

    monkeypatch.setattr(translate_endpoints, "_build_config", lambda **kwargs: object())
    monkeypatch.setattr(translate_endpoints, "translate_image_base64", fake_translate_image_base64)
    monkeypatch.setattr(translate_endpoints, "image_to_base64_raw", lambda img: "b64")


def test_reserved_slots_leave_regular_gate_smaller_than_total():
    total = translate_endpoints._pipeline_semaphore._value
    regular = translate_endpoints._regular_pipeline_gate._value
    assert regular < total
    assert total - regular == translate_endpoints._FIX_HINT_RESERVED_SLOTS
    assert translate_endpoints._FIX_HINT_RESERVED_SLOTS >= 1  # nothing to reserve otherwise


def test_fix_hint_request_is_not_blocked_by_a_saturated_regular_gate(monkeypatch):
    regular_capacity = translate_endpoints._regular_pipeline_gate._value

    async def run():
        # Saturate every regular slot with slow, non-fix requests — none of
        # these will release their slot before the fix request is checked.
        _patch_pipeline(monkeypatch, delay_seconds=0.3)
        regular_tasks = [
            asyncio.ensure_future(translate_endpoints.translate_single(_make_request(with_fix=False)))
            for _ in range(regular_capacity)
        ]
        await asyncio.sleep(0.05)  # let them all acquire their gate slot and start "processing"

        # Re-patch to a near-instant fake *after* the regular tasks have
        # already captured the slow one — isolates "did the fix have to
        # queue for a slot" from "how long the fix's own work takes".
        _patch_pipeline(monkeypatch, delay_seconds=0.01)
        fix_result = await asyncio.wait_for(
            translate_endpoints.translate_single(_make_request(with_fix=True)), timeout=0.15
        )
        await asyncio.gather(*regular_tasks)
        return fix_result

    result = asyncio.run(run())
    assert result.translated_image == "b64"


def test_regular_request_does_queue_behind_a_saturated_regular_gate(monkeypatch):
    regular_capacity = translate_endpoints._regular_pipeline_gate._value

    async def run():
        _patch_pipeline(monkeypatch, delay_seconds=0.3)
        regular_tasks = [
            asyncio.ensure_future(translate_endpoints.translate_single(_make_request(with_fix=False)))
            for _ in range(regular_capacity)
        ]
        await asyncio.sleep(0.05)

        # Unlike the fix_hint case, a 7th regular request has no reserved
        # capacity to fall back on and must wait for one of the above to
        # release its slot first — even though its own work is near-instant.
        _patch_pipeline(monkeypatch, delay_seconds=0.01)
        with pytest.raises(asyncio.TimeoutError):
            await asyncio.wait_for(
                translate_endpoints.translate_single(_make_request(with_fix=False)), timeout=0.1
            )
        await asyncio.gather(*regular_tasks)

    asyncio.run(run())
