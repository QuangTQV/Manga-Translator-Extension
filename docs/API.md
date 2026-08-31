# MangaTranslator Backend API

FastAPI backend with a vendored MangaTranslator-derived pipeline for use by the browser extension.

## Base URL

```
http://localhost:7677
```

## Authentication (hosted deployments only)

Off by default. A normal local/self-hosted backend needs no authentication (and no database) at all — skip this section. A centrally-hosted deployment that sets `MT_REQUIRE_AUTH=true` requires an `Authorization: Bearer <token>` header (a token from [`POST /account/register`](#post-accountregister)) on `/translate`, `/translate/batch`, `/suggest-instructions`, and `/test-key`. Missing/invalid token → `401`; quota exceeded for the account's plan → `429`. `/health` and `/providers` are never gated. Accounts are stored in a real Postgres database (`MT_DATABASE_URL`, e.g. `postgresql+psycopg2://user:pass@host:5432/dbname`) — see `backend/docker-compose.yml` for a local one to develop against.

## Endpoints

### `GET /health`

Health check. Returns backend status and GPU availability.

**Response `200 OK`:**
```json
{
  "status": "ok",
  "version": "1.0.0",
  "backend_version": "1.0.0",
  "gpu_available": true,
  "device": "cuda",
  "cuda_available": true
}
```

---

### `GET /providers`

List available LLM translation providers.

**Response `200 OK`:**
```json
{
  "providers": [
    "Google", "OpenAI", "Anthropic", "xAI", "DeepSeek",
    "Z.ai", "Moonshot AI", "OpenRouter", "OpenAI-Compatible"
  ],
  "default_provider": "Google"
}
```

---

### `POST /translate`

Translate a single image.

**Request body:**
```json
{
  "image": "<raw base64 string (no data: prefix)>",
  "input_language": "Japanese",
  "output_language": "English",
  "provider": "Google",
  "model_name": "gemini-3.1-flash-lite-preview",
  "api_key": "<your key>",
  "temperature": 0.1,
  "top_p": 0.95,
  "top_k": 40,
  "max_tokens": null,
  "translation_mode": "one-step",
  "ocr_method": "LLM",
  "reasoning_effort": null,
  "special_instructions": null,
  "llm_instructions": null,
  "font_dir": null,
  "max_font_size": 16,
  "min_font_size": 8,
  "supersampling_factor": 4,
  "send_full_page_context": true,
  "image_detail": "auto",
  "outside_text_enabled": false,
  "previous_context_texts": null,
  "context_memory_enabled": false,
  "context_memory": null,
  "backup_api_keys": null,
  "fallback_providers": null,
  "fix_hint": null,
  "rotation_strategy": null,
  "cooldown_seconds": null,
  "api_key_weight": null,
  "backup_api_key_weights": null
}
```

**Fields:**
| Field | Type | Default | Description |
|---|---|---|---|
| `image` | `string` | **required** | Base64-encoded image (no `data:image/...;base64,` prefix) |
| `input_language` | `string` | **required** | Source language |
| `output_language` | `string` | **required** | Target language |
| `provider` | `string` | **required** | LLM provider |
| `base_url` | `string?` | `null` | Azure endpoint, or OpenAI-Compatible base URL |
| `model_name` | `string?` | `null` | Model name override |
| `api_key` | `string?` | `null` | API key override |
| `temperature` | `float` | `0.1` | Sampling temperature (0.0–2.0) |
| `top_p` | `float` | `0.95` | Nucleus sampling (0.0–1.0) |
| `top_k` | `int` | `40` | Top-k sampling |
| `max_tokens` | `int?` | `null` | Max output tokens |
| `translation_mode` | `"one-step" \| "two-step"` | `"one-step"` | One-shot or two-pass translation |
| `ocr_method` | `"LLM" \| "manga-ocr" \| "paddleocr-vl"` | `"LLM"` | Text recognition method |
| `reasoning_effort` | `string?` | `null` | Reasoning effort for supported models |
| `special_instructions` | `string?` | `null` | Story Notes: per-story glossary/relationships/tone the model always follows |
| `llm_instructions` | `string?` | `null` | General LLM Instructions, applied to every story (unlike `special_instructions`) |
| `font_dir` | `string?` | `null` | Font pack name under `./fonts` |
| `max_font_size` | `int` | `16` | Maximum rendered font size (px) |
| `min_font_size` | `int` | `8` | Minimum rendered font size (px) |
| `supersampling_factor` | `int` | `4` | Render quality multiplier (1–4); also gates whether `bubbles[].high_res_crop` is populated in the response |
| `send_full_page_context` | `bool` | `true` | Send full page context to LLM |
| `image_detail` | `"auto" \| "low" \| "high"` | `"auto"` | Vision detail level |
| `outside_text_enabled` | `bool` | `false` | Detect and translate text outside speech bubbles |
| `previous_context_texts` | `string[][]?` | `null` | Oldest-to-newest OCR transcripts of prior pages, for cross-page consistency |
| `context_memory_enabled` | `bool` | `false` | Ask the model for a one-sentence `MEMORY NOTE` summary of this page (see `memory_note` in the response) |
| `context_memory` | `string?` | `null` | Accumulated `MEMORY NOTE` summaries from earlier pages, caller-formatted, fed back in on later pages |
| `backup_api_keys` | `string[]?` | `null` | Extra keys for the same provider/model, tried on rate limit |
| `fallback_providers` | [`FallbackProviderConfig[]`](#fallbackproviderconfig)`?` | `null` | Other providers to try after the primary + its backup keys are all rate-limited |
| `fix_hint` | [`FixHintConfig`](#fixhintconfig)`?` | `null` | Re-translate this page with a targeted correction for one bubble, or a general correction across the whole page |
| `rotation_strategy` | `"round_robin" \| "random" \| "sequential"?` | `null` (→ `round_robin`) | Which candidate key/provider to try first |
| `cooldown_seconds` | `float?` | `null` (→ `15`) | How long a rate-limited key/provider is skipped before being retried |
| `api_key_weight` | `float?` | `null` | Relative pick weight for `api_key`, used only when `rotation_strategy` is `"random"` |
| `backup_api_key_weights` | `float[]?` | `null` | Relative pick weight per key, same order as `backup_api_keys`, used only when `rotation_strategy` is `"random"` |

#### `FallbackProviderConfig`

| Field | Type | Description |
|---|---|---|
| `provider` | `string` | **required** |
| `model_name` | `string?` | Model name override for this fallback provider |
| `api_keys` | `string[]` | Keys to try for this provider, in order |
| `api_key_weights` | `float[]?` | Relative pick weight per key (same order as `api_keys`), used only under `"random"` rotation |
| `base_url` | `string?` | Azure endpoint, or OpenAI-Compatible URL |
| `reasoning_effort` | `string?` | Overrides the top-level `reasoning_effort` for this fallback provider only; omit to inherit it |

#### `FixHintConfig`

A user-supplied correction, applied on a re-translate of the whole page.

| Field | Type | Description |
|---|---|---|
| `bubble_index` | `int?` | 0-based index into a prior response's `bubbles` list — when set, only that bubble is corrected, the rest of the page is left as-is. Omit to apply `instruction` as a general correction across the whole page instead (e.g. a recurring mistake fixed across several pages at once) |
| `original_text` | `string?` | The original (source-language) text of the bubble identified by `bubble_index`, from a prior response |
| `instruction` | `string` | **required** — what to fix, in plain language |

**Response `200 OK`:**
```json
{
  "translated_image": "<raw base64 PNG>",
  "bubbles": [
    {
      "bbox": [45, 120, 380, 245],
      "confidence": 0.94,
      "original_text": "お前はもう死んでいる",
      "translated_text": "You are already dead",
      "high_res_crop": null
    }
  ],
  "processing_time_seconds": 4.23,
  "source_language": "Japanese",
  "target_language": "English",
  "provider": "Google",
  "ocr_texts": ["お前はもう死んでいる"],
  "memory_note": null
}
```

`bubbles[].high_res_crop` is a raw base64 PNG — a sharper, pre-downscale render of just that bubble (from the `supersampling_factor`× intermediate), meant for UI magnifiers. It's `null` whenever `supersampling_factor` is `1` (no supersampling).

`ocr_texts` is this page's OCR transcripts in reading order (independent of `bubbles`, includes lines that failed to translate). `memory_note` is this page's `MEMORY NOTE` summary when `context_memory_enabled` was set, otherwise `null`.

---

### `POST /translate/batch`

Translate up to 20 images concurrently.

**Request body:**
```json
{
  "images": [
    { "image": "<base64>", "id": "page-1" },
    { "image": "<base64>", "id": "page-2" }
  ],
  "input_language": "Japanese",
  "output_language": "English",
  "provider": "Google",
  ...same config fields as /translate...
}
```

**Response `200 OK`:**
```json
{
  "results": [
    {
      "id": "page-1",
      "translated_image": "<base64 PNG>",
      "bubbles": [...],
      "processing_time_seconds": 3.5,
      "ocr_texts": ["..."],
      "memory_note": null
    },
    {
      "id": "page-2",
      "translated_image": null,
      "bubbles": [],
      "error": "Image too large",
      "processing_time_seconds": 0.1,
      "ocr_texts": [],
      "memory_note": null
    }
  ],
  "total_time_seconds": 8.2,
  "success_count": 1,
  "error_count": 1
}
```

---

### `POST /suggest-instructions`

Drafts Story Notes text (cast, relationships, tone) from a handful of sample pages, for the user to review before saving. One-off call, not part of the translate flow.

**Request body:**
```json
{
  "images": ["<base64 sample page 1>", "<base64 sample page 2>"],
  "output_language": "English",
  "provider": "Google",
  "model_name": null,
  "api_key": "<your key>",
  "temperature": 0.1,
  "top_p": 0.95,
  "top_k": 40,
  "reasoning_effort": null,
  "backup_api_keys": null,
  "fallback_providers": null,
  "rotation_strategy": null,
  "cooldown_seconds": null,
  "api_key_weight": null,
  "backup_api_key_weights": null,
  "enable_web_search": false,
  "story_title": null
}
```

**Fields (beyond the shared provider/rotation fields, same meaning as in [`POST /translate`](#post-translate)):**
| Field | Type | Default | Description |
|---|---|---|---|
| `images` | `string[]` | **required** | Raw base64 sample page images (no `data:` prefix) |
| `output_language` | `string` | **required** | Language to write the suggestion in |
| `enable_web_search` | `bool` | `false` | Let the model use its provider's built-in web search to look up the story |
| `story_title` | `string?` | `null` | User-supplied title to search for, when `enable_web_search` is set |

**Response `200 OK`:**
```json
{ "suggestion": "Main characters: ... Tone: ..." }
```

---

### `POST /test-key`

Pings one `(provider, model, key)` combo with a minimal text-only request — the popup's "Test API Key" button. Not part of the translate flow; always returns `200 OK` with an `ok` flag rather than an HTTP error status, since a failed key/URL is an expected outcome here, not a server error. A single attempt only, no retry-on-rate-limit, so it reports back quickly even for an unreachable URL.

**Request body:**
```json
{
  "provider": "OpenAI-Compatible",
  "model_name": "deepseek-v4-flash-vision-exp",
  "api_key": "<key to test>",
  "base_url": "https://api.b.ai/v1",
  "reasoning_effort": null
}
```

**Fields:**
| Field | Type | Default | Description |
|---|---|---|---|
| `provider` | `string` | **required** | LLM provider |
| `model_name` | `string?` | `null` | Model name (or Azure deployment name); falls back to that provider's default model if omitted |
| `api_key` | `string?` | `null` | The key to test |
| `base_url` | `string?` | `null` | Azure endpoint, or OpenAI-Compatible URL — required for those two providers |
| `reasoning_effort` | `string?` | `null` | Same value the real translate request for this row would send — not forced to a fixed value, since backends disagree on which values (if any) they accept |

**Response `200 OK`:**
```json
{ "ok": false, "error": "OpenAI-Compatible API HTTP Error: Status 401: ... (Check API key if provided)", "latency_ms": null }
```

`latency_ms` is only set when `ok` is `true`.

---

### `POST /account/register`

Hosted deployments only — registers a new account and returns its token. No email verification or payment collection; this is scaffolding for a hosted deployment's real signup flow, not one itself.

**Request body:**
```json
{ "email": "you@example.com" }
```

**Response `200 OK`:**
```json
{ "email": "you@example.com", "token": "<opaque token — shown only here>", "plan": "free", "usage_count": 0, "quota": 50, "period_start": 1735689600.0, "is_admin": false }
```

`400` if the email looks invalid, `409` if already registered.

---

### `GET /account/me`

Returns the authenticated account's current plan/usage. Requires `Authorization: Bearer <token>`. Never echoes the token back.

**Response `200 OK`:**
```json
{ "email": "you@example.com", "token": null, "plan": "free", "usage_count": 3, "quota": 50, "period_start": 1735689600.0, "is_admin": false }
```

`is_admin` is `true` only when this account's email matches the server's `MT_ADMIN_EMAIL` — see [`/admin/llm-config`](#get-adminllm-config) below.

---

### `POST /account/plan`

Sets an account's plan directly — a stand-in for what a real payment webhook (Stripe checkout completed / subscription cancelled) would call. No payment is verified here; a real hosted deployment should call `core.accounts.set_plan` from its own webhook handler instead of exposing this as-is. Requires `Authorization: Bearer <token>`.

**Request body:**
```json
{ "plan": "paid" }
```

**Response `200 OK`:** same shape as `/account/me`, reflecting the new plan/quota.

---

### `POST /account/google-login`

"Sign in with Google" for the extension's Account tab. `access_token` is an OAuth access token from the extension's `chrome.identity.getAuthToken()` — **not** an ID token/JWT. Verified server-side against Google's own `tokeninfo` endpoint; finds the account for the verified email, or creates one (unlike `/account/register`, a returning user gets `200` with their existing account, not `409`).

**Request body:**
```json
{ "access_token": "<token from chrome.identity.getAuthToken()>" }
```

**Response `200 OK`:** same shape as `/account/register` (includes `token`).

`401` if the token is invalid/expired, its email isn't verified, or (when `MT_GOOGLE_OAUTH_CLIENT_ID` is set) its audience doesn't match. `502` if Google's tokeninfo endpoint can't be reached.

---

### `GET /admin/llm-config`

Admin-only (see [Authentication](#authentication-hosted-deployments-only) — this requires `Authorization: Bearer <token>` for the account whose email matches `MT_ADMIN_EMAIL`, independent of whether `MT_REQUIRE_AUTH` is on). Returns the shared LLM provider/model/key every hosted user's request falls back to when it doesn't carry its own `api_key`.

**Response `200 OK`:**
```json
{ "provider": "Google", "model_name": "gemini-3.1-flash-lite-preview", "api_key_set": true, "base_url": null }
```

The real key is never returned — only whether one is currently set (`api_key_set`). `503` if `MT_ADMIN_EMAIL` isn't configured on the server; `401`/`403` if the token is missing/invalid or isn't the admin account.

---

### `POST /admin/llm-config`

Admin-only, same auth as above. Sets the shared LLM config.

**Request body:**
```json
{ "provider": "Google", "model_name": "gemini-3.1-flash-lite-preview", "api_key": "<your key>", "base_url": null }
```

An empty/omitted `api_key` means "don't change the currently-stored key" (since `GET` never echoes it back for the caller to resend) — not "clear it". To actually change the key, send a new one.

**Response `200 OK`:** same shape as `GET /admin/llm-config`.

---

## CORS

The backend allows requests from:
- `chrome-extension://*`
- `moz-extension://*`
- `http://localhost`
- `http://localhost:7677`

To add more origins, set the `MT_CORS_ORIGINS` environment variable (comma-separated).

## Error Responses

All error responses return `JSON` with a `detail` field:

```json
{ "detail": "Maximum 20 images per batch" }
```

| Status | Meaning |
|---|---|
| `400 Bad Request` | Invalid request body |
| `413 Payload Too Large` | Image exceeds `MT_MAX_IMAGE_SIZE_MB` |
| `422 Unprocessable Entity` | Validation error (Pydantic) |
| `500 Internal Server Error` | Translation pipeline failed |
| `504 Gateway Timeout` | Translation exceeded `MT_REQUEST_TIMEOUT_SECONDS` |

## Image Format

- **Input**: Accepts any format PIL can decode (PNG, JPEG, WebP, GIF, BMP, TIFF)
- **Output**: Always PNG (raw base64, no `data:` prefix)
- **Max size**: Configurable via `MT_MAX_IMAGE_SIZE_MB` (default: 50MB)
- **Timeout**: Configurable via `MT_REQUEST_TIMEOUT_SECONDS` (default: 300s)
