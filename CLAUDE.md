# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project overview

MangaTranslator Extension is a two-part, bring-your-own-LLM manga/comic translator:

- `backend/` — a local FastAPI service that runs the detection/cleaning/translation/rendering ML pipeline and calls whatever LLM provider the user configured (Google, OpenAI, Azure OpenAI, Anthropic, xAI, DeepSeek, Z.ai, Moonshot AI, OpenRouter, or any OpenAI-compatible endpoint).
- `extension/` — a Manifest V3 Chrome/Edge extension (TypeScript, no framework) that scans manga pages in the browser, sends crops to the local backend, and renders translated text back into the image.

The two halves only talk over HTTP (default `http://localhost:7677`) — there is no shared build step or shared code between them.

## Commands

### Backend (Python, `backend/`)

```bash
# one-time setup
cd backend
python3 -m venv .venv
./.venv/bin/pip install -e .

# run the server (listens on 0.0.0.0:7677; auto-downloads ML weights from
# public Hugging Face repos into backend/models/ on first run/first use — no
# manual model download needed except the optional Flux inpainting model)
./.venv/bin/python main.py

# health check
curl http://localhost:7677/health

# syntax-check a single file (quick sanity check, not a substitute for tests)
./.venv/bin/python -m py_compile pipeline/wrapper.py

# unit tests (backend/tests/) — pure config/rotation/HTTP-error logic with
# the HTTP layer mocked out; no ML models or network needed. Install once
# with `./.venv/bin/pip install -e ".[dev]"`. The hosted-account tests
# (test_accounts.py, test_auth_gate.py's account cases, test_google_login.py)
# additionally need MT_DATABASE_URL pointing at a real Postgres — see
# backend/docker-compose.yml — and skip themselves cleanly if it's unset.
./.venv/bin/pip install -e ".[dev]"
./.venv/bin/python -m pytest
./.venv/bin/python -m pytest tests/test_rotation.py -k weighted_random  # single test
```

Docker alternative (backend only, built from repo root so it can `COPY backend /app/backend`): `docker build -t manga-translator-backend .`

### Extension (TypeScript, `extension/`)

```bash
cd extension
npm install
npm run build     # tsc (typecheck) + vite build -> extension/dist/
npm run dev        # vite dev server
```

Load unpacked at `chrome://extensions/` → Developer mode → Load unpacked → select `extension/dist/`.

`npm run lint` (ESLint, flat config in `eslint.config.js`) and `npm run build` (`tsc` typecheck + Vite build) are both real verification steps — run both before considering a change done.

End-to-end tests (Playwright, `extension/tests/`) load the actual built extension into a real Chromium persistent context — they cover popup settings persistence, provider-group rotation config, the in-page Scanner UI (which lives in a closed shadow root, so tests drive it via raw CDP — see `tests/shadow-dom.ts`), and the auto-translate page overlay (in-progress/retry badges, click-to-fix, hover-to-magnify).

```bash
npm test   # runs `npm run build` first, then the full Playwright suite
npx playwright test tests/popup.spec.ts   # a single spec file
```

Two recurring gotchas when writing overlay tests:
- The 4-page `fixtures/test-site/` fixture auto-translates all pages concurrently, so a `.first()`-based locator can resolve to whichever page's bubble happened to finish first — non-deterministic. Use the single-image `fixtures/test-site-single/` fixture for anything that needs one specific, predictable bubble.
- `page.screenshot()` (including `.locator().screenshot()`) can fail to visually capture `position:fixed` elements that are 100% confirmed correct via `getComputedStyle`/`getBoundingClientRect`/`elementFromPoint`. Verify fixed-position UI (magnifier, badges, popovers) with DOM/geometry assertions, not screenshot pixel content.

## Architecture

### Backend request flow

`main.py` mounts `endpoints/translate.py` (the translate/suggest/test-key routes) and `endpoints/account.py` (hosted-mode account management — see "Hosted/account mode" below). Each `/translate` (or `/translate/batch`) request flows:

