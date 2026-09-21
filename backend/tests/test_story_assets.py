"""Character assets in the Story DB: display-only avatars and opt-in
reference images (character sheets) sent to the model. Pure logic — no DB,
network or ML; the story lookup is monkeypatched."""
import pytest
from pydantic import ValidationError

from core.accounts import Account
from core.caching import get_cache
from core.config import StoryCharacterConfig, StoryGlossaryTermConfig, TranslationConfig
from core.services.translation import (
    _format_story_reference_note,
    _story_reference_image_parts,
    _story_reference_images,
)
from core.story_context import StoryRow
from endpoints import translate as translate_endpoint
from schemas import StoryCharacter, TranslateRequest

PNG = "data:image/png;base64,iVBORw0KGgo="


def test_avatar_and_reference_images_are_validated():
    ok = StoryCharacter(id="c1", name="Aoi", avatar=PNG, reference_images=[PNG, PNG])
    assert ok.avatar == PNG
    with pytest.raises(ValidationError):
        StoryCharacter(id="c1", name="Aoi", avatar="https://evil.example/x.png")
    with pytest.raises(ValidationError):
        StoryCharacter(id="c1", name="Aoi", avatar="data:image/png;base64," + "A" * 70_000)
    with pytest.raises(ValidationError):
        StoryCharacter(id="c1", name="Aoi", reference_images=[PNG, PNG, PNG])
    with pytest.raises(ValidationError):
        StoryCharacter(id="c1", name="Aoi", reference_images=["data:text/html;base64,AAAA"])
    # An empty string means "no avatar", not an error.
    assert StoryCharacter(id="c1", name="Aoi", avatar="").avatar is None


def _story(chars):
    return StoryRow(id="s1", account_email="a@example.com", name="S", characters=chars)


def _account():
    return Account(email="a@example.com", plan="free", usage_count=0, period_start=0.0)


def _resolve(monkeypatch, chars, use_refs):
    import core.story_context as sc
    monkeypatch.setattr(sc, "get_story", lambda *_a, **_k: _story(chars))
    req = TranslateRequest(image="x", provider="Google", input_language="Japanese", output_language="English", story_id="s1", story_use_reference_images=use_refs)
    translate_endpoint._resolve_story_context(req, _account())
    return req


CHARS = [
    {"id": "c1", "name": "Aoi", "avatar": PNG, "reference_images": [PNG, PNG], "x": 5, "y": 6},
    {"id": "c2", "name": "Ren", "reference_images": [PNG, PNG]},
    {"id": "c3", "name": "Sora", "reference_images": [PNG, PNG]},
    {"id": "c4", "name": "Kaze", "reference_images": [PNG]},
]


def test_reference_images_are_dropped_unless_the_request_opts_in(monkeypatch):
    req = _resolve(monkeypatch, CHARS, use_refs=False)
    assert all(c.reference_images == [] for c in req.story_characters)
    assert all(c.avatar is None for c in req.story_characters)  # avatars never leave the resolver


def test_reference_images_are_capped_overall_and_avatars_still_stripped(monkeypatch):
    req = _resolve(monkeypatch, CHARS, use_refs=True)
    counts = [len(c.reference_images) for c in req.story_characters]
    assert sum(counts) == translate_endpoint.MAX_STORY_REFERENCE_IMAGES == 6
    assert counts == [2, 2, 2, 0]  # earlier characters win the budget
    assert all(c.avatar is None and c.x is None for c in req.story_characters)


def test_reference_images_are_decoded_labelled_and_turned_into_parts():
    config = TranslationConfig(story_characters=[
        StoryCharacterConfig(id="c1", name="Aoi", reference_images=[PNG, "not-a-data-url"]),
        StoryCharacterConfig(id="c2", name="Ren", reference_images=["data:image/jpeg;base64,/9j/4AAQ"]),
    ])
    refs = _story_reference_images(config)
    assert [(n, i["mime_type"]) for n, i in refs] == [("Aoi", "image/png"), ("Ren", "image/jpeg")]
    parts = _story_reference_image_parts(refs, False, None)
    assert parts[0]["inline_data"]["data"] == "iVBORw0KGgo="
    note = _format_story_reference_note(refs)
    assert "Reference image 1: Aoi" in note and "Reference image 2: Ren" in note
    assert _format_story_reference_note([]) == ""


def test_translation_cache_key_changes_when_story_context_changes():
    cache = get_cache()

    def key(glossary):
        config = TranslationConfig(temperature=0.0, story_glossary=glossary)
        return cache.get_translation_cache_key(["img"], "full", config)

    none = key([])
    a = key([StoryGlossaryTermConfig(term="Kage-ryu", translation="Shadow Style")])
    b = key([StoryGlossaryTermConfig(term="Kage-ryu", translation="Shadow School")])
    assert none and a and b
    assert len({none, a, b}) == 3
    assert a == key([StoryGlossaryTermConfig(term="Kage-ryu", translation="Shadow Style")])


def _capture_llm_call(monkeypatch, ocr_method):
    import core.services.translation as tr

    captured = {}

    def fake_call(config, parts, prompt, *args, **kwargs):
        captured["parts"], captured["prompt"] = parts, prompt
        return "1: hello"

    monkeypatch.setattr(tr, "_call_llm_endpoint", fake_call)
    monkeypatch.setattr(tr, "get_cache", lambda: type("C", (), {
        "get_translation_cache_key": lambda *a, **k: None,
        "get_translation": lambda *a, **k: (None, None),
        "set_translation": lambda *a, **k: None,
    })())
    config = TranslationConfig(
        provider="Google", google_api_key="k", model_name="gemini-2.5-flash", translation_mode="one-step",
        ocr_method=ocr_method, send_full_page_context=False,
        story_characters=[StoryCharacterConfig(id="c1", name="Aoi", reference_images=[PNG, PNG])],
    )
    try:
        tr.call_translation_api_batch(config, ["AAAA"], "", ["image/png"], "image/png", [{}])
    except Exception:
        pass  # response parsing isn't under test — only what was sent
    return captured


def test_reference_images_are_attached_and_explained_in_the_prompt(monkeypatch):
    captured = _capture_llm_call(monkeypatch, "LLM")
    images = [p for p in captured["parts"] if "inline_data" in p]
    assert len(images) == 1 + 2  # the one bubble image + two reference images, references last
    assert images[-1]["inline_data"]["data"] == "iVBORw0KGgo="
    assert "Character reference images" in captured["prompt"]
    assert "Reference image 1: Aoi" in captured["prompt"]


def test_reference_images_are_skipped_when_the_model_receives_no_images(monkeypatch):
    captured = _capture_llm_call(monkeypatch, "manga-ocr")
    assert "Character reference images" not in captured.get("prompt", "")


def test_account_routes_return_503_not_500_when_no_database_is_configured(monkeypatch):
    from fastapi.testclient import TestClient

    import core.db as db
    import main

    monkeypatch.setattr(db.settings, "database_url", "")
    resp = TestClient(main.app, raise_server_exceptions=False).get("/account/me", headers={"Authorization": "Bearer x"})
    assert resp.status_code == 503
    assert "MT_DATABASE_URL" in resp.json()["detail"]
