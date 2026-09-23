"""Per-account character database ("Story DB") for the professional
translation feature — backed by the same Postgres database as
core/accounts.py, keyed by account_email. Opt-in per user (see
auth.py:require_login): unlike core/accounts.py/core/server_config.py,
this works regardless of MT_REQUIRE_AUTH — a user just needs to be logged
in (registered/Google-logged-in via the extension's Account tab) to use it.

Each story is one row holding its whole Character/Relationship/Glossary
set as JSON text columns rather than three separate normalized tables:
the popup always reads/writes the whole set together (one "Save" button),
so there's no benefit to real foreign keys here — client-generated string
ids inside the JSON (e.g. a relationship's character_a_id/character_b_id)
are enough to link a relationship to its characters. No encryption is
needed (no secrets in this data), unlike core/server_config.py's api_key
column.
"""
from __future__ import annotations

import time
import uuid
from dataclasses import dataclass, field
from typing import Optional

import sqlalchemy as sa

from core.db import get_engine, metadata


class StoryNotFoundError(Exception):
    """Raised when a story_id doesn't exist, or exists but belongs to a
    different account — callers should treat both cases identically (a
    404, not a 403) so a request never reveals whether a given id exists
    for someone else's account."""


@dataclass
class StoryRow:
    id: str
    account_email: str
    name: str
    characters: list[dict] = field(default_factory=list)
    relationships: list[dict] = field(default_factory=list)
    glossary: list[dict] = field(default_factory=list)
    # Free-text, user-maintained notes about what's happened/been revealed
    # in the story so far (e.g. "Ch.5: Ren is revealed to be Aoi's
    # half-brother") — simpler than a categorized fact ledger, and gated by
    # its own on/off switch rather than always being sent once non-empty
    # (unlike characters/relationships/glossary): these can accumulate to
    # a lot of text over a long-running series, so the user explicitly
    # opts in per story.
    continuity_notes: list[dict] = field(default_factory=list)
    continuity_notes_enabled: bool = False
    created_at: float = 0.0
    updated_at: float = 0.0


_stories_table = sa.Table(
    "story_contexts",
    metadata,
    sa.Column("id", sa.String(36), primary_key=True),
    sa.Column("account_email", sa.String(320), nullable=False, index=True),
    sa.Column("name", sa.String(200), nullable=False),
    sa.Column("characters_json", sa.Text, nullable=False, server_default="[]"),
    sa.Column("relationships_json", sa.Text, nullable=False, server_default="[]"),
    sa.Column("glossary_json", sa.Text, nullable=False, server_default="[]"),
    sa.Column("continuity_notes_json", sa.Text, nullable=False, server_default="[]"),
    sa.Column("continuity_notes_enabled", sa.Boolean, nullable=False, server_default=sa.false()),
    sa.Column("created_at", sa.Float, nullable=False),
    sa.Column("updated_at", sa.Float, nullable=False),
)


class SchemaMismatchError(Exception):
    """See core/accounts.py's SchemaMismatchError — same reasoning, this
    table's own version of the same check."""


def ensure_schema() -> None:
    """Creates story_contexts if missing, validates its shape if it
    already existed — called eagerly at server startup (main.py) whenever
    MT_DATABASE_URL is configured, regardless of MT_REQUIRE_AUTH (this
    feature doesn't depend on that flag)."""
    engine = get_engine()
    with engine.connect() as conn:
        try:
            conn.execute(sa.select(_stories_table).limit(0))
        except sa.exc.DBAPIError as e:
            raise SchemaMismatchError(
                "A table named 'story_contexts' already exists in this "
                "database but doesn't match the expected columns "
                "(id, account_email, name, characters_json, "
                "relationships_json, glossary_json, continuity_notes_json, "
                f"continuity_notes_enabled, created_at, updated_at): {e}"
            ) from e


def _row_to_story(row) -> StoryRow:
    import json

    return StoryRow(
        id=row.id,
        account_email=row.account_email,
        name=row.name,
        characters=json.loads(row.characters_json),
        relationships=json.loads(row.relationships_json),
        glossary=json.loads(row.glossary_json),
        continuity_notes=json.loads(row.continuity_notes_json),
        continuity_notes_enabled=row.continuity_notes_enabled,
        created_at=row.created_at,
        updated_at=row.updated_at,
    )