1. `endpoints/translate.py` → `pipeline/wrapper.py:_build_config()` turns the flat request fields into a `MangaTranslatorConfig` (dataclasses defined in `core/config.py`: `DetectionConfig`, `CleaningConfig`, `TranslationConfig`, `RenderingConfig`, `OutputConfig`, `OutsideTextConfig`, `PreprocessingConfig`).
2. `pipeline/wrapper.py:translate_image_base64()` → `core/pipeline.py:translate_and_render()`, which runs detect → clean → translate → render in sequence (bubble/panel detection in `core/image/`, OCR+translation dispatch in `core/services/translation.py`, text layout/drawing in `core/text/`).
3. `core/services/translation.py` builds a provider-specific generation config and dispatches to the matching function in `utils/endpoints/<provider>.py` (one HTTP-calling module per LLM provider, e.g. `openai.py`, `anthropic.py`, `azure_openai.py`, `openai_compatible.py`, `openrouter.py`, ...).
4. ML weights (YOLO bubble/panel detectors, manga-ocr, upscalers) are lazily fetched by `core/ml/model_manager.py` from public Hugging Face repos the first time they're needed — there's no bundled model directory to restore for normal (non-Flux) operation.

### Adding/editing an LLM provider

Provider support is intentionally duplicated across several files rather than abstracted — when adding or changing a provider, keep these in sync:

- `backend/utils/endpoints/<provider>.py` — the HTTP call implementation, exported from `backend/utils/endpoints/__init__.py`.
- `backend/core/config.py` — API key/endpoint fields on `TranslationConfig`, plus env var fallback in `__post_init__`.
- `backend/core/llm_defaults.py` — default temperature/top_p/top_k for the provider.
- `backend/utils/model_metadata.py` — model-name-based capability checks (reasoning models, max-token caps, etc.) used across providers.
- `backend/core/services/translation.py` — three separate `provider ==` branches: the is-reasoning check, `_build_generation_config()`, and `_call_llm_endpoint()`.
- `backend/pipeline/wrapper.py` — `_inject_api_keys()` mapping, `_get_default_model()`, and any URL/deployment-name parsing needed in `_build_config()`.
- `backend/endpoints/translate.py` — the `/providers` list.
- `extension/src/shared/types.ts` — the `PROVIDERS` const array.
- `extension/src/popup/index.html` — the `<option>` in the provider `<select>`.

### Text rendering (`backend/core/text/`)

`layout_engine.py` binary-searches font size (largest that fits the bubble's mask-derived safe area, falling back to the smallest size with the height limit ignored rather than dropping text) and wraps lines with a Knuth-Plass-style DP breaker (`text_processing.py:find_optimal_breaks_dp`). `drawing_engine.py` then draws each line via Skia. The LLM is told to mark emphasis with markdown-style markers (`*italic*`, `**bold**`, `***bold-italic***`); `text_processing.py:parse_styled_segments`/`tokenize_styled_text` resolve these — including markers nested inside one another (e.g. `**bold *and italic* bold**`, which an LLM will sometimes write instead of the explicit `***...***`) — to a single combined style before wrapping, so a marker pair can never be split across a line break. Keep this resolution recursive/nesting-aware if you touch it — a flat single-pass version will leak literal `*` characters into the rendered image whenever nesting occurs. Each bubble's text is also rendered at `supersampling_factor`× resolution then LANCZOS-downscaled to the bubble's native size (`text_renderer.py:render_text_skia`) — the sharper pre-downscale bitmap is what backs the extension's hover-to-magnify crop (`BubbleInfo.high_res_crop`) when `supersampling_factor > 1`.

### Hosted/account mode (`backend/auth.py`, `backend/core/accounts.py`, `backend/endpoints/account.py`)

Off by default (`require_auth: bool = False` in `config.py`, env `MT_REQUIRE_AUTH`) — the normal local/self-hosted `main.py` setup needs no account/token/database at all, and nothing here changes its behavior. Set `MT_REQUIRE_AUTH=true` only for a centrally-hosted deployment: `auth.py:verify_token` (a `Depends()` on `/translate`, `/translate/batch`, `/suggest-instructions`, `/test-key`) then requires a valid `Authorization: Bearer <token>` and enforces that account's plan quota via `core/accounts.py` (SQLAlchemy Core against a real Postgres — `config.py`'s `database_url`, env `MT_DATABASE_URL`; `backend/docker-compose.yml` runs one locally; no ORM/migration framework, a starting point for a hosted deployment to build real billing on top of — `POST /account/plan` is a stand-in for what a payment webhook would call, not a real payment integration). `check_and_increment_usage()` takes a `SELECT ... FOR UPDATE` row lock so concurrent requests on the same account can't both read a stale `usage_count` and both slip past quota — the reason this needs a real database rather than sqlite's weaker file-level locking, since a hosted deployment can also run more than one backend process/instance against the same database. `/health` and `/providers` are never gated. Extension-side: the popup's Account tab (`accountToken`/`accountEmail` in `AppSettings`) is the only thing that ever populates these fields — `background/index.ts:authHeaders()` attaches the header on every translate/suggest/test-key fetch only when `accountToken` is set, so a user who never touches that tab sees zero behavior change.

