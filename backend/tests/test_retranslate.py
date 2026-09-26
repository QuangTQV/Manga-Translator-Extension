"""The per-page "re-translate" button sends `bypass_translation_cache`: a
deliberate redo must not be answered from the backend's translation cache
(which a deterministic config — temperature 0 — would otherwise always hit),
while its fresh result is still stored for later ordinary requests."""
import uuid

import core.services.translation as tr
from core.config import TranslationConfig


def _config(**kw):
    return TranslationConfig(
        provider="Google", google_api_key="k", model_name="gemini-2.5-flash",
        translation_mode="one-step", ocr_method="LLM", send_full_page_context=False,
        temperature=0.0,  # deterministic => cacheable
        **kw,
    )


def _translate(config, image_b64):
    return tr.call_translation_api_batch(
        config, [image_b64], "", ["image/png"], "image/png", [{}],
    )


def test_bypass_skips_the_cache_read_but_still_writes_the_new_result(monkeypatch):
    answers = iter(["1: 元 || first", "1: 元 || second", "1: 元 || never used"])
    calls = []

    def fake_call(cfg, parts, prompt, *args, **kwargs):
        calls.append(1)
        return next(answers)

    monkeypatch.setattr(tr, "_call_llm_endpoint", fake_call)
    page = f"page-{uuid.uuid4()}"  # unique, so no other test's cache entry can interfere

    assert _translate(_config(), page) == ["first"]
    assert _translate(_config(), page) == ["first"]  # ordinary repeat: served from cache
    assert len(calls) == 1

    assert _translate(_config(bypass_translation_cache=True), page) == ["second"]  # the redo goes to the model
    assert len(calls) == 2

    assert _translate(_config(), page) == ["second"]  # ...and its result replaced the cached one
    assert len(calls) == 2


def test_the_request_field_reaches_the_translation_config():
    from endpoints.translate import _config_for_request
    from schemas import TranslateRequest

    base = dict(image="x", provider="Google", input_language="Japanese", output_language="English", api_key="k")
    assert _config_for_request(TranslateRequest(**base)).translation.bypass_translation_cache is False
    assert _config_for_request(TranslateRequest(**base, bypass_translation_cache=True)).translation.bypass_translation_cache is True
