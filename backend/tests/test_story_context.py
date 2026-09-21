"""core/story_context.py (the per-account Story DB — character database /
relationships / glossary) and the /stories routes it backs, plus
auth.py:require_login. Needs a real Postgres reachable at MT_DATABASE_URL —
skipped entirely otherwise (see backend/docker-compose.yml for a local
one), same as test_accounts.py/test_auth_gate.py.
"""
import os

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("MT_DATABASE_URL"),
    reason="MT_DATABASE_URL not set — see backend/docker-compose.yml for a local Postgres",
)

import sqlalchemy as sa  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from config import settings  # noqa: E402
from core.accounts import _accounts_table, register_account  # noqa: E402
from core.db import get_engine  # noqa: E402
from core.story_context import (  # noqa: E402
    SchemaMismatchError,
    StoryNotFoundError,
    _stories_table,
    create_story,
    delete_story,
    ensure_schema,
    get_story,
    list_stories,
    save_story,
)
from main import app  # noqa: E402

client = TestClient(app)


@pytest.fixture(autouse=True)
def _clean_tables(monkeypatch):
    monkeypatch.setattr(settings, "require_auth", False)
    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(_stories_table.delete())
        conn.execute(_accounts_table.delete())


# --- core/story_context.py unit tests -------------------------------------

def test_create_story_starts_empty():
    story = create_story("alice@example.com", "My Manga")
    assert story.name == "My Manga"
    assert story.characters == []
    assert story.relationships == []
    assert story.glossary == []


def test_save_story_round_trips_characters_relationships_glossary():
    story = create_story("carol@example.com", "Story B")
    characters = [{"id": "c1", "name": "Aoi", "gender": "female", "role": "protagonist", "voice_notes": "blunt"}]
    relationships = [{"id": "r1", "character_a_id": "c1", "character_b_id": "c2", "surface_relation": "rivals", "address_notes": None}]
    glossary = [{"id": "g1", "term": "Kage-ryu", "translation": "Shadow Style", "notes": None}]

    saved = save_story(story.id, "carol@example.com", "Story B (renamed)", characters, relationships, glossary)
    assert saved.name == "Story B (renamed)"

    fetched = get_story(story.id, "carol@example.com")
    assert fetched.name == "Story B (renamed)"
    assert fetched.characters == characters
    assert fetched.relationships == relationships
    assert fetched.glossary == glossary


def test_save_story_defaults_continuity_notes_to_empty_and_disabled():
    story = create_story("carol2@example.com", "Story C")
    saved = save_story(story.id, "carol2@example.com", "Story C", [], [], [])
    assert saved.continuity_notes == []
    assert saved.continuity_notes_enabled is False


def test_save_story_round_trips_continuity_notes_and_its_toggle():
    story = create_story("carol3@example.com", "Story D")
    notes = [{"id": "n1", "text": "Ren is revealed to be Aoi's half-brother", "source_label": "Chapter 5"}]

    saved = save_story(story.id, "carol3@example.com", "Story D", [], [], [], notes, True)
    assert saved.continuity_notes == notes
    assert saved.continuity_notes_enabled is True

    fetched = get_story(story.id, "carol3@example.com")
    assert fetched.continuity_notes == notes
    assert fetched.continuity_notes_enabled is True


def test_get_story_owned_by_another_account_raises_not_found():
    story = create_story("dave@example.com", "Dave's Story")
    with pytest.raises(StoryNotFoundError):
        get_story(story.id, "eve@example.com")


def test_save_story_owned_by_another_account_raises_not_found():
    story = create_story("frank@example.com", "Frank's Story")
    with pytest.raises(StoryNotFoundError):
        save_story(story.id, "grace@example.com", "Hijacked", [], [], [])


def test_delete_story_owned_by_another_account_raises_not_found():
    story = create_story("henry@example.com", "Henry's Story")
    with pytest.raises(StoryNotFoundError):
        delete_story(story.id, "irene@example.com")
    # Untouched — still fetchable by the real owner.
    assert get_story(story.id, "henry@example.com") is not None