Bearer tokens are never stored in the clear — `accounts.token_hash` holds `sha256(token)`, and `email` (not the token) is the row's primary key, so a token can be rotated or revoked without losing the account's plan/usage history. The raw token exists only transiently: generated and returned once by `register_account()`/`find_or_create_account()`, never persisted or logged. Each token also carries a `token_expires_at` (`TOKEN_TTL_SECONDS`, 180 days from issuance); `find_or_create_account()` (Google Sign-In) mints a fresh token — and a fresh expiry — on every call rather than reusing whatever's stored, which is also how a user regains access after `POST /account/logout` (`core/accounts.py:revoke_token()`) clears their current token. An email-only account (`/account/register`, no Google identity) has no login mechanism besides the one token it was issued, so losing or revoking it without ever having signed in with Google is unrecoverable by the user — same "no email verification, no real login flow" limitation `register_account()`'s docstring already flags.

`main.py`'s `lifespan` calls `core/accounts.py:ensure_schema()` at boot (only when `require_auth` is on) — creates the `accounts` table if missing, and separately validates its columns with a `SELECT ... LIMIT 0` if it already existed, since SQLAlchemy's `create_all()` only checks the table *name*, not its shape. Both a misconfigured/unreachable `MT_DATABASE_URL` and a pre-existing `accounts` table with the wrong columns (e.g. leftover from something else) fail loudly at startup this way, instead of surfacing as a confusing error on the first real user's `/account/register` call. `core/server_config.py:ensure_schema()` runs alongside it for the `server_llm_config` table (see "Owner shared LLM config" below), same reasoning.

Shared engine/table plumbing (`core/db.py`) is factored out of `core/accounts.py` so `core/server_config.py` can use the same Postgres connection/`MetaData` without a circular import — anything else needing this database should get its engine from `core/db.py:get_engine()`, not reach into `core/accounts.py`.

#### Owner shared LLM config (`backend/core/server_config.py`, `backend/endpoints/admin.py`)