def list_stories(account_email: str) -> list[StoryRow]:
    engine = get_engine()
    with engine.connect() as conn:
        rows = conn.execute(
            sa.select(_stories_table)
            .where(_stories_table.c.account_email == account_email)
            .order_by(_stories_table.c.updated_at.desc())
        ).fetchall()
        return [_row_to_story(row) for row in rows]


def get_story(story_id: str, account_email: str) -> StoryRow:
    engine = get_engine()
    with engine.connect() as conn:
        row = conn.execute(
            sa.select(_stories_table).where(
                _stories_table.c.id == story_id,
                _stories_table.c.account_email == account_email,
            )
        ).first()
        if not row:
            raise StoryNotFoundError(f"No story '{story_id}' for this account")
        return _row_to_story(row)


def create_story(account_email: str, name: str) -> StoryRow:
    engine = get_engine()
    now = time.time()
    story_id = str(uuid.uuid4())
    with engine.begin() as conn:
        conn.execute(_stories_table.insert().values(
            id=story_id, account_email=account_email, name=name,
            characters_json="[]", relationships_json="[]", glossary_json="[]",
            continuity_notes_json="[]", continuity_notes_enabled=False,
            created_at=now, updated_at=now,
        ))
    return StoryRow(id=story_id, account_email=account_email, name=name, created_at=now, updated_at=now)


def save_story(
    story_id: str,
    account_email: str,
    name: str,
    characters: list[dict],
    relationships: list[dict],
    glossary: list[dict],
    continuity_notes: list[dict] | None = None,
    continuity_notes_enabled: bool = False,
) -> StoryRow:
    """Full replace of a story's content — mirrors
    core/server_config.py:set_shared_llm_config's "save the whole thing"
    contract. Raises StoryNotFoundError if story_id doesn't exist or
    belongs to a different account."""
    import json

    continuity_notes = continuity_notes or []
    engine = get_engine()
    now = time.time()
    with engine.begin() as conn:
        existing = conn.execute(
            sa.select(_stories_table.c.id).where(
                _stories_table.c.id == story_id,
                _stories_table.c.account_email == account_email,
            )
        ).first()
        if not existing:
            raise StoryNotFoundError(f"No story '{story_id}' for this account")
        conn.execute(
            _stories_table.update()
            .where(_stories_table.c.id == story_id)
            .values(
                name=name,
                characters_json=json.dumps(characters),
                relationships_json=json.dumps(relationships),
                glossary_json=json.dumps(glossary),
                continuity_notes_json=json.dumps(continuity_notes),
                continuity_notes_enabled=continuity_notes_enabled,
                updated_at=now,
            )
        )
    return StoryRow(
        id=story_id, account_email=account_email, name=name,
        characters=characters, relationships=relationships, glossary=glossary,
        continuity_notes=continuity_notes, continuity_notes_enabled=continuity_notes_enabled,
        updated_at=now,
    )


class StoryUpdateParseError(Exception):
    """Raised when the LLM's reply to a "update from description" request
    isn't valid JSON in the expected shape — the caller surfaces this as a
    normal error rather than silently discarding the user's description."""


