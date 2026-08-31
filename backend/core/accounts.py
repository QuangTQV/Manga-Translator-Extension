"""Account store for a centrally-hosted deployment (MT_REQUIRE_AUTH=true) —
backed by a real Postgres database via SQLAlchemy, not a local file. Not
used at all by the normal local/self-hosted setup.

Requires config.py's `database_url` (env MT_DATABASE_URL) to be set, e.g.
postgresql+psycopg2://user:password@host:5432/manga_translator — see
backend/docker-compose.yml for a local Postgres to develop/test against.
Every function here lazily connects on first use and raises
DatabaseNotConfiguredError if database_url is empty, so a normal local
backend that never touches /account/* is completely unaffected.

Deliberately plain SQLAlchemy Core (no ORM, no migration framework): this
is a starting point for a hosted deployment to build real billing on top
of (a Stripe webhook would call `set_plan()` on successful payment/
cancellation), not a production billing system by itself. `register_account`
/`set_plan` do no email verification or payment processing.

Bearer tokens are stored as a SHA-256 hash (`token_hash`), never in the
clear — the raw value only ever exists transiently: generated here,
returned once to the caller (register/find_or_create/rotate), and never
persisted or logged. A Postgres dump/leak on its own can't be replayed as
a working credential the way a plaintext token column could. `email` is
the account's stable identity/primary key (not the token) precisely so a
token can be rotated or revoked without losing the account's plan/usage
history — see revoke_token() and find_or_create_account()'s rotate-on-
login behavior.
"""
from __future__ import annotations

import hashlib
import secrets
import time
from dataclasses import dataclass
from typing import Optional

import sqlalchemy as sa

from core.db import DatabaseNotConfiguredError, get_engine, metadata

# Requests allowed per rolling PERIOD_SECONDS window, per plan. A real
# deployment would likely make this configurable per-account (e.g. metered
# add-ons) rather than a fixed two-tier table, but this is enough to
# demonstrate the gate working end-to-end.
PLAN_QUOTAS = {
    "free": 50,
    "paid": 100_000,  # effectively unlimited for a single account
}
DEFAULT_PLAN = "free"
PERIOD_SECONDS = 30 * 24 * 3600  # 30-day rolling usage window

# How long an issued bearer token stays valid before it stops
# authenticating (see check_and_increment_usage/get_account). A returning
# Google Sign-In always mints a fresh token (find_or_create_account rotates
# on every call), so that path never actually hits this ceiling in normal
# use. An email-only account (register_account, no Google identity) has no
# other way to get a new token once its one token expires or is revoked —
# same "no verification, no login-by-email flow" limitation /register
# already documents; a real deployment would want a proper login flow
# (magic link, password, etc.) alongside this.
TOKEN_TTL_SECONDS = 180 * 24 * 3600  # 180 days


class QuotaExceededError(Exception):
    """Raised by check_and_increment_usage() when an account has used up
    its plan's request quota for the current period."""


class AccountNotFoundError(Exception):
    """Raised when a token doesn't match any registered account, or no
    longer does (expired, revoked)."""


class AccountExistsError(Exception):
    """Raised by register_account() when the email is already registered."""


@dataclass
class Account:
    email: str
    plan: str
    usage_count: int
    period_start: float
    # The raw bearer token — only ever populated on the object returned by
    # register_account()/find_or_create_account()/rotate_token(), i.e. the
    # one moment the raw value exists. Rows loaded back from storage
    # (get_account, check_and_increment_usage, set_plan) never have this:
    # only the hash is stored, so there's nothing to reconstruct it from.
    token: Optional[str] = None

    @property
    def quota(self) -> int:
        return PLAN_QUOTAS.get(self.plan, PLAN_QUOTAS[DEFAULT_PLAN])


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


