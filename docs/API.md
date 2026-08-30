# MangaTranslator Backend API

FastAPI backend with a vendored MangaTranslator-derived pipeline for use by the browser extension.

## Base URL

```
http://localhost:7677
```

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
| `422 Unprocessable Entity` | Validation error (Pydantic) |
| `500 Internal Server Error` | Translation pipeline failed |

## Image Format

- **Input**: Accepts any format PIL can decode (PNG, JPEG, WebP, GIF, BMP, TIFF)
- **Output**: Always PNG (raw base64, no `data:` prefix)
- **Max size**: Configurable via `MT_MAX_IMAGE_SIZE_MB` (default: 50MB)
- **Timeout**: Configurable via `MT_REQUEST_TIMEOUT_SECONDS` (default: 300s)
