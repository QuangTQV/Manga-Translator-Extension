# CLAUDE.md

Guidance for Claude Code working in this repository. Keep this file focused on durable architecture and non-obvious pitfalls; see `AGENT.md` for the general project overview and commands.

## Architecture

- `backend/` is a FastAPI service (default `http://localhost:7677`); `extension/` is a Manifest V3 TypeScript extension. They communicate over HTTP and have separate builds.
- Translation flow: `endpoints/translate.py` → `pipeline/wrapper.py:_build_config()` → `core/pipeline.py:translate_and_render()` → `core/services/translation.py` → provider adapters in `utils/endpoints/` → renderers in `core/text/`.
- Request/settings contracts must stay aligned between `backend/schemas.py`, `extension/src/shared/types.ts`, and the request construction in the extension. Popup strings belong in `extension/src/shared/i18n.ts` for all five locales (en, vi, zh, ja, ko).
- Cross-origin browser requests belong in `extension/src/background/index.ts`; content scripts and popup should call the service worker rather than fetch manga sites or providers directly.
- Backend schemas live in `backend/schemas.py`, not `backend/models/`: that directory is ignored and used for downloaded ML weights.

## When changing provider support

Provider logic is intentionally explicit rather than fully abstracted. Keep the relevant entries in sync across:

1. `backend/utils/endpoints/<provider>.py` and `utils/endpoints/__init__.py`
2. `backend/core/config.py`, `core/llm_defaults.py`, and `utils/model_metadata.py`
3. `backend/core/services/translation.py` (reasoning detection, generation config, dispatch)
4. `backend/pipeline/wrapper.py` (key injection/default model/endpoint parsing)
5. `backend/endpoints/translate.py` and extension provider options (`shared/types.ts`, `popup/index.html`)

## Important behavior and pitfalls

- **Combined-page translation:** in one-step LLM OCR, the backend numbers detected regions on one resized page image instead of sending one crop per region. Resolution can be Auto/Low/Standard/High; Auto uses detected box geometry and density, not another model call. Preserve the legacy numeric setting and include resolution-affecting options in the translation cache key. If image annotation/encoding fails, retain the per-region crop fallback.
- **Text rendering:** `core/text/text_processing.py` handles nested emphasis markers; keep parsing nesting-aware so literal `*` markers do not leak into rendered text. Layout chooses a fitting font size and wraps text before Skia drawing; supersampling feeds the hover magnifier's high-resolution crop.
- **Translation cache:** distinguish every input/configuration that can change model output or image content. Post-translation replacements/glossary rules run after the LLM cache intentionally; pre-translation rules affect the prompt and belong in the key.
- **Model downloads:** weights are fetched lazily via `core/ml/model_manager.py`. Route downloads through `core/ml/download_status.py:track_download()` so `/health` and the extension can report progress. Tests must not download weights; skip weight-dependent cases when files are absent.
- **Extension overlay:** page decorations need the established very high z-index (`2147483000+`) to stay above manga-site overlays. For fixed-position UI, test geometry/DOM hit targets rather than screenshot pixels; Chromium screenshots can omit fixed elements.
- **Playwright fixtures:** `fixtures/test-site/` translates four pages concurrently, so `.first()` can be nondeterministic. Use `fixtures/test-site-single/` when a test needs one known bubble.
- **Manual regions/eraser:** render edits against the page's base image, not a previous manual render. The eraser stores one cumulative mask and re-renders it against the untouched base. Canvas painting listeners should attach to the canvas, not an overlay containing toolbar buttons.
- **Hosted mode is optional:** `MT_REQUIRE_AUTH` defaults off. Account/owner-config features require Postgres; do not make the local BYO-key workflow depend on login or a database. Owner LLM keys are encrypted at rest using `MT_SECRET_KEY` and must never be returned in API responses or logs.
- **SearXNG is optional:** page translation does not web-search. Search is only used by opt-in story-note/story-DB actions; its endpoint is configured server-side with `MT_SEARXNG_URL`.

## Verification

Follow the commands in `AGENT.md`. Run relevant backend tests and, for extension changes, `npm run lint` and `npm run build` from `extension/`. For scanner/UI changes, add or run the applicable Playwright tests.