_accounts_table = sa.Table(
    "accounts",
    metadata,
    sa.Column("email", sa.String(320), primary_key=True),
    sa.Column("token_hash", sa.String(64), unique=True, nullable=True),
    sa.Column("token_expires_at", sa.Float, nullable=True),
    sa.Column("plan", sa.String(32), nullable=False, server_default=DEFAULT_PLAN),
    sa.Column("usage_count", sa.Integer, nullable=False, server_default="0"),
    sa.Column("period_start", sa.Float, nullable=False),
)


class SchemaMismatchError(Exception):
    """Raised by ensure_schema() when a table named `accounts` already
    exists but doesn't have the columns this code expects — e.g. left
    over from something else, or an older/incompatible version of this
    schema. create_all() only checks whether the table *name* exists, not
    its shape, so without this check a mismatched table would pass
    startup silently and only blow up on the first real request."""


def ensure_schema() -> None:
    """Connects, creates the accounts table if it doesn't exist yet, and
    validates its shape if it did — called eagerly at server startup
    (main.py) when MT_REQUIRE_AUTH is on, so a misconfigured/unreachable
    MT_DATABASE_URL *or* an incompatible pre-existing `accounts` table
    fails loudly at boot instead of surprising the first real user to hit
    /account/register. Otherwise this table only gets created lazily, on
    whichever account-related call happens to run first — get_engine()
    already does that; this just triggers it on purpose, ahead of any
    real traffic, plus the shape check create_all() alone doesn't do."""
    engine = get_engine()
    with engine.connect() as conn:
        try:
            conn.execute(sa.select(_accounts_table).limit(0))
        except sa.exc.DBAPIError as e:
            raise SchemaMismatchError(
                "A table named 'accounts' already exists in this database "
                "but doesn't match the expected columns "
                "(email, token_hash, token_expires_at, plan, usage_count, "
                f"period_start): {e}"
            ) from e


def _row_to_account(row) -> Account:
    return Account(
        email=row.email, plan=row.plan,
        usage_count=row.usage_count, period_start=row.period_start,
    )


def _issue_token() -> tuple[str, str, float]:
    token = secrets.token_urlsafe(32)
    return token, _hash_token(token), time.time() + TOKEN_TTL_SECONDS


def register_account(email: str) -> Account:
    email = email.strip().lower()
    if not email or "@" not in email:
        raise ValueError("A valid email is required")
    engine = get_engine()
    with engine.begin() as conn:
        existing = conn.execute(
            sa.select(_accounts_table.c.email).where(_accounts_table.c.email == email)
        ).first()
        if existing:
            raise AccountExistsError(f"An account already exists for {email}")
        token, token_hash, expires_at = _issue_token()
        now = time.time()
        conn.execute(_accounts_table.insert().values(
            email=email, token_hash=token_hash, token_expires_at=expires_at,
            plan=DEFAULT_PLAN, usage_count=0, period_start=now,
        ))
        return Account(token=token, email=email, plan=DEFAULT_PLAN, usage_count=0, period_start=now)


def find_or_create_account(email: str) -> Account:
    """Like register_account(), but for identity-provider logins (Google
    Sign-In) rather than a fresh signup form: a returning user re-logging
    in should get their existing account back, not an error. Verifying the
    email actually belongs to the caller (the Google token's email_verified
    claim) is the caller's job — this trusts whatever email it's given.

    Always mints a fresh token (rotates it if one already existed) rather
    than reusing whatever's currently stored — each explicit "Sign in with
    Google" is a new login event, and rotating here is also what lets a
    user regain access after calling revoke_token() on a leaked/logged-out
    token: this doesn't care whether the old one was still valid."""
    email = email.strip().lower()
    if not email or "@" not in email:
        raise ValueError("A valid email is required")
    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            sa.select(_accounts_table).where(_accounts_table.c.email == email)
        ).first()
        token, token_hash, expires_at = _issue_token()
        if row:
            conn.execute(
                _accounts_table.update().where(_accounts_table.c.email == email)
                .values(token_hash=token_hash, token_expires_at=expires_at)
            )
            account = _row_to_account(row)
            account.token = token
            return account
        now = time.time()
        conn.execute(_accounts_table.insert().values(
            email=email, token_hash=token_hash, token_expires_at=expires_at,
            plan=DEFAULT_PLAN, usage_count=0, period_start=now,
        ))
        return Account(token=token, email=email, plan=DEFAULT_PLAN, usage_count=0, period_start=now)