Lets the deployment operator configure one shared provider/model/key that every authenticated hosted user's request falls back to when it doesn't carry its own `api_key` — from the extension popup's Account tab "Owner" section, instead of setting `GOOGLE_API_KEY`/etc. env vars on the server and redeploying. Gated by `auth.py:require_admin` — independent of `require_auth`, and keyed off `config.py`'s `admin_email` (env `MT_ADMIN_EMAIL`, empty by default) rather than a stored per-account flag or "first signup wins", so there's no signup race to exploit and the operator can hand off/change who's admin just by changing that one env var. `endpoints/translate.py:_apply_shared_llm_config()` is the actual override point, called at the top of all four gated routes right after `Depends(verify_token)` resolves — checks `isinstance(account, Account)` rather than `account is not None`, because a couple of existing tests (`test_fix_hint_priority.py`, `test_translate_batch_concurrency.py`) call the route functions directly instead of through a real request, which skips FastAPI dependency resolution and leaves that parameter holding the raw `Depends(...)` sentinel object instead of `None`. `GET /admin/llm-config` never echoes the real key back (`api_key_set: bool` instead) — so `POST /admin/llm-config` treats an empty/omitted `api_key` in the request as "don't touch the stored key", not "clear it", or every save that only changed e.g. the model name would silently wipe it. The stored `api_key` itself is encrypted at rest (`core/server_config.py`'s `_encrypt`/`_decrypt`, Fernet keyed off `config.py`'s `secret_key`/env `MT_SECRET_KEY`, SHA-256'd into a valid 32-byte Fernet key rather than requiring the operator to generate/paste one) — a Postgres leak alone doesn't hand over a live, billable provider key. `set_shared_llm_config()` raises `SecretKeyNotConfiguredError` if `MT_SECRET_KEY` is unset and a non-empty `api_key` is being saved, surfaced by `endpoints/admin.py` as `503`, rather than silently storing it unencrypted; `get_shared_llm_config()` raises `SecretKeyMismatchError` (surfaced as `500`) if the currently configured `MT_SECRET_KEY` can't decrypt what's stored — almost always meaning the env var changed after the key was saved. `endpoints/translate.py:_apply_shared_llm_config()` catches that mismatch and falls through with no shared override rather than 500ing every gated translate request.

`POST /account/google-login` ("Sign in with Google") verifies a `chrome.identity.getAuthToken()` access token against Google's own `tokeninfo` endpoint server-side (no `google-auth`/JWT dependency needed) and finds-or-creates the matching account by verified email — `background/index.ts:accountGoogleLogin()` races it against a 30s timeout since an invalid/placeholder `oauth2.client_id` has been observed to leave `getAuthToken` neither resolving nor rejecting. `manifest.json`'s `oauth2.client_id` ships as an obvious placeholder — a real deployment must register its own Google Cloud OAuth client (tied to the extension's published ID) before this works.

### Story DB, Live AI log, Flux remote worker (optional features)

- **Story DB** (`core/story_context.py`, `endpoints/stories.py`, `story_contexts` table): per-story character DB, relationships, glossary and optional continuity notes, injected server-side into the translate prompt from `story_id`. Login-required regardless of `MT_REQUIRE_AUTH` (`auth.py:require_login`, vs `verify_token` which is a no-op when auth is off). Continuity notes are injected only when that story's toggle is on.
  Characters can carry assets, stored inline in `characters_json` (no schema change): `avatar` (display-only, never leaves `_resolve_story_context`), `reference_images` (character sheets, sent to the model only when the request sets `story_use_reference_images`, capped at 2/character and 6/request, and only with LLM OCR since they ride along with the page images) and the relationship-map position `x`/`y`. The translation cache key hashes the story context (`core/caching.py`), so editing a glossary/character invalidates cached translations.
- **Live AI log** (`core/live_ai_log.py`, off unless `MT_LIVE_AI_LOG_ENABLED`): logs every LLM call from the single choke point `_call_llm_endpoint_impl` (text only, no image bytes); `call_type` travels via a `ContextVar`, not a parameter, because tests patch that function with fixed-arity mocks. Viewed via `GET /admin/live-ai-log` (`limit`, and `since` = only entries newer than that timestamp; the file is read backwards in chunks so polling a 20 MB log stays cheap) — and in the extension by the `extension/src/live-ai/` page, a separate Vite HTML entry (`vite.config.ts` moves every page in its list to `dist/<page>/`) opened from the popup's Config tab. The page asks the service worker (`LIVE_AI_LOG` message → `fetchLiveAiLog()`, which attaches the account token) and renders log text with `textContent` only — it holds real prompts and model output.
- **Flux remote worker** (`backend/flux_worker.py`, `core/image/inpainting.py`): only the inference step of `FluxKleinInpainter.inpaint_mask()` can run remotely (`flux_remote_base_url` + optional `flux_remote_token` -> header `X-Flux-Worker-Token`). Failure never fails the page: the region is left untouched, a module-level circuit breaker skips a dead URL for 60s, and a `warnings` code (`flux_remote_unreachable`/`flux_remote_unauthorized`) is returned in the translate response and shown as a toast by the content script. Popup `flux_klein_*_remote` values are UI-only and mapped in `content-script buildTranslateRequest()`. The content script has its own i18n tables separate from `shared/i18n.ts`.

### Story DB undo/redo

A separate history stack from unsaved-draft recovery above — that one is about surviving a *closed popup*, this is about stepping back and forth *within* one editing session. `popup/index.ts` keeps `StorySnapshot`s (name/characters/relationships/glossary/continuity notes+toggle — deliberately not the "update from description" textarea) in an undo/redo stack, reset every time a story is (re)loaded. The same `input`/`change`/`MutationObserver` triggers already wired for draft-saving also schedule a debounced (600ms) history checkpoint; rapid typing collapses into one undo step rather than one per keystroke, and a no-op edit (e.g. an empty-named character row that `collectStoryCharacters()` would drop anyway) never gets pushed since a checkpoint only commits when the snapshot actually differs from the current one. Ctrl+Z/Ctrl+Shift+Z work via a `keydown` listener scoped to `#story-content-fields`, so they don't interfere with other tabs' normal text-field undo.

### Story DB unsaved-draft recovery

A Chrome action popup is destroyed (not hidden) the moment it loses focus, so anything typed in the Story DB tab and not yet committed via Save story used to vanish silently on reopen — unlike the other tabs, which autosave every field straight to `AppSettings`. `popup/index.ts` mirrors the whole form (name/characters/relationships/glossary/continuity notes/continuity toggle + the "update from description" textarea) into `chrome.storage.local` under `mtStoryDraft:<storyId>`, debounced 500ms, restored automatically the next time that story loads (with a dismissible banner + Discard button that reloads fresh from the server) and cleared once Save story actually succeeds (or the story is deleted). A `MutationObserver` on `#story-content-fields` (not just `input`/`change` listeners) is what catches add/remove-row clicks and the relationship map's drag-to-reposition, neither of which fire ordinary form events.

### Story DB "update from a description"

`POST /stories/update-from-description` (`endpoints/stories.py`) turns a free-text note about a story development ("chapter 39, the villain turns out to be Akira's childhood friend Hina, so they switch to hostile pronouns") into a Story DB update. Stateless — takes the caller's current `characters`/`relationships` (whatever's in the popup form, saved or not) plus `description`, returns a merged result; never reads/writes the database itself. Gated by `verify_token` (like `/suggest-instructions`/`/region/translate`) rather than `require_login` like this router's other routes, since it's a one-off LLM-cost-incurring helper with no account-scoped row to protect — the Story DB tab it's called from is already login-gated in the popup regardless. `core/services/translation.py:generate_story_update()` asks the model for JSON naming characters by **name**, not id (it has no way to know this story's internal ids); `core/story_context.py:merge_story_update()` — a pure function, no I/O — resolves those names back to stable ids, updating an existing character/relationship in place (matched case-insensitively by name / by the unordered id pair) or creating a new one, and returns an optional suggested continuity note. A relationship naming a character absent from both the existing list and this update's own character list is dropped rather than creating a dangling reference. The popup only re-renders the merged characters/relationships/note into the form for review (`renderStoryCharacters`/etc., same as Story DB Import) — nothing is saved until the user clicks Save story. An `enable_web_search` flag (with `story_title` taken from the story's own name field) lets the model search the web for the story — the opposite spoiler policy from `generate_character_notes`' own web search (which stays spoiler-free for a general style guide): here tracking plot developments is the whole point, so the model is told to use whatever the description implies as the boundary (e.g. "up to chapter 39") rather than holding back reveals.

