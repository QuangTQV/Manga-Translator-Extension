"""Story DB "update from a description" — turning a free-text note into a
structured update (core/story_context.py:merge_story_update parses/applies
the LLM's reply) plus the /stories/update-from-description route. Pure
logic where possible; the LLM call is monkeypatched in the route tests."""
import pytest
from fastapi.testclient import TestClient

import main
from core.story_context import StoryUpdateParseError, merge_story_update

client = TestClient(main.app, raise_server_exceptions=False)
OPTS = {"provider": "Google", "input_language": "Japanese", "output_language": "Vietnamese"}

EXAMPLE_REPLY = """
{
  "characters": [
    {"name": "Akira", "gender": "male", "role": "protagonist"},
    {"name": "Hina", "gender": "female", "role": "antagonist (revealed)"}
  ],
  "relationships": [
    {"character_a": "Akira", "character_b": "Hina", "surface_relation": "secret enemies (former childhood friends)", "address_notes": "switched from casual tớ/cậu to hostile ta/ngươi after the reveal"}
  ],
  "continuity_note": {"text": "The mastermind behind the attacks is revealed to be Akira's childhood friend Hina.", "source_label": "Chapter 39"}
}
"""


# ---------------------------------------------------------------------------
# merge_story_update — pure, no network
# ---------------------------------------------------------------------------
def test_new_characters_and_relationship_are_created_from_an_empty_story():
    characters, relationships, note = merge_story_update([], [], EXAMPLE_REPLY)
    assert {c["name"] for c in characters} == {"Akira", "Hina"}
    akira = next(c for c in characters if c["name"] == "Akira")
    hina = next(c for c in characters if c["name"] == "Hina")
    assert akira["gender"] == "male" and hina["gender"] == "female"
    assert len(relationships) == 1
    rel = relationships[0]
    assert {rel["character_a_id"], rel["character_b_id"]} == {akira["id"], hina["id"]}
    assert "hostile ta/ngươi" in rel["address_notes"]
    assert note["text"].startswith("The mastermind")
    assert note["source_label"] == "Chapter 39"


def test_existing_character_is_updated_in_place_not_duplicated():
    existing = [{"id": "c-akira", "name": "akira", "gender": "unknown", "role": None, "voice_notes": None}]
    characters, _, _ = merge_story_update(existing, [], EXAMPLE_REPLY)
    assert len(characters) == 2  # Akira updated, Hina added — not 3
    akira = next(c for c in characters if c["id"] == "c-akira")
    assert akira["name"] == "akira"  # existing spelling/casing is kept, only fields are updated
    assert akira["gender"] == "male"
    assert akira["role"] == "protagonist"


def test_existing_relationship_between_the_same_pair_is_updated_not_duplicated():
    existing_chars = [
        {"id": "c-a", "name": "Akira", "gender": "male", "role": None, "voice_notes": None},
        {"id": "c-h", "name": "Hina", "gender": "female", "role": None, "voice_notes": None},
    ]
    existing_rels = [{"id": "r1", "character_a_id": "c-h", "character_b_id": "c-a", "surface_relation": "childhood friends", "address_notes": "casual tớ/cậu"}]
    characters, relationships, _ = merge_story_update(existing_chars, existing_rels, EXAMPLE_REPLY)
    assert len(relationships) == 1
    assert relationships[0]["id"] == "r1"  # same relationship row, not a new one
    assert relationships[0]["surface_relation"] == "secret enemies (former childhood friends)"
    assert len(characters) == 2  # no duplicates


def test_a_relationship_naming_an_unknown_character_is_dropped_not_a_dangling_reference():
    reply = '{"characters": [{"name": "Akira"}], "relationships": [{"character_a": "Akira", "character_b": "Ghost", "surface_relation": "?"}]}'
    characters, relationships, note = merge_story_update([], [], reply)
    assert len(characters) == 1
    assert relationships == []
    assert note is None


def test_omitted_fields_do_not_blank_out_existing_values():
    existing = [{"id": "c1", "name": "Akira", "gender": "male", "role": "protagonist", "voice_notes": "blunt"}]
    reply = '{"characters": [{"name": "Akira", "role": "reluctant hero"}]}'  # no gender/voice_notes given
    characters, _, _ = merge_story_update(existing, [], reply)
    assert characters[0]["gender"] == "male"
    assert characters[0]["voice_notes"] == "blunt"
    assert characters[0]["role"] == "reluctant hero"


