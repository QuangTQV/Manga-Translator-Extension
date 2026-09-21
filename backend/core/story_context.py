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
