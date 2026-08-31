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
"""
from __future__ import annotations

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


class QuotaExceededError(Exception):
    """Raised by check_and_increment_usage() when an account has used up
    its plan's request quota for the current period."""


class AccountNotFoundError(Exception):
    """Raised when a token doesn't match any registered account."""


class AccountExistsError(Exception):
    """Raised by register_account() when the email is already registered."""


@dataclass
class Account:
    token: str
    email: str
    plan: str
    usage_count: int
    period_start: float

    @property
    def quota(self) -> int:
        return PLAN_QUOTAS.get(self.plan, PLAN_QUOTAS[DEFAULT_PLAN])


_accounts_table = sa.Table(
    "accounts",
    metadata,
    sa.Column("token", sa.String(64), primary_key=True),
    sa.Column("email", sa.String(320), unique=True, nullable=False),
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
                f"(token, email, plan, usage_count, period_start): {e}"
            ) from e


def _row_to_account(row) -> Account:
    return Account(
        token=row.token, email=row.email, plan=row.plan,
        usage_count=row.usage_count, period_start=row.period_start,
    )


def register_account(email: str) -> Account:
    email = email.strip().lower()
    if not email or "@" not in email:
        raise ValueError("A valid email is required")
    engine = get_engine()
    with engine.begin() as conn:
        existing = conn.execute(
            sa.select(_accounts_table.c.token).where(_accounts_table.c.email == email)
        ).first()
        if existing:
            raise AccountExistsError(f"An account already exists for {email}")
        token = secrets.token_urlsafe(32)
        now = time.time()
        conn.execute(_accounts_table.insert().values(
            token=token, email=email, plan=DEFAULT_PLAN, usage_count=0, period_start=now,
        ))
        return Account(token=token, email=email, plan=DEFAULT_PLAN, usage_count=0, period_start=now)


def find_or_create_account(email: str) -> Account:
    """Like register_account(), but for identity-provider logins (Google
    Sign-In) rather than a fresh signup form: a returning user re-logging
    in should get their existing account back, not an error. Verifying the
    email actually belongs to the caller (the Google token's email_verified
    claim) is the caller's job — this trusts whatever email it's given."""
    email = email.strip().lower()
    if not email or "@" not in email:
        raise ValueError("A valid email is required")
    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            sa.select(_accounts_table).where(_accounts_table.c.email == email)
        ).first()
        if row:
            return _row_to_account(row)
        token = secrets.token_urlsafe(32)
        now = time.time()
        conn.execute(_accounts_table.insert().values(
            token=token, email=email, plan=DEFAULT_PLAN, usage_count=0, period_start=now,
        ))
        return Account(token=token, email=email, plan=DEFAULT_PLAN, usage_count=0, period_start=now)


def get_account(token: str) -> Optional[Account]:
    engine = get_engine()
    with engine.connect() as conn:
        row = conn.execute(
            sa.select(_accounts_table).where(_accounts_table.c.token == token)
        ).first()
        return _row_to_account(row) if row else None


def check_and_increment_usage(token: str) -> Account:
    """Rolls the usage window over if expired, then atomically checks and
    increments — SELECT ... FOR UPDATE locks the row for the duration of
    the transaction, so two concurrent requests on the same account can't
    both read the same usage_count and both think they're still under
    quota (the exact race a plain read-then-write, or sqlite's weaker
    file-level locking, would allow under real concurrent traffic)."""
    engine = get_engine()
    with engine.begin() as conn:
        row = conn.execute(
            sa.select(_accounts_table).where(_accounts_table.c.token == token).with_for_update()
        ).first()
        if not row:
            raise AccountNotFoundError("Invalid account token")
        account = _row_to_account(row)

        now = time.time()
        if now - account.period_start > PERIOD_SECONDS:
            account.usage_count = 0
            account.period_start = now

        if account.usage_count >= account.quota:
            conn.execute(
                _accounts_table.update().where(_accounts_table.c.token == token)
                .values(period_start=account.period_start)
            )
            raise QuotaExceededError(
                f"Usage quota exceeded for the '{account.plan}' plan "
                f"({account.quota} requests per {PERIOD_SECONDS // 86400}-day period)"
            )

        account.usage_count += 1
        conn.execute(
            _accounts_table.update().where(_accounts_table.c.token == token)
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
        existing = conn.execute(
            sa.select(_accounts_table.c.token).where(_accounts_table.c.token == token)
        ).first()
        if not existing:
            raise AccountNotFoundError("Invalid account token")
        conn.execute(
            _accounts_table.update().where(_accounts_table.c.token == token).values(plan=plan)
        )
    account = get_account(token)
    assert account is not None
    return account
