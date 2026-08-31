"""Shared SQLAlchemy engine/metadata for the hosted-mode database
(core/accounts.py, core/server_config.py) — only ever touched when
MT_REQUIRE_AUTH is on. A normal local/self-hosted backend never imports
anything that calls get_engine().

Requires config.py's `database_url` (env MT_DATABASE_URL) to be set, e.g.
postgresql+psycopg2://user:password@host:5432/manga_translator — see
backend/docker-compose.yml for a local Postgres to develop/test against.
"""
from __future__ import annotations

from typing import Optional

import sqlalchemy as sa
from sqlalchemy.engine import Engine

from config import settings


class DatabaseNotConfiguredError(Exception):
    """Raised when MT_DATABASE_URL isn't set. The hosted-account system is
    entirely optional for a local/self-hosted backend — this only ever
    fires if something calls into it without configuring it."""


# One shared MetaData so every hosted-mode table (accounts,
# server_llm_config, ...) gets created together by a single create_all().
metadata = sa.MetaData()

_engine: Optional[Engine] = None


def get_engine() -> Engine:
    global _engine
    if not settings.database_url:
        raise DatabaseNotConfiguredError(
            "MT_DATABASE_URL is not set — the hosted account system needs a "
            "real database configured (see backend/docker-compose.yml for local dev)."
        )
    if _engine is None:
        _engine = sa.create_engine(settings.database_url, pool_pre_ping=True)
        metadata.create_all(_engine)
    return _engine