def test_delete_story_removes_it():
    story = create_story("jane@example.com", "Jane's Story")
    delete_story(story.id, "jane@example.com")
    with pytest.raises(StoryNotFoundError):
        get_story(story.id, "jane@example.com")


def test_list_stories_only_returns_the_caller_accounts_stories():
    create_story("kevin@example.com", "Kevin's Story")
    create_story("laura@example.com", "Laura's Story 1")
    create_story("laura@example.com", "Laura's Story 2")

    laura_stories = list_stories("laura@example.com")
    assert {s.name for s in laura_stories} == {"Laura's Story 1", "Laura's Story 2"}
    kevin_stories = list_stories("kevin@example.com")
    assert {s.name for s in kevin_stories} == {"Kevin's Story"}


def test_ensure_schema_rejects_a_pre_existing_incompatible_story_contexts_table():
    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(sa.text("DROP TABLE story_contexts"))
        conn.execute(sa.text("CREATE TABLE story_contexts (id serial primary key, foo text)"))
    try:
        with pytest.raises(SchemaMismatchError):
            ensure_schema()
    finally:
        with engine.begin() as conn:
            conn.execute(sa.text("DROP TABLE story_contexts"))
        _stories_table.metadata.create_all(engine)


# --- /stories routes + require_login, exercised through the real app -----

def test_stories_routes_require_login_even_when_require_auth_is_off():
    """require_login (unlike verify_token) never no-ops based on
    require_auth — the Story DB feature is opt-in per user regardless of
    whether the deployment enforces translate quotas."""
    assert settings.require_auth is False
    resp = client.get("/stories")
    assert resp.status_code == 401


def test_stories_routes_reject_invalid_token():
    resp = client.get("/stories", headers={"Authorization": "Bearer not-a-real-token"})
    assert resp.status_code == 401


def test_stories_crud_round_trip_via_the_api():
    account = register_account("api-user@example.com")
    headers = {"Authorization": f"Bearer {account.token}"}

    created = client.post("/stories", json={"name": "My Manga"}, headers=headers)
    assert created.status_code == 200
    story_id = created.json()["id"]

    listed = client.get("/stories", headers=headers)
    assert listed.status_code == 200
    assert [s["id"] for s in listed.json()] == [story_id]

    payload = {
        "name": "My Manga",
        "characters": [{"id": "c1", "name": "Aoi", "gender": "female", "role": "protagonist", "voice_notes": None}],
        "relationships": [],
        "glossary": [{"id": "g1", "term": "Kage-ryu", "translation": "Shadow Style", "notes": None}],
        "continuity_notes": [{"id": "n1", "text": "Ren is Aoi's half-brother", "source_label": "Chapter 5"}],
        "continuity_notes_enabled": True,
    }
    saved = client.put(f"/stories/{story_id}", json=payload, headers=headers)
    assert saved.status_code == 200
    assert saved.json()["characters"][0]["name"] == "Aoi"
    assert saved.json()["continuity_notes_enabled"] is True

    fetched = client.get(f"/stories/{story_id}", headers=headers)
    assert fetched.status_code == 200
    assert fetched.json()["glossary"][0]["translation"] == "Shadow Style"
    assert fetched.json()["continuity_notes"][0]["text"] == "Ren is Aoi's half-brother"

    deleted = client.delete(f"/stories/{story_id}", headers=headers)
    assert deleted.status_code == 200
    assert client.get(f"/stories/{story_id}", headers=headers).status_code == 404