def test_a_pure_style_note_with_no_continuity_note_returns_none():
    reply = '{"characters": [{"name": "Akira", "voice_notes": "always sarcastic"}], "relationships": [], "continuity_note": null}'
    _, _, note = merge_story_update([], [], reply)
    assert note is None


@pytest.mark.parametrize("bad_reply", [
    "not json at all",
    '{"characters": [}',
    "[]",  # valid JSON but not an object
])
def test_unparsable_or_wrongly_shaped_replies_raise(bad_reply):
    with pytest.raises(StoryUpdateParseError):
        merge_story_update([], [], bad_reply)


def test_a_fenced_code_block_reply_is_still_parsed():
    fenced = f"```json\n{EXAMPLE_REPLY.strip()}\n```"
    characters, _, _ = merge_story_update([], [], fenced)
    assert len(characters) == 2


# ---------------------------------------------------------------------------
# POST /stories/update-from-description
# ---------------------------------------------------------------------------
def test_route_merges_and_returns_the_update(monkeypatch):
    import endpoints.stories as stories_module

    def fake_generate(config, description, characters, relationships, output_language, story_title=None):
        assert "childhood friend" in description
        assert output_language == "Vietnamese"
        return EXAMPLE_REPLY

    monkeypatch.setattr(stories_module, "generate_story_update", fake_generate)
    resp = client.post("/stories/update-from-description", json={
        **OPTS, "description": "Chapter 39: the villain turns out to be Akira's childhood friend Hina.",
        "characters": [], "relationships": [],
    })
    assert resp.status_code == 200
    data = resp.json()
    assert {c["name"] for c in data["characters"]} == {"Akira", "Hina"}
    assert data["continuity_note"]["source_label"] == "Chapter 39"


def test_route_rejects_a_blank_description():
    resp = client.post("/stories/update-from-description", json={**OPTS, "description": "   ", "characters": [], "relationships": []})
    assert resp.status_code == 400


def test_route_surfaces_a_bad_llm_reply_as_502(monkeypatch):
    import endpoints.stories as stories_module

    monkeypatch.setattr(stories_module, "generate_story_update", lambda *a, **k: "not json")
    resp = client.post("/stories/update-from-description", json={**OPTS, "description": "something happened", "characters": [], "relationships": []})
    assert resp.status_code == 502


def test_route_does_not_require_login_only_a_token_when_auth_is_enabled():
    # Same gating family as /suggest-instructions and /region/translate — a
    # local/self-hosted setup with MT_REQUIRE_AUTH off needs no token at all.
    resp = client.post("/stories/update-from-description", json={**OPTS, "description": "x", "characters": [], "relationships": []})
    assert resp.status_code != 401


def test_route_enables_web_search_and_forwards_the_story_title(monkeypatch):
    import endpoints.stories as stories_module

    seen = {}

    def fake_generate(config, description, characters, relationships, output_language, story_title=None):
        seen["enable_web_search"] = config.enable_web_search
        seen["story_title"] = story_title
        return EXAMPLE_REPLY

    monkeypatch.setattr(stories_module, "generate_story_update", fake_generate)
    resp = client.post("/stories/update-from-description", json={
        **OPTS, "description": "Update up to chapter 39.", "characters": [], "relationships": [],
        "enable_web_search": True, "story_title": "My Manga",
    })
    assert resp.status_code == 200
    assert seen == {"enable_web_search": True, "story_title": "My Manga"}


def test_web_search_off_by_default_and_does_not_require_a_title(monkeypatch):
    import endpoints.stories as stories_module

    seen = {}

    def fake_generate(config, description, characters, relationships, output_language, story_title=None):
        seen["enable_web_search"] = config.enable_web_search
        seen["story_title"] = story_title
        return EXAMPLE_REPLY

    monkeypatch.setattr(stories_module, "generate_story_update", fake_generate)
    resp = client.post("/stories/update-from-description", json={**OPTS, "description": "x", "characters": [], "relationships": []})
    assert resp.status_code == 200
    assert seen == {"enable_web_search": False, "story_title": None}
