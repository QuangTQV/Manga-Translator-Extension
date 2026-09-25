"""Support chat: a one-off LLM call answering "how do I use this project"
questions, grounded in the project's own README/setup docs
(core/services/translation.py:generate_support_chat_reply) plus the
POST /support-chat route. The LLM call itself is monkeypatched in most
tests; _load_support_chat_docs is exercised for real (no mocking) since a
path-resolution mistake there would otherwise silently just send an empty
docs section instead of failing loudly.
"""
import pytest
from fastapi.testclient import TestClient

import main
from core.services.translation import TranslationError, _load_support_chat_docs, generate_support_chat_reply

client = TestClient(main.app, raise_server_exceptions=False)
OPTS = {"provider": "Google"}


# ---------------------------------------------------------------------------
# _load_support_chat_docs — real file I/O, no mocking
# ---------------------------------------------------------------------------
def test_loads_real_readme_and_setup_guide_content():
    docs = _load_support_chat_docs()
    assert "README.md" in docs
    assert "HUONG-DAN-CHAY.md" in docs
    # Spot-check actual content made it in, not just the section headers.
    assert "MangaTranslator" in docs


def test_docs_are_cached_after_first_load(monkeypatch):
    import core.services.translation as translation_module

    # Reset the module-level cache so this test observes a fresh load.
    monkeypatch.setattr(translation_module, "_support_chat_docs_cache", None)
    first = _load_support_chat_docs()
    # Corrupt the cache directly to prove the second call returns the
    # cached value rather than re-reading the file.
    translation_module._support_chat_docs_cache = "SENTINEL"
    assert _load_support_chat_docs() == "SENTINEL"
    assert first != "SENTINEL"


# ---------------------------------------------------------------------------
# generate_support_chat_reply — pure prompt-building logic (LLM call mocked)
# ---------------------------------------------------------------------------
def test_reply_includes_docs_conversation_and_language_instruction(monkeypatch):
    import core.services.translation as translation_module

    captured = {}

    def fake_call_llm_endpoint(config, parts, prompt_text, debug=False, system_prompt=None, call_type="translate"):
        captured["prompt_text"] = prompt_text
        captured["system_prompt"] = system_prompt
        captured["call_type"] = call_type
        return "Here's how to set your API key."

    monkeypatch.setattr(translation_module, "_call_llm_endpoint", fake_call_llm_endpoint)
    from core.config import TranslationConfig

    reply = generate_support_chat_reply(
        TranslationConfig(),
        [{"role": "user", "content": "How do I set my API key?"}],
        ui_language="Vietnamese",
    )
    assert reply == "Here's how to set your API key."
    assert captured["call_type"] == "support_chat"
    assert "Answer in Vietnamese." in captured["system_prompt"]
    assert "How do I set my API key?" in captured["prompt_text"]
    assert "MangaTranslator" in captured["prompt_text"]  # docs made it into the prompt


def test_multi_turn_history_is_flattened_into_the_prompt(monkeypatch):
    import core.services.translation as translation_module

    captured = {}
    monkeypatch.setattr(
        translation_module, "_call_llm_endpoint",
        lambda config, parts, prompt_text, **kw: captured.update(prompt_text=prompt_text) or "ok",
    )
    from core.config import TranslationConfig

    generate_support_chat_reply(
        TranslationConfig(),
        [
            {"role": "user", "content": "What is Story DB?"},
            {"role": "assistant", "content": "It's a character database."},
            {"role": "user", "content": "How do I enable it?"},
        ],
    )
    assert "User: What is Story DB?" in captured["prompt_text"]
    assert "Assistant: It's a character database." in captured["prompt_text"]
    assert "User: How do I enable it?" in captured["prompt_text"]


def test_no_language_instruction_when_ui_language_is_unset(monkeypatch):
    import core.services.translation as translation_module

    captured = {}
    monkeypatch.setattr(
        translation_module, "_call_llm_endpoint",
        lambda config, parts, prompt_text, system_prompt=None, **kw: captured.update(system_prompt=system_prompt) or "ok",
    )
    from core.config import TranslationConfig

    generate_support_chat_reply(TranslationConfig(), [{"role": "user", "content": "hi"}])
    assert "Answer in" not in captured["system_prompt"]


def test_raises_on_empty_last_message():
    from core.config import TranslationConfig

    with pytest.raises(TranslationError):
        generate_support_chat_reply(TranslationConfig(), [{"role": "user", "content": "   "}])


def test_raises_on_empty_llm_reply(monkeypatch):
    import core.services.translation as translation_module

    monkeypatch.setattr(translation_module, "_call_llm_endpoint", lambda *a, **k: "   ")
    from core.config import TranslationConfig

    with pytest.raises(TranslationError):
        generate_support_chat_reply(TranslationConfig(), [{"role": "user", "content": "hi"}])


# ---------------------------------------------------------------------------
# POST /support-chat
# ---------------------------------------------------------------------------
def test_route_returns_the_reply(monkeypatch):
    import endpoints.translate as translate_module

    def fake_generate(config, messages, ui_language=None, debug=False):
        assert messages == [{"role": "user", "content": "How do I add an API key?"}]
        assert ui_language == "Vietnamese"
        return "Go to the LLM Config tab."

    monkeypatch.setattr(translate_module, "generate_support_chat_reply", fake_generate)
    resp = client.post("/support-chat", json={
        **OPTS, "ui_language": "Vietnamese",
        "messages": [{"role": "user", "content": "How do I add an API key?"}],
    })
    assert resp.status_code == 200
    assert resp.json() == {"reply": "Go to the LLM Config tab."}


def test_route_rejects_no_messages():
    resp = client.post("/support-chat", json={**OPTS, "messages": []})
    assert resp.status_code == 400


def test_route_surfaces_a_generation_failure_as_500(monkeypatch):
    import endpoints.translate as translate_module

    def fake_generate(*a, **k):
        raise RuntimeError("boom")

    monkeypatch.setattr(translate_module, "generate_support_chat_reply", fake_generate)
    resp = client.post("/support-chat", json={**OPTS, "messages": [{"role": "user", "content": "hi"}]})
    assert resp.status_code == 500


def test_route_does_not_require_login_only_a_token_when_auth_is_enabled():
    # Same gating family as /suggest-instructions and /stories/update-from-description
    # — a local/self-hosted setup with MT_REQUIRE_AUTH off needs no token at all.
    resp = client.post("/support-chat", json={**OPTS, "messages": [{"role": "user", "content": "hi"}]})
    assert resp.status_code != 401
