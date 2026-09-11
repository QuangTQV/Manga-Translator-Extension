"""Server-wide default LLM config for a centrally-hosted deployment
(MT_REQUIRE_AUTH=true) — lets the operator (identified by MT_ADMIN_EMAIL,
see auth.py:require_admin) configure the provider/model/key that applies
to every authenticated user's request who hasn't supplied their own key,
from the extension's popup Owner section instead of editing env vars and
redeploying. Not used at all by the normal local/self-hosted setup.

A single row (id=1) — this is one shared config for the whole deployment,
not per-account. Plain SQLAlchemy Core, same as core/accounts.py.
"""
from __future__ import annotations

import base64
import hashlib
from dataclasses import dataclass
from typing import Optional

import sqlalchemy as sa
from cryptography.fernet import Fernet, InvalidToken

from config import settings
from core.db import get_engine, metadata

_SINGLETON_ID = 1


class SecretKeyNotConfiguredError(Exception):
    """Raised by set_shared_llm_config() when saving a non-empty api_key
    but config.py's secret_key (env MT_SECRET_KEY) isn't set — refuses to
    store the key unencrypted rather than silently doing so."""


class SecretKeyMismatchError(Exception):
    """Raised when a stored, encrypted api_key can't be decrypted with the
    currently configured secret_key — almost always means MT_SECRET_KEY
    changed after the key was saved. Re-saving the Owner LLM config (with
    the new secret_key already in place) fixes it."""


def _fernet() -> Fernet:
    if not settings.secret_key:
        raise SecretKeyNotConfiguredError(
            "MT_SECRET_KEY must be set to store the shared LLM api_key encrypted"
        )
    # Fernet needs a 32-byte urlsafe-base64 key; derive one deterministically
    # from whatever string the operator set MT_SECRET_KEY to, rather than
    # requiring them to generate/paste a Fernet-formatted key themselves.
    key_bytes = hashlib.sha256(settings.secret_key.encode("utf-8")).digest()
    return Fernet(base64.urlsafe_b64encode(key_bytes))


def _encrypt(plaintext: str) -> str:
    return _fernet().encrypt(plaintext.encode("utf-8")).decode("ascii")


def _decrypt(ciphertext: str) -> str:
    try:
        return _fernet().decrypt(ciphertext.encode("ascii")).decode("utf-8")
    except InvalidToken as e:
        raise SecretKeyMismatchError(
            "Stored shared LLM api_key could not be decrypted — MT_SECRET_KEY "
            "may have changed since it was saved. Re-save the Owner LLM config."
        ) from e

_server_config_table = sa.Table(
    "server_llm_config",
    metadata,
    sa.Column("id", sa.Integer, primary_key=True),
    sa.Column("provider", sa.String(64), nullable=False),
    sa.Column("model_name", sa.String(256), nullable=True),
    # Text, not a bounded varchar: this stores the Fernet-encrypted
    # ciphertext (see _encrypt), which runs noticeably longer than the
    # plaintext key it wraps.
    sa.Column("api_key", sa.Text, nullable=True),
    sa.Column("base_url", sa.String(512), nullable=True),
)


class SchemaMismatchError(Exception):
    """See core/accounts.py's SchemaMismatchError — same reasoning, this
    table's own version of the same check."""


@dataclass
class SharedLlmConfig:
    provider: str
    model_name: Optional[str]
    api_key: Optional[str]
    base_url: Optional[str]


def ensure_schema() -> None:
    """Creates server_llm_config if missing, validates its shape if it
    already existed — called eagerly at server startup alongside
    core/accounts.py:ensure_schema() (see main.py's lifespan)."""
    engine = get_engine()
    with engine.connect() as conn:
        try:
            conn.execute(sa.select(_server_config_table).limit(0))
        except sa.exc.DBAPIError as e:
            raise SchemaMismatchError(
                "A table named 'server_llm_config' already exists in this "
                "database but doesn't match the expected columns "
                f"(id, provider, model_name, api_key, base_url): {e}"
            ) from e


def _row_to_config(row) -> SharedLlmConfig:
    return SharedLlmConfig(
        provider=row.provider, model_name=row.model_name,
        api_key=_decrypt(row.api_key) if row.api_key else None,
        base_url=row.base_url,
    )


def get_shared_llm_config() -> Optional[SharedLlmConfig]:
    """None means the operator hasn't configured anything yet — callers
    should fall back to whatever they'd otherwise do (e.g. the static
    provider env vars core/config.py already falls back to)."""
    engine = get_engine()
    with engine.connect() as conn:
        row = conn.execute(
            sa.select(_server_config_table).where(_server_config_table.c.id == _SINGLETON_ID)
        ).first()
        return _row_to_config(row) if row else None


def set_shared_llm_config(
    provider: str,
    model_name: Optional[str],
    api_key: Optional[str],
    base_url: Optional[str],
) -> SharedLlmConfig:
    if not provider:
        raise ValueError("provider is required")
    stored_api_key = _encrypt(api_key) if api_key else None
    engine = get_engine()
    with engine.begin() as conn:
        existing = conn.execute(
            sa.select(_server_config_table.c.id).where(_server_config_table.c.id == _SINGLETON_ID)
        ).first()
        values = dict(provider=provider, model_name=model_name, api_key=stored_api_key, base_url=base_url)
        if existing:
            conn.execute(
                _server_config_table.update()
                .where(_server_config_table.c.id == _SINGLETON_ID)
                .values(**values)
            )
        else:
            conn.execute(_server_config_table.insert().values(id=_SINGLETON_ID, **values))
    return SharedLlmConfig(provider=provider, model_name=model_name, api_key=api_key, base_url=base_url)