### Font settings (`GET /fonts`, popup Translate tab)

The popup's Font/Min/Max-font-size controls in the Translate tab were previously schema-only fields (`font_dir`/`max_font_size`/`min_font_size` in `TranslateOptions`, already read end-to-end by `pipeline/wrapper.py:_resolve_font_dir`) with no UI — `GET /fonts` (never gated, like `/health`/`/providers`) lists font-pack directories under `backend/fonts/` that actually contain `.ttf`/`.otf` files, and the popup's Font select is populated from it. A saved `fontDir` the live list doesn't include (backend offline, or a pack added on a different machine) is kept as an extra option instead of being silently dropped.

### Web app (`backend/webapp/index.html`, mounted at `/app`)

A plain HTML/JS companion to the browser extension for translating raw image files directly — the extension can only translate `<img>` elements already present in some webpage's DOM, so a translator working from raw scans that were never published anywhere has no way to feed them in otherwise. Served by the backend itself (`main.py` mounts `backend/webapp/` at `/app` via `StaticFiles`, skipped if the directory is missing) — same origin as the API, so no CORS setup needed, though the permissive CORS config (`allow_origins=[...] + ["*"]`) means it would also work opened directly as a `file://` page pointed at a remote backend URL. No `chrome.*` APIs, no build step — a single self-contained file (settings/state in plain JS + `localStorage`, `backend/webapp/vendor/jszip.min.js` vendored rather than a CDN, to stay usable offline). Talks to `/translate/batch` (one request handles the whole "Translate All" click, matched back to cards by the `id` field) and reuses the same index-based zero-padded CBZ-naming rule as the extension's scanner.

