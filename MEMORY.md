# MEMORY.md

Living planning notes for in-progress feature work in this repo, meant to be read by AI coding agents picking up the project (complements `CLAUDE.md`, which documents the architecture as it exists today). Keep this flat and compact — prune/summarize once work is done rather than letting narrative pile up; git history and the code itself are authoritative for "what happened," this file is for what a future agent needs to *not repeat a mistake* or *not re-ask a settled question*.

## Lessons learned (generalizable — worth remembering before touching related code)

- **Pydantic `Optional[X] = None` serializes as JSON `null`, key always present — never an omitted key.** A hand-written test fixture that just leaves the field out is NOT equivalent to what the real backend sends. Caused a real bug: `data?.x !== undefined` passed for `null`, then `String(null)` → `"null"` → `NaN` → a garbled relationship-map node. Fix: check `typeof data?.x === 'number'`. Write at least one test with the field explicitly `null` when a bug could depend on this.
- **A CSS flex item's `width: 100%` isn't cancelled by an inline `style="flex:none"`.** `flex:none` only sets grow/shrink/basis to `0 0 auto`; when basis is `auto`, the main-axis size still comes from a separately-specified `width`. Caused a button reusing `.btn-add-fallback` (`width:100%`) to claim a whole flex row, squeezing sibling text to one word per line. Add an explicit `width:auto` too, not just `flex:none`.
- **MV3 service worker: never fire-and-forget (`void fn()`) a side effect that must survive past a message handler's response.** The worker can be torn down the instant the handler resolves; an un-awaited promise chain (e.g. `chrome.storage.local.set()`) can be cut off mid-flight. Always `await` it first, even for something that feels like "just bookkeeping."
- **`chrome.runtime.sendMessage()` cannot deliver a message back to the exact same script/context that sent it** ("Could not establish connection. Receiving end does not exist."). A test that needs to invoke a background message handler directly must send from a *different* extension context (e.g. a popup page opened via `context.newPage()`), not from `worker.evaluate()`.
- **Chrome MV3 action popups cannot be reliably drag-resized via CSS `resize:both`** — the browser continuously re-measures the popup's "natural" content size and can snap it back mid-drag. The reliable alternative: open the same page as a real `chrome.windows.create({type:'popup', url:'...'})` window, which the OS resizes normally.
- **Zero-size `.toggle input` checkboxes** (`opacity:0; width:0; height:0`) can't be hit by Playwright's `.check()`/`.click()` even with `force:true` — use `locator.evaluate(el => { el.checked = true; el.dispatchEvent(new Event('change', {bubbles:true})); })`.
- Rebuilding after a source edit matters: `npx playwright test <file>` runs against the *existing* `dist/` — use `npm test` (builds first) or you'll debug stale code.

## Standing UI-placement decision (governs all new advanced/pro-user features)