def _extract_json_object(raw: str) -> dict:
    """Best-effort JSON extraction from an LLM reply: strips a ```json ...```
    fence if present (models add one occasionally despite being told not
    to), then parses the first '{' to the last '}' — the same
    fence-stripping shape as endpoints/regions.py's _clean_translation, one
    level more defensive since here the whole payload must parse as JSON,
    not just be usable as literal text."""
    import json
    import re

    text = raw.strip()
    fence = re.match(r"^```[a-zA-Z]*\n?(.*?)\n?```$", text, re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    start, end = text.find("{"), text.rfind("}")
    if start == -1 or end == -1 or end < start:
        raise StoryUpdateParseError("The model's reply did not contain a JSON object.")
    try:
        parsed = json.loads(text[start : end + 1])
    except json.JSONDecodeError as e:
        raise StoryUpdateParseError(f"The model's reply was not valid JSON: {e}") from e
    if not isinstance(parsed, dict):
        raise StoryUpdateParseError("The model's reply was not a JSON object.")
    return parsed


def merge_story_update(
    characters: list[dict],
    relationships: list[dict],
    raw_llm_reply: str,
) -> tuple[list[dict], list[dict], Optional[dict]]:
    """Applies an LLM-drafted update (see
    core/services/translation.py:generate_story_update's prompt for the
    exact JSON shape asked for) on top of a story's existing characters/
    relationships, matching by **name** (case-insensitive, trimmed) rather
    than id — the model has no way to know this story's internal ids, so it
    names characters instead, and this is where those names get resolved
    back to stable ids: an existing character/relationship is updated in
    place (id kept), a new one is created with a fresh id. Returns
    (characters, relationships, continuity_note_or_None) — a plain function,
    no I/O, so it's cheap to unit test without a real LLM call.

    A relationship naming a character that isn't in the story (not existing,
    not in this same update's character list) is dropped rather than
    creating a dangling reference — this can only happen if the model
    invents a name it didn't itself also add as a character.
    """
    data = _extract_json_object(raw_llm_reply)

    characters = [dict(c) for c in characters]
    relationships = [dict(r) for r in relationships]

    def find_character_index(name: str) -> Optional[int]:
        key = name.strip().casefold()
        for i, c in enumerate(characters):
            if c.get("name", "").strip().casefold() == key:
                return i
        return None

    for raw_char in data.get("characters") or []:
        name = (raw_char.get("name") or "").strip()
        if not name:
            continue
        idx = find_character_index(name)
        if idx is None:
            characters.append({
                "id": str(uuid.uuid4()),
                "name": name,
                "gender": raw_char.get("gender") or "unknown",
                "role": raw_char.get("role") or None,
                "voice_notes": raw_char.get("voice_notes") or None,
            })
        else:
            existing = characters[idx]
            if raw_char.get("gender"):
                existing["gender"] = raw_char["gender"]
            if raw_char.get("role"):
                existing["role"] = raw_char["role"]
            if raw_char.get("voice_notes"):
                existing["voice_notes"] = raw_char["voice_notes"]

    def find_relationship_index(id_a: str, id_b: str) -> Optional[int]:
        pair = {id_a, id_b}
        for i, r in enumerate(relationships):
            if {r.get("character_a_id"), r.get("character_b_id")} == pair:
                return i
        return None

    for raw_rel in data.get("relationships") or []:
        idx_a = find_character_index(raw_rel.get("character_a") or "")
        idx_b = find_character_index(raw_rel.get("character_b") or "")
        surface_relation = (raw_rel.get("surface_relation") or "").strip()
        if idx_a is None or idx_b is None or idx_a == idx_b or not surface_relation:
            continue
        id_a, id_b = characters[idx_a]["id"], characters[idx_b]["id"]
        rel_idx = find_relationship_index(id_a, id_b)
        if rel_idx is None:
            relationships.append({
                "id": str(uuid.uuid4()),
                "character_a_id": id_a,
                "character_b_id": id_b,
                "surface_relation": surface_relation,
                "address_notes": raw_rel.get("address_notes") or None,
            })
        else:
            relationships[rel_idx]["surface_relation"] = surface_relation
            if raw_rel.get("address_notes"):
                relationships[rel_idx]["address_notes"] = raw_rel["address_notes"]

    continuity_note = None
    raw_note = data.get("continuity_note")
    if isinstance(raw_note, dict) and (raw_note.get("text") or "").strip():
        continuity_note = {
            "id": str(uuid.uuid4()),
            "text": raw_note["text"].strip(),
            "source_label": raw_note.get("source_label") or None,
        }

    return characters, relationships, continuity_note


def delete_story(story_id: str, account_email: str) -> None:
    engine = get_engine()
    with engine.begin() as conn:
        result = conn.execute(
            _stories_table.delete().where(
                _stories_table.c.id == story_id,
                _stories_table.c.account_email == account_email,
            )
        )
        if result.rowcount == 0:
            raise StoryNotFoundError(f"No story '{story_id}' for this account")