Deliberately **not** a port of the whole extension popup — no Story DB, no provider/key rotation, no manual region/eraser/font tools, no auto-translate, no persistence of translated pages across a reload. Just the core loop: pick files, translate, review, export. Extend this file directly (still no build step) rather than reaching for the extension's TypeScript/Vite tooling, unless the scope grows enough to justify it.

### Eraser tool (`POST /region/erase`, `extension/src/content-script/eraser-tool.ts`)

Freehand-brush cleanup for raw text/SFX a rectangular manual region can't isolate without also grabbing nearby art (curved/diagonal SFX, text hugging a character's outline). The user paints strokes in screen space; on Apply they're rasterised into a black/white mask at the target `<img>`'s natural resolution and sent with the current base image to `/region/erase`, which runs `core/manual_region.py:erase_mask()` — `cv2.inpaint` restricted to the (dilated) mask, no rectangle/border-sampling heuristic involved, unlike `clean_region()`. No LLM/`TranslateOptions` involved — it's a plain image op behind the same login/quota gate the other `/region/*` routes sit behind. Persisted as **one cumulative mask per page** (not a list of strokes) in the same `mtManualRegions` store the manual region tool uses (`region-tool.ts`'s `Store` type gained an `eraseMask` field) — a new stroke is client-side OR-merged (`mergeMasks`, canvas `globalCompositeOperation: 'lighter'`) into whatever's already saved, and `renderPage()` always re-inpaints the *whole* mask against the untouched base rather than stacking repeated inpaint passes. Applied before any box regions when composing a page (it's the "clean the raw" layer everything else sits on top of). Known limitation shared with `clean_region()`'s inpaint path: `cv2.inpaint` doesn't reconstruct a fine repeating pattern (e.g. dense hatching) through the erased area — fine for typical flat/gradient manga backgrounds, visibly smoothed-over on a busy screentone. **Gotcha found while wiring the UI:** painting/toolbar controls must attach pointer listeners to the canvas, not the full-viewport overlay layer that also contains the toolbar — a click on a toolbar button bubbles up through the layer and gets recorded as a phantom one-point stroke otherwise.

### Manual region tool (`backend/core/manual_region.py`, `backend/endpoints/regions.py`, `extension/src/content-script/region-tool.ts`)

The user drags a box on a page image; `POST /region/ocr` reads it (manga-ocr / PaddleOCR-VL / LLM per `ocr_method`), the user types a translation or `POST /region/translate` asks the LLM (Story DB + instructions included), and `POST /region/render` cleans the spot (flat border -> solid fill, busy background -> OpenCV inpaint) and draws the text with the normal layout engine. It is independent of the whole-page pipeline. Boxes are normalised 0..1. Regions are always rendered onto the page's *base* image (auto-translated page if any, else the untouched source) — never onto a previous manual result — so edit/delete is exact; re-selecting a saved region edits it. Saved per page in `chrome.storage.local` (`mtManualRegions`, http(s)/file only, 200-page cap) and re-applied after an auto-translation lands and on load. The content script is injected on demand (no manifest `content_scripts`), so saved regions reappear as soon as the extension is used on that page again. The `/region/*` routes reuse `TranslateOptions` (via `translate.py:_config_for_request`).

### Professional Translation ("Pro") controls