def test_resolve_story_context_populates_request_fields_from_the_stored_story():
    """endpoints/translate.py:_resolve_story_context — the function that
    fetches a logged-in account's Story DB and mutates the request in
    place before _build_config() reads it."""
    from core.accounts import Account
    from endpoints.translate import _resolve_story_context
    from schemas import TranslateRequest

    story = create_story("resolver@example.com", "Resolver Story")
    characters = [{"id": "c1", "name": "Aoi", "gender": "female", "role": "protagonist", "voice_notes": None}]
    relationships = [{"id": "r1", "character_a_id": "c1", "character_b_id": "c2", "surface_relation": "rivals", "address_notes": None}]
    glossary = [{"id": "g1", "term": "Kage-ryu", "translation": "Shadow Style", "notes": None}]
    save_story(story.id, "resolver@example.com", "Resolver Story", characters, relationships, glossary)

    account = Account(email="resolver@example.com", plan="free", usage_count=0, period_start=0)
    req = TranslateRequest(image="", input_language="Japanese", output_language="English", provider="Google", story_id=story.id)

    _resolve_story_context(req, account)

    assert [c.name for c in req.story_characters] == ["Aoi"]
    assert req.story_relationships[0].surface_relation == "rivals"
    assert req.story_glossary[0].translation == "Shadow Style"
    # continuity_notes_enabled defaults to False (save_story wasn't given
    # notes/the toggle above), so no continuity notes should be resolved.
    assert req.story_continuity_notes == []


def test_resolve_story_context_only_populates_continuity_notes_when_the_story_toggle_is_on():
    from core.accounts import Account
    from endpoints.translate import _resolve_story_context
    from schemas import TranslateRequest

    story = create_story("resolver2@example.com", "Resolver Story 2")
    notes = [{"id": "n1", "text": "Ren is Aoi's rival turned ally", "source_label": "Chapter 3"}]
    save_story(story.id, "resolver2@example.com", "Resolver Story 2", [], [], [], notes, continuity_notes_enabled=False)
    account = Account(email="resolver2@example.com", plan="free", usage_count=0, period_start=0)

    req_off = TranslateRequest(image="", input_language="Japanese", output_language="English", provider="Google", story_id=story.id)
    _resolve_story_context(req_off, account)
    assert req_off.story_continuity_notes == []  # toggle is off -> not sent, even though notes exist

    save_story(story.id, "resolver2@example.com", "Resolver Story 2", [], [], [], notes, continuity_notes_enabled=True)
    req_on = TranslateRequest(image="", input_language="Japanese", output_language="English", provider="Google", story_id=story.id)
    _resolve_story_context(req_on, account)
    assert [n.text for n in req_on.story_continuity_notes] == ["Ren is Aoi's rival turned ally"]


def test_resolve_story_context_is_a_noop_for_anonymous_requests():
    from endpoints.translate import _resolve_story_context
    from schemas import TranslateRequest

    story = create_story("owner2@example.com", "Owner2 Story")
    req = TranslateRequest(image="", input_language="Japanese", output_language="English", provider="Google", story_id=story.id)

    _resolve_story_context(req, None)  # account is None -> anonymous, same as require_auth being off

    assert req.story_characters == []
    assert req.story_relationships == []
    assert req.story_glossary == []


def test_resolve_story_context_ignores_a_stale_or_foreign_story_id():
    from core.accounts import Account
    from endpoints.translate import _resolve_story_context
    from schemas import TranslateRequest

    account = Account(email="innocent@example.com", plan="free", usage_count=0, period_start=0)
    req = TranslateRequest(image="", input_language="Japanese", output_language="English", provider="Google", story_id="does-not-exist")

    _resolve_story_context(req, account)  # should not raise

    assert req.story_characters == []


def test_stories_route_404s_for_another_accounts_story_id():
    owner = register_account("owner@example.com")
    other = register_account("other@example.com")
    created = client.post("/stories", json={"name": "Owner's story"}, headers={"Authorization": f"Bearer {owner.token}"})
    story_id = created.json()["id"]

    resp = client.get(f"/stories/{story_id}", headers={"Authorization": f"Bearer {other.token}"})
    assert resp.status_code == 404
