"""core/accounts.py — the account store backing a centrally-hosted
deployment (MT_REQUIRE_AUTH=true), backed by a real Postgres via
SQLAlchemy. Irrelevant to the normal local/self-hosted setup, which never
touches this module.

Needs a real Postgres reachable at MT_DATABASE_URL — skipped entirely
otherwise (see backend/docker-compose.yml for a local one), so the default
`pytest` run stays fast/dependency-free for everyone who isn't touching
the hosted-account feature.
"""
import os

import pytest

pytestmark = pytest.mark.skipif(
    not os.environ.get("MT_DATABASE_URL"),
    reason="MT_DATABASE_URL not set — see backend/docker-compose.yml for a local Postgres",
)

import sqlalchemy as sa  # noqa: E402

from core.accounts import (  # noqa: E402
    PERIOD_SECONDS,
    AccountExistsError,
    AccountNotFoundError,
    QuotaExceededError,
    SchemaMismatchError,
    _accounts_table,
    check_and_increment_usage,
    ensure_schema,
    get_account,
    register_account,
    set_plan,
)
from core.db import get_engine  # noqa: E402


@pytest.fixture(autouse=True)
def _clean_accounts_table():
    """Every test starts against an empty accounts table — cheaper than
    dropping/recreating the schema per test, and email uniqueness matters
    to several of these tests."""
    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(_accounts_table.delete())
    yield


def test_register_account_returns_a_free_plan_token():
    account = register_account("Alice@Example.com")
    assert account.plan == "free"
    assert account.usage_count == 0
    assert account.token
    # Email is normalized (trimmed/lowercased) for lookup consistency.
    assert account.email == "alice@example.com"


def test_register_duplicate_email_raises():
    register_account("alice@example.com")
    with pytest.raises(AccountExistsError):
        register_account("alice@example.com")


def test_register_invalid_email_raises():
    with pytest.raises(ValueError):
        register_account("not-an-email")


def test_get_account_by_token_round_trips():
    registered = register_account("bob@example.com")
    fetched = get_account(registered.token)
    assert fetched is not None
    assert fetched.email == "bob@example.com"


def test_get_account_unknown_token_returns_none():
    assert get_account("this-token-does-not-exist") is None


def test_check_and_increment_usage_counts_up():
    account = register_account("carol@example.com")
    updated = check_and_increment_usage(account.token)
    assert updated.usage_count == 1
    updated = check_and_increment_usage(account.token)
    assert updated.usage_count == 2


def test_check_and_increment_usage_unknown_token_raises():
    with pytest.raises(AccountNotFoundError):
        check_and_increment_usage("nope")


def test_free_plan_quota_is_enforced():
    account = register_account("dave@example.com")
    for _ in range(account.quota):
        check_and_increment_usage(account.token)
    with pytest.raises(QuotaExceededError):
        check_and_increment_usage(account.token)


def test_usage_window_resets_after_the_period_elapses():
    account = register_account("erin@example.com")
    check_and_increment_usage(account.token)
    assert get_account(account.token).usage_count == 1

    # Simulate the 30-day window having elapsed by backdating period_start
    # directly in storage, rather than reaching into time.time() mocking —
    # exercises the same "now - period_start > PERIOD_SECONDS" branch a
    # real elapsed month would.
    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(
            _accounts_table.update().where(_accounts_table.c.token == account.token)
            .values(period_start=_accounts_table.c.period_start - (PERIOD_SECONDS + 1))
        )

    updated = check_and_increment_usage(account.token)
    assert updated.usage_count == 1  # rolled over, not 2


def test_set_plan_changes_quota():
    account = register_account("frank@example.com")
    assert account.quota == 50  # free plan default
    upgraded = set_plan(account.token, "paid")
    assert upgraded.plan == "paid"
    assert upgraded.quota > account.quota


def test_set_plan_unknown_plan_raises():
    account = register_account("grace@example.com")
    with pytest.raises(ValueError):
        set_plan(account.token, "ultra-mega-plan")


def test_set_plan_unknown_token_raises():
    with pytest.raises(AccountNotFoundError):
        set_plan("nope", "paid")


def test_check_and_increment_usage_locks_the_row_against_concurrent_increments():
    """SELECT ... FOR UPDATE should serialize two concurrent increments on
    the same account so neither reads a stale usage_count — the exact race
    a plain read-then-write (or sqlite's weaker file-level locking) would
    allow under real concurrent traffic."""
    import threading

    account = register_account("concurrent@example.com")
    errors = []

    def bump():
        try:
            check_and_increment_usage(account.token)
        except Exception as e:  # pragma: no cover - surfaced via errors list
            errors.append(e)

    threads = [threading.Thread(target=bump) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert not errors
    assert get_account(account.token).usage_count == 10


def test_ensure_schema_rejects_a_pre_existing_incompatible_accounts_table():
    """create_all() only checks whether a table named 'accounts' exists,
    not its columns — without an explicit shape check, a leftover/foreign
    table with that name would pass startup silently and only blow up on
    the first real request. ensure_schema() must catch this at startup."""
    engine = get_engine()
    with engine.begin() as conn:
        conn.execute(sa.text("DROP TABLE accounts"))
        conn.execute(sa.text("CREATE TABLE accounts (id serial primary key, username text)"))
    try:
        with pytest.raises(SchemaMismatchError):
            ensure_schema()
    finally:
        # Restore the real schema so later tests (and this file's own
        # autouse cleanup fixture) aren't left pointing at the bad table.
        with engine.begin() as conn:
            conn.execute(sa.text("DROP TABLE accounts"))
        _accounts_table.metadata.create_all(engine)