Per an explicit UI-placement decision, advanced/pro-translator features go into their own popup tab (`data-tab="pro"`) rather than the main Translate/LLM Config tabs, so a casual reader never sees them. Currently holds: the supersampling-factor select (was already sent end-to-end, just had no control anywhere). CBZ export (a second button next to the existing ZIP export in the scanner toolbar — always numbers pages by scan index, not the source-URL-derived names the plain ZIP export uses, since a CBZ reader pages through by filename sort order), Story DB import/export (JSON download/upload, added directly to the existing Story DB tab rather than here — that tab is already login-gated/specialized, not the main-screen clutter the decision was about), and a Bold/Italic toolbar on the manual region tool's Translation field (wraps the selection in the same markdown markers the LLM already uses, `extension/src/shared/text-style.ts:toggleStyleMarker`) are similarly kept out of the main tabs but live at their point of use instead of the Pro tab, for the same "already a specialized/contextual surface" reasoning. See MEMORY.md's roadmap section for what's still planned and the placement rule for anything added later.

### First-use model downloads and CI

`core/ml/model_manager.py` downloads weights lazily; every download goes through `core/ml/download_status.py:track_download()` so `GET /health` can report `downloads`, and the background worker's `watchModelDownloads()` (one poller per tab, only after a request has been pending ~4 s) turns that into a page toast. New download code paths should use `track_download()` too. `.github/workflows/ci.yml` runs the backend tests (against a Postgres service, no ML weights — tests that need weights skip themselves, so keep that pattern: guard on the file existing, never download in a test) and the extension lint + build; Playwright is not in CI.

### Per-page re-translate button (`content-script/index.ts:addRetranslateButton`)

A `↻` button in the right-aligned column under the MT badge / download / view-original buttons (`top: +58`; added in `applyTranslatedImage`, laid out by `syncTranslatedDecorations`, removed with the others in `resetRecycledTranslatedImage`/`removeOrphanedOverlayFor` — a new per-page decoration has to be added to all of those). `retranslatePage()` rebuilds the request from CURRENT settings, sends `bypass_translation_cache: true` (backend `TranslationConfig.bypass_translation_cache`: skip the cache *read* only, the fresh result is still written — without it a temperature-0 config is a cache hit and returns the very same translation), and only swaps the overlay in once a result arrives, so a failure changes nothing. It deliberately doesn't append to Context Memory (it would duplicate that page's note) and doesn't gate the auto-translate queue.

### Replacement dictionaries & lettering (Pro tab)

`core/text/replacements.py` parses the user's `find => replace` / `/regex/i => $1` rules (the `regex` module, not `re`, for its per-call timeout — patterns are user-supplied). **Post** rules run in `core/pipeline.py` right after `call_translation_api_batch` returns, i.e. *after* the translation cache — keep them out of the cache key so editing them doesn't discard cached LLM results. **Pre** rules change what the model is asked, so they *are* in the cache key; they rewrite OCR text exactly in two-step mode and in `/region/translate`, but in one-step mode (the only mode the extension exposes) only the literal rules are passed as a prompt section. Lettering (`RenderingConfig.uppercase/text_align/text_color_rgb/outline_color_rgb/outline_width`, request fields `lettering_*`) applies to speech bubbles and manual regions only — `pipeline.py` sets them on the per-bubble config only when `not is_outside_text`, since OSB text has its own color/outline logic.

The Story DB glossary's per-row **Enforce exactly** flag (`StoryGlossaryTermConfig.enforce/variants`) uses the same post-cache slot: `replacements.py:apply_glossary` runs after the user's post rules in `core/pipeline.py` and in `/region/translate`. It is a single alternation pass (longest match first, output never rescanned), and it can only fix text the model actually wrote — the term's own spelling or a listed variant. Its fields are deliberately stripped from the translation cache key in `core/caching.py`. The popup's **Text reading** select (Translate tab) maps to the `translation_mode`/`ocr_method` pair; a local OCR (manga-ocr/PaddleOCR-VL) forces two-step, which is what makes pre rules exact and lets text-only models work.

### LaMa inpainting (`core/image/lama_inpainter.py`)

Opt-in `inpainting_method="lama"` (not picked by `auto`, to avoid a surprise ~200MB download); the manual `/region/render` and `/region/erase` routes follow the same setting (`use_lama`). Only masked pixels are ever written back; any load/inference failure falls back to OpenCV rather than failing the request.

### Manual bubble editing (move/delete a detected bubble's box)