Advanced/pro-translator features must not be scattered onto the main Translate/LLM Config tabs — that clutters the UI for a casual reader. New work like this goes in its own space (the Pro tab, or a feature's own existing specialized tab like Story DB) that a casual user never has to see. **Already-shipped things directly on the main screen are NOT to be migrated** into that space unless explicitly asked again — the repo owner has twice deferred that restructuring ("để nguyên đi, tạm thời chưa cần").

## Features implemented (reference only — see the code/tests for exact behavior)

**Story DB** (character DB / relationships / glossary / continuity notes) — `backend/core/story_context.py`, `endpoints/stories.py`, popup "Story DB" tab. Requires login (`auth.py:require_login`, independent of `MT_REQUIRE_AUTH`); injected into the prompt server-side via `story_id`.
- Relationship map (SVG view over the form rows, drag/connect/click-to-highlight) + character avatar/reference images (`popup/relationship-graph.ts`, `popup/image-utils.ts`).
- Unsaved-draft recovery (`chrome.storage.local['mtStoryDraft:<id>']` — an MV3 popup is destroyed, not hidden, on blur) and Undo/Redo (Ctrl+Z/Shift+Z, debounced 600ms checkpoints) — share the same `input`/`change`/`MutationObserver` wiring.
- "Update from a description" (`POST /stories/update-from-description`, `verify_token`-gated, stateless) — free-text note → AI-drafted character/relationship/continuity-note updates for review before Save; optional web search (`enable_web_search`), deliberately not spoiler-safe (tracking plot developments is the point).
- Import/Export as JSON (`.mtstory.json`) directly in the tab.
- **Per-site mismatch warning + explicit master toggle (2026-09-25):** `activeStoryId` is one global setting, not per-site. `TranslateConfig.useStoryDb` (off by default) gates whether Story DB is applied to translation at all; `background/index.ts:recordStoryDomainUsage()` remembers the last story actually used per hostname, and the popup warns (never auto-switches — explicit repo-owner choice) when the active tab's hostname doesn't match the currently selected story. Known gap: the warning doesn't fire when the popup is opened as the standalone window (below) — fails closed, not wrong.

**Manual editing tools** (content-script, backend `core/manual_region.py`):
- Manual region tool (drag a box → OCR → type/AI-translate → redraw) — `/region/ocr|translate|render`.
- Eraser tool (freehand brush cleanup, `cv2.inpaint` on a hand-drawn mask) — `/region/erase`, one cumulative mask per page.
- Move/delete a detected bubble's box — reuses manual-region `restore_only` to paste back real pre-translation pixels.
- Bold/Italic toolbar on the manual-region translation field (wraps selection in markdown markers).
- Shared limitation: `cv2.inpaint` doesn't reconstruct a fine repeating pattern (dense hatching/screentone) through an erased/cleaned area.
- Not yet verified on a real manga site (MangaDex-style `blob:`/lazy-loading pages) — only Playwright fixtures + synthetic images so far.

**Popup window** — resizable via CSS `resize:both` (unreliable, kept as a harmless bonus) plus a reliable "⤢ open in a separate window" button (`chrome.windows.create`, `?standalone=1`), remembers its own size separately from the anchored popup's.

**Popup UX polish batch (2026-09-24):** confirm-before-discard on the draft banner; a fixed, auto-hiding status banner; `background/index.ts`'s network-error strings now go through `t()` instead of hardcoded English (backend `HTTPException` text itself is still English — needs backend-side i18n, not attempted); tab grid fixed to an even 3-column layout for 6 tabs.

**"?" help chat (2026-09-25):** always-visible header button opens a full-overlay chat panel (over whatever tab is active), answering "how do I use this" questions with the user's own configured LLM. Explicit repo-owner choices: ground it in the project's own docs rather than a plain FAQ or bare LLM call, and persist history in `chrome.storage.local['mtSupportChatHistory']` across popup reopens (same reasoning as the Story DB draft-recovery work — a Chrome action popup is destroyed, not hidden, on blur).
- Backend: `POST /support-chat` (`endpoints/translate.py`), `verify_token`-gated (same one-off-LLM-helper family as `/suggest-instructions`/`/stories/update-from-description` — no login required for the normal self-hosted setup). `core/services/translation.py:generate_support_chat_reply()` flattens the whole conversation into one `prompt_text` (not a native multi-turn array — `_call_llm_endpoint`'s shared signature is single-shot, and every other call site through that choke point already works this way, so this follows the same shape rather than changing the shared function). Grounded in `README.md` + `docs/HUONG-DAN-CHAY.md` (not `docs/API.md` — that's backend-integration reference, not "how do I use this") — small enough combined to send in full every request rather than building real RAG/embeddings; `_load_support_chat_docs()` caches them in memory after the first read, resolved relative to the repo root (`Path(__file__).resolve().parents[3]` from `core/services/translation.py` — get this off-by-one wrong and it silently reads nothing rather than erroring, since a missing doc file is just skipped).
- Extension: reuses `popup/index.ts:firstEnabledProvider()` (same "just the first configured key, not full rotation" simplification as Update-from-description) and proxies through `background/index.ts` (`SUPPORT_CHAT` message, `fetchSupportChat()`) like every other cross-origin LLM call. `uiLanguage` is mapped to its full English name (`UI_LANGUAGES.find(...).name`) before sending — a raw 2-letter code like `"vi"` in a prompt is a needless ambiguity a full name avoids.
- **Not verified with a real LLM call** (no API key available in this environment) — same limitation as every other AI-helper feature built this session; covered by prompt-construction unit tests (real doc-file I/O, no mocking of the file read) and a mocked-network Playwright suite for the popup UI/persistence.

**Other implemented features (brief):**
- Remote Flux worker (Kaggle GPU) — `backend/flux_worker.py`, token-authed, circuit-breaker on failure, graceful skip (never fails the page). Not verified against a real Kaggle GPU (protocol verified locally worker↔backend only).
- "Live AI" debug logger — `MT_LIVE_AI_LOG_ENABLED`, one hook point (`_call_llm_endpoint_impl`), text-only (no image bytes), `GET /admin/live-ai-log`.
- Economy mode — non-destructive request-time overrides (`shared/economy.ts:effectiveConfig()`), never rewrites stored settings.
- Font settings UI (`GET /fonts` + Font/Min/Max fields) — was previously schema-only, no popup control.
- Local web app (`/app`, `backend/webapp/index.html`) — no-build-step file-upload translator for raw images with no source web page; deliberately not a port of the whole popup (no Story DB/rotation/manual tools/auto-translate).
- Pro tab (supersampling-factor select) + CBZ export (zero-padded `page_NNN.png`, unlike the URL-derived ZIP names).
- **PDF export (2026-09-25):** scanner toolbar's "Export PDF" button, next to Export CBZ. `content-script/index.ts:buildPdf()` hand-rolls a minimal PDF rather than pulling in a library (jsPDF etc. would meaningfully bloat the content-script bundle) — one JPEG-per-page (`pngBase64ToJpegPage()` re-encodes each translated PNG via canvas, since PDF has no native PNG filter but `/Filter /DCTDecode` accepts a JPEG byte stream unmodified), MediaBox = image pixel dimensions as points (1:1 — fine for on-screen reading, not print-accurate). Verified with a real parser (`pdf-lib`, test-only devDependency) actually opening the generated file and confirming page count/size, not just a magic-byte check — this matters because a hand-rolled xref table is exactly the kind of thing that silently produces a corrupt-but-plausible-looking file if the byte-offset math is off by one anywhere.

## Roadmap — still open

- **Resize handles for a moved bubble** (currently: drag a brand-new box only, no corner/edge drag on the existing outline).
- **Manual region tool only works on `<img>` tags** — a page using CSS `background-image` for its pages isn't supported (`findTargetImage` in `region-tool.ts` only scans `img`).
- **Vertical or rotated text isn't laid out specially** in the manual region tool (`render_regions` calls `render_text_skia` without `vertical_stack`/`rotation_deg`), even though the main pipeline supports it.
- **No screen listing a page's saved manual regions** — to edit one you must re-select the same spot (>50% overlap opens it in edit mode instead of creating a new one).
- **True manual color/vertical-stack override** for typed text (bold/italic markdown-wrapping is done; a real style toolbar or schema field for the Fix-hint/manual-region paths is not).
- **Lightweight project/chapter tracker** (story → chapter → export-timestamp ledger; explicitly NOT an automatic multi-tab crawler — rejected as too fragile, no generic way to know a chapter's URL structure across sites).
- **Batch QA/proofread view** before export.
- **Team collaboration / shared Story DB with roles** — the big one; don't start without the repo owner explicitly deciding they want a real multi-user product surface.
- **Verify the whole manual-editing toolchain on a real manga site** (see limitation note above).
- **Popup onboarding for a new install** — scope undecided (banner? checklist? doc link?) — ask before building.
- **Auto-translate resume after reload / extension re-enable** — **explicitly unresolved, do not assume an answer exists.** Previously asked (one-click prompt vs. silent resume vs. leave as-is); the reply received was actually about a different, already-resolved question (popup settings persistence). Re-ask before implementing — silently resuming would arguably contradict the "no surprise auto-translate" promise on the master toggle.

## Known pre-existing test flakes (not regressions to chase)

- `extension/tests/content-visibility.spec.ts`'s hover-to-magnify-after-scroll test fails intermittently on `main` itself (confirmed by re-running against a clean `main`).
- `extension/tests/bubble-magnifier.spec.ts` has similar hover-timing flakiness — a different test in the file fails on different runs, passes clean on retry.
