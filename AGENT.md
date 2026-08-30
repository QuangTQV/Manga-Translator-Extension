# AGENT.md

This file provides guidance to CODEX when working with code in this repository.

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
# with `./.venv/bin/pip install -e ".[dev]"`.
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

`main.py` mounts `endpoints/translate.py`, which is the only router. Each `/translate` (or `/translate/batch`) request flows:

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

### `backend/schemas.py`

Pydantic request/response models (`TranslateRequest`, `TranslateResponse`, `TranslateBatchRequest`, etc.) live in the flat top-level module `backend/schemas.py`, imported as `from schemas import ...` in `endpoints/translate.py`. This used to live at `backend/models/schemas.py`, but `.gitignore` blanket-excludes `backend/models/` (it's also `settings.models_dir`, where ML weights get downloaded/cached) — so that file could never actually be committed, silently dropped by every `git add`. Keep schema definitions here at the backend root, not under `backend/models/`, or they'll vanish from the repo again without any error at commit time.

### Extension structure

- `background/index.ts` — the MV3 service worker; does all cross-origin work (fetching manga images, calling the backend, listing OpenAI-compatible/Azure models) since content scripts and the popup can't make cross-origin requests without triggering CORS.
- `content-script/index.ts` — injected into manga pages; the page scanner and auto-translate overlay logic.
- `popup/index.ts` + `popup/index.html` — settings UI (Translate / LLM Config / Config tabs), persisted via `chrome.storage.local`.
- `shared/types.ts` — the request/response/settings contract shared by all three surfaces (must stay in sync with the backend's pydantic schemas).
- `shared/i18n.ts` — UI strings for 5 languages (en, vi, zh, ja, ko); every user-facing label/placeholder added to the popup needs an entry here for each language.

Per-bubble decorations the content script injects onto the page (overlay, buttons/badges, retry badge, fix-hit layer) use a deliberately high z-index (`2147483000`+, matching the ceiling used by the magnifier/toast/popover at `2147483647`) — real manga sites routinely have their own sibling elements (lazy-load placeholders, ad slots) at z-index in the hundreds-to-thousands that would otherwise sit on top and silently swallow hover/click events while the translated image still renders visibly underneath. Don't reintroduce a low z-index here.

## Configuration

- Default backend URL: `http://localhost:7677` (set in extension Config tab).
- Provider API keys/endpoints can be entered in the extension popup (sent per-request) or supplied as backend env vars, read in `core/config.py:__post_init__`: `GOOGLE_API_KEY`/`GEMINI_API_KEY`, `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `XAI_API_KEY`, `DEEPSEEK_API_KEY`, `ZAI_API_KEY`, `MOONSHOT_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_COMPATIBLE_API_KEY`, `AZURE_OPENAI_ENDPOINT`/`AZURE_OPENAI_API_KEY`/`AZURE_OPENAI_API_VERSION`, and `HF_TOKEN` (for gated Hugging Face downloads, e.g. SAM3).
- Flux Klein 4B (optional, heavier inpainting for outside-bubble text) is not installed by default; `setup.bat` downloads it to `backend/models/flux/`. Default outside-text handling uses lightweight OpenCV-based cleanup instead.