Reuses the manual region tool rather than a new mechanism: `core/manual_region.py:restore_regions()` pastes the real pre-translation pixels (from a `source_image` the client sends) back over a box — exact, unlike `clean_region()`'s flat-fill/inpaint guess used when there's no known-clean source for an arbitrary user-picked spot. `RegionItem.restore_only` on a `/region/render` region requests this (its `text` is then ignored); `RegionRenderRequest.source_image` is required whenever any region has it set. Content-script wiring: the "Fix a translation" popover (`openFixHintPopover`) gained Move/Delete buttons — Delete calls `region-tool.ts:deleteBubbleRegion()` (one `restoreOnly` region at the bubble's box); Move calls `startMoveBubbleSelect()`, which reuses the same crosshair drag-a-box picker as the general region tool (factored out as `pickBoxOnScreen()`) and opens the same editor pre-seeded with the bubble's already-known text/translation (skips the OCR call) — committing then saves **two** regions: the new one (drawn) plus a `restoreOnly` one at the bubble's old box. Both remove the bubble from `lastTranslateInfo`/hit-targets immediately (`removeBubbleFromFixTargets`) so its stale hit target doesn't linger.

### `backend/schemas.py`

Pydantic request/response models (`TranslateRequest`, `TranslateResponse`, `TranslateBatchRequest`, etc.) live in the flat top-level module `backend/schemas.py`, imported as `from schemas import ...` in `endpoints/translate.py`. This used to live at `backend/models/schemas.py`, but `.gitignore` blanket-excludes `backend/models/` (it's also `settings.models_dir`, where ML weights get downloaded/cached) — so that file could never actually be committed, silently dropped by every `git add`. Keep schema definitions here at the backend root, not under `backend/models/`, or they'll vanish from the repo again without any error at commit time.

### Extension structure

- `background/index.ts` — the MV3 service worker; does all cross-origin work (fetching manga images, calling the backend, listing OpenAI-compatible/Azure models) since content scripts and the popup can't make cross-origin requests without triggering CORS.
- `content-script/index.ts` — injected into manga pages; the page scanner and auto-translate overlay logic.
- `popup/index.ts` + `popup/index.html` — settings UI (Translate / LLM Config / Config / Account tabs), persisted via `chrome.storage.local`.
- `shared/types.ts` — the request/response/settings contract shared by all three surfaces (must stay in sync with the backend's pydantic schemas).
- `shared/i18n.ts` — UI strings for 5 languages (en, vi, zh, ja, ko); every user-facing label/placeholder added to the popup needs an entry here for each language.

Per-bubble decorations the content script injects onto the page (overlay, buttons/badges, retry badge, fix-hit layer) use a deliberately high z-index (`2147483000`+, matching the ceiling used by the magnifier/toast/popover at `2147483647`) — real manga sites routinely have their own sibling elements (lazy-load placeholders, ad slots) at z-index in the hundreds-to-thousands that would otherwise sit on top and silently swallow hover/click events while the translated image still renders visibly underneath. Don't reintroduce a low z-index here.

## Configuration

- Default backend URL: `http://localhost:7677` (set in extension Config tab).
- Provider API keys/endpoints can be entered in the extension popup (sent per-request) or supplied as backend env vars, read in `core/config.py:__post_init__`: `GOOGLE_API_KEY`/`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `ZAI_API_KEY`, `MOONSHOT_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`, `AZURE_OPENAI_ENDPOINT`/`AZURE_OPENAI_API_KEY`/`AZURE_OPENAI_API_VERSION`, and `HF_TOKEN` (for gated Hugging Face downloads, e.g. SAM3).
- Flux Klein 4B (optional, heavier inpainting for outside-bubble text) is not installed by default; `setup.bat` downloads it to `backend/models/flux/`. Default outside-text handling uses lightweight OpenCV-based cleanup instead.
- `MT_REQUIRE_AUTH` (default off) gates the backend behind account tokens; `MT_DATABASE_URL` points it at a real Postgres for those accounts; `MT_ADMIN_EMAIL` names the one account allowed to manage the Owner shared LLM config; `MT_SECRET_KEY` encrypts that shared config's `api_key` at rest — see "Hosted/account mode" above. Irrelevant to the normal local setup.