def _find_row_by_token(conn, token: str, for_update: bool = False):
    token_hash = _hash_token(token)
    query = sa.select(_accounts_table).where(_accounts_table.c.token_hash == token_hash)
    if for_update:
        query = query.with_for_update()
    row = conn.execute(query).first()
    if row is None:
        return None
    if row.token_expires_at is not None and time.time() > row.token_expires_at:
        return None
    return row


def get_account(token: str) -> Optional[Account]:
    engine = get_engine()
    with engine.connect() as conn:
        row = _find_row_by_token(conn, token)
        return _row_to_account(row) if row else None


def revoke_token(token: str) -> None:
    """Invalidates the given token immediately (self-serve "log out this
    device" / a token that may have leaked) — clears token_hash/
    token_expires_at so it can never authenticate again, while leaving the
    account's email/plan/usage history intact. Only a fresh
    find_or_create_account() call (Google Sign-In) can issue that email a
    new token afterward — an email-only account has no other login
    mechanism, same limitation TOKEN_TTL_SECONDS documents."""
    engine = get_engine()
    token_hash = _hash_token(token)
    with engine.begin() as conn:
        result = conn.execute(
            _accounts_table.update().where(_accounts_table.c.token_hash == token_hash)
            .values(token_hash=None, token_expires_at=None)
        )
        if result.rowcount == 0:
            raise AccountNotFoundError("Invalid account token")


def check_and_increment_usage(token: str) -> Account:
    """Rolls the usage window over if expired, then atomically checks and
    increments — SELECT ... FOR UPDATE locks the row for the duration of
    the transaction, so two concurrent requests on the same account can't
    both read the same usage_count and both think they're still under
    quota (the exact race a plain read-then-write, or sqlite's weaker
    file-level locking, would allow under real concurrent traffic)."""
    engine = get_engine()
    with engine.begin() as conn:
        row = _find_row_by_token(conn, token, for_update=True)
        if not row:
            raise AccountNotFoundError("Invalid account token")
        account = _row_to_account(row)

        now = time.time()
        if now - account.period_start > PERIOD_SECONDS:
            account.usage_count = 0
            account.period_start = now

        if account.usage_count >= account.quota:
            conn.execute(
                _accounts_table.update().where(_accounts_table.c.email == account.email)
                .values(period_start=account.period_start)
            )
            raise QuotaExceededError(
                f"Usage quota exceeded for the '{account.plan}' plan "
                f"({account.quota} requests per {PERIOD_SECONDS // 86400}-day period)"
            )

        account.usage_count += 1
        conn.execute(
            _accounts_table.update().where(_accounts_table.c.email == account.email)
            .values(usage_count=account.usage_count, period_start=account.period_start)
        )
        return account


def set_plan(token: str, plan: str) -> Account:
    """Sets an account's plan directly — stand-in for what a real payment
    webhook (Stripe checkout completed / subscription cancelled) would call.
    No payment is verified here."""
    if plan not in PLAN_QUOTAS:
        raise ValueError(f"Unknown plan '{plan}' — must be one of {sorted(PLAN_QUOTAS)}")
    engine = get_engine()
    with engine.begin() as conn:
        row = _find_row_by_token(conn, token)
        if not row:
            raise AccountNotFoundError("Invalid account token")
        conn.execute(
            _accounts_table.update().where(_accounts_table.c.email == row.email).values(plan=plan)
        )
        updated = conn.execute(
            sa.select(_accounts_table).where(_accounts_table.c.email == row.email)
        ).first()
        return _row_to_account(updated)
