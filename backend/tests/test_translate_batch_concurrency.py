"""endpoints/translate.py: /translate/batch used to dispatch work via
ThreadPoolExecutor.submit() and then block on future.result() inside an
async def — a synchronous blocking call with no await, which freezes the
entire event loop (so no other request, not even /health, gets served)
for the whole batch's duration. It's now asyncio.gather()/run_in_executor,
and both /translate and /translate/batch acquire the same module-level
_pipeline_semaphore so the two endpoints share one real concurrency
ceiling on ML pipeline runs (previously uncoordinated: asyncio.to_thread's
own default executor for singles, a separate 4-worker pool for batch)."""
import asyncio
import threading
import time

import pytest

import endpoints.translate as translate_endpoints
from schemas import TranslateBatchItem, TranslateBatchItemResponse, TranslateBatchRequest


def _make_batch_request(n: int) -> TranslateBatchRequest:
    return TranslateBatchRequest(
        input_language="Auto",
        output_language="English",
        provider="Google",
        images=[TranslateBatchItem(id=str(i), image="") for i in range(n)],
    )


def test_batch_does_not_block_the_event_loop(monkeypatch):
    def fake_translate_item(item, req):
        time.sleep(0.05)
        return TranslateBatchItemResponse(id=item.id, translated_image="x")

    monkeypatch.setattr(translate_endpoints, "_translate_single_item", fake_translate_item)

    heartbeats = []

    async def heartbeat():
        while True:
            heartbeats.append(time.time())
            await asyncio.sleep(0.01)

    async def run():
        hb_task = asyncio.ensure_future(heartbeat())
        await translate_endpoints.translate_batch(_make_batch_request(4))
        hb_task.cancel()

    asyncio.run(run())

    # A blocked event loop would starve the heartbeat coroutine entirely for
    # the batch's ~0.05s duration (4 items / 4 executor workers, one round).
    # A responsive loop lets it tick several times during that window.
    assert len(heartbeats) >= 3


def test_batch_concurrency_is_capped_by_the_shared_semaphore(monkeypatch):
    cap = 2
    monkeypatch.setattr(translate_endpoints, "_pipeline_semaphore", asyncio.Semaphore(cap))

    lock = threading.Lock()
    state = {"current": 0, "max_seen": 0}

    def fake_translate_item(item, req):
        with lock:
            state["current"] += 1
            state["max_seen"] = max(state["max_seen"], state["current"])
        time.sleep(0.05)
        with lock:
            state["current"] -= 1
        return TranslateBatchItemResponse(id=item.id, translated_image="x")

    monkeypatch.setattr(translate_endpoints, "_translate_single_item", fake_translate_item)

    asyncio.run(translate_endpoints.translate_batch(_make_batch_request(6)))

    assert state["max_seen"] <= cap
    assert state["max_seen"] == cap  # enough items/time to actually saturate the cap


def test_batch_still_returns_results_in_order_with_per_item_errors(monkeypatch):
    def fake_translate_item(item, req):
        if item.id == "1":
            return TranslateBatchItemResponse(id=item.id, error="boom")
        return TranslateBatchItemResponse(id=item.id, translated_image="x")

    monkeypatch.setattr(translate_endpoints, "_translate_single_item", fake_translate_item)

    result = asyncio.run(translate_endpoints.translate_batch(_make_batch_request(3)))

    assert [r.id for r in result.results] == ["0", "1", "2"]
    assert result.results[1].error == "boom"
    assert result.success_count == 2
    assert result.error_count == 1


def test_pipeline_semaphore_defaults_to_configured_max_concurrency():
    from config import settings

    assert translate_endpoints._pipeline_semaphore._value == settings.max_concurrent_translations
