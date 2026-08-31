"""Backend configuration."""
from pathlib import Path
from pydantic_settings import BaseSettings
import os


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    host: str = "0.0.0.0"
    port: int = 7677
    reload: bool = False

    backend_dir: Path = Path(__file__).resolve().parent
    models_dir: Path = backend_dir / "models"
    fonts_base_dir: Path = backend_dir / "fonts"

    # Backend-specific settings
    max_image_size_mb: int = 50
    request_timeout_seconds: int = 300
    # Caps how many translation pipeline runs (single + batch combined) may
    # execute concurrently, regardless of how many requests are in flight —
    # the ML pipeline is GPU/VRAM-bound, so unbounded concurrency across
    # requests can OOM the process.
    max_concurrent_translations: int = 8

    # Off by default — a self-hosted/local backend (the normal `main.py`
    # setup) needs no account/token at all, exactly as before. Set
    # MT_REQUIRE_AUTH=true only for a centrally-hosted deployment that
    # gates /translate, /translate/batch, /suggest-instructions, and
    # /test-key behind a registered account (see backend/auth.py).
    require_auth: bool = False
    # Real Postgres, not a local file — a hosted deployment can run more
    # than one backend process/instance, which a single sqlite file can't
    # safely support. e.g. postgresql+psycopg2://user:pass@host:5432/dbname
    # — see backend/docker-compose.yml for a local Postgres to develop
    # against. Empty until set; core/accounts.py raises a clear error if
    # something calls into it before this is configured, but a normal
    # local/self-hosted backend that never touches /account/* never does.
    database_url: str = ""
    # OAuth client ID from Google Cloud Console, matched against the `aud`
    # claim Google's tokeninfo endpoint returns for a "Sign in with Google"
    # access token (endpoints/account.py:google_login). Left empty, the
    # audience check is skipped — fine for local testing, but a real hosted
    # deployment should set this so a token minted for a different app
    # can't be replayed against this backend.
    google_oauth_client_id: str = ""
    # The one account (by email, case-insensitive) allowed to manage the
    # server-wide shared LLM config (core/server_config.py) via the
    # extension's popup Owner section — see auth.py:require_admin. Empty by
    # default: /admin/* refuses everyone until the deployment operator sets
    # this. Deliberately an env var, not "whoever signs up first" (which
    # would let anyone on a public signup race to grab admin).
    admin_email: str = ""
    # Encrypts the shared LLM api_key (core/server_config.py) at rest
    # instead of storing it in Postgres in the clear — a database leak
    # alone then doesn't hand over a live, billable provider key. Any
    # string works as input (turned into a valid Fernet key via SHA-256,
    # see core/server_config.py); empty by default, in which case saving
    # a shared LLM config raises a clear error rather than silently
    # storing the key unencrypted. Changing this value after a key has
    # already been saved makes that stored key undecryptable — treat it
    # like any other production secret (set once, back it up).
    secret_key: str = ""

    # CORS
    cors_origins: list[str] = [
        "chrome-extension://*",
        "moz-extension://*",
        "http://localhost",
        "http://localhost:7677",
        "http://127.0.0.1",
        "http://127.0.0.1:7677",
        "http://192.168.1.231",
        "http://192.168.1.231:7677",
    ]

    class Config:
        env_prefix = "MT_"
        extra = "ignore"
        # Optional convenience: a backend/.env file (gitignored, see
        # .env.example for the hosted-mode variables) is read the same as
        # real shell-exported env vars. Real env vars still win if both are
        # set — Settings reads process env first, only falling back to the
        # file for anything unset there.
        env_file = ".env"
        env_file_encoding = "utf-8"


settings = Settings()

# Ensure required directories exist
settings.models_dir.mkdir(parents=True, exist_ok=True)
settings.fonts_base_dir.mkdir(parents=True, exist_ok=True)
os.environ.setdefault("MT_MODELS_DIR", str(settings.models_dir))
