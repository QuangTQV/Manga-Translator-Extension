/* Shared types between content script, background, and popup. */

import type { UiLanguage } from './i18n.js';

// One entry in a key list (Backup API Keys, or one fallback provider's own
// keys). enabled lets the user temporarily exclude a specific key from
// rotation (e.g. it's hitting rate limits hard right now) without
// losing/retyping it.
export interface BackupApiKeyEntry {
  key: string;
  enabled: boolean;
}

// A fallback LLM provider to try if the primary provider (and its backup
// keys) are all rate-limited — tried in list order. enabled defaults to
// true when absent (older saved settings predate this field) — set false
// to temporarily skip this provider entirely during rotation without
// deleting it. Each of its own apiKeys can also be individually toggled
// the same way (e.g. one of this provider's keys is rate-limited but the
// others still work).
export interface FallbackProviderConfig {
  provider: string;
  modelName?: string;
  apiKeys: BackupApiKeyEntry[];
  baseUrl?: string; // Azure endpoint, or OpenAI-Compatible URL
  enabled?: boolean;
}

// Backup API Keys (and each fallback provider's own apiKeys) used to be
// saved as a plain string[]. Accepts either shape and normalizes to the
// current one, defaulting enabled to true for legacy string entries so
// nothing that used to be active silently stops being sent.
export function normalizeBackupApiKeys(raw: unknown): BackupApiKeyEntry[] {
  if (!Array.isArray(raw)) return [];
  const out: BackupApiKeyEntry[] = [];
  for (const item of raw) {
    if (typeof item === 'string') {
      const key = item.trim();
      if (key) out.push({ key, enabled: true });
    } else if (item && typeof item === 'object' && typeof (item as { key?: unknown }).key === 'string') {
      const key = (item as { key: string }).key.trim();
      if (key) out.push({ key, enabled: (item as { enabled?: unknown }).enabled !== false });
    }
  }
  return out;
}

// Fallback provider rows used to be saved with apiKeys: string[] and no
// enabled field. Migrates both to the current shape.
export function normalizeFallbackProviders(raw: unknown): FallbackProviderConfig[] {
  if (!Array.isArray(raw)) return [];
  const out: FallbackProviderConfig[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const obj = item as Record<string, unknown>;
    if (typeof obj.provider !== 'string' || !obj.provider) continue;
    out.push({
      provider: obj.provider,
      modelName: typeof obj.modelName === 'string' ? obj.modelName : undefined,
      apiKeys: normalizeBackupApiKeys(obj.apiKeys),
      baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl : undefined,
      enabled: obj.enabled !== false,
    });
  }
  return out;
}

export interface TranslateConfig {
  inputLanguage: string;
  outputLanguage: string;
  provider: string;
  baseUrl?: string;     // for OpenAI-Compatible provider, or Azure endpoint for Azure OpenAI
  modelName?: string;   // for Azure OpenAI, this is the deployment name
  apiKey?: string;
  apiKeyEnabled?: boolean; // false to temporarily skip the primary key (e.g. rate-limited) without deleting it — falls through to backup keys/fallback providers. Defaults to true when absent.
  temperature: number;
  topP: number;
  topK: number;
  maxTokens?: number;
  translationMode: 'one-step' | 'two-step';
  ocrMethod: 'LLM' | 'manga-ocr' | 'paddleocr-vl';
  reasoningEffort?: string;
  specialInstructions?: string; // per-story notes (glossary, character relationships)
  llmInstructions?: string; // persistent, story-independent style/behavior guidance
  contextMemoryEnabled?: boolean; // ask the model for a one-sentence page summary and accumulate it as context for later pages
  backupApiKeys?: BackupApiKeyEntry[]; // extra keys for the same provider/model, tried in order on rate limit
  fallbackProviders?: FallbackProviderConfig[]; // tried after the primary provider + backup keys are all rate-limited
  fontDir?: string;
  maxFontSize: number;
  minFontSize: number;
  supersamplingFactor: number;
  sendFullPageContext: boolean;
  imageDetail: string;
  outsideTextEnabled: boolean;
  preTranslate: boolean; // eagerly translate pages as they load, not just near viewport (Auto-translate only)
  previousContextEnabled: boolean; // send prior pages' OCR text for pronoun/name consistency (costs latency)
}

export interface BubbleInfo {
  bbox: [number, number, number, number];
  confidence: number;
  originalText?: string;
  translatedText: string;
}

// A user-supplied correction, applied on a re-translate of the whole page.
// With bubbleIndex/originalText set, it targets one bubble from a prior
// TranslateResponse.bubbles list; without it, the instruction is applied
// as a general correction across the whole page (e.g. a recurring mistake
// fixed across several selected pages at once).
export interface FixHint {
  bubbleIndex?: number;
  originalText?: string;
  instruction: string;
}

export interface TranslateResponse {
  translated_image: string; // raw base64
  bubbles: BubbleInfo[];
  processing_time_seconds: number;
  source_language: string;
  target_language: string;
  provider: string;
  ocr_texts?: string[]; // this page's OCR transcripts, in reading order
  memory_note?: string; // this page's one-sentence context-memory summary, if enabled
}

export interface TranslateBatchItemResponse {
  id?: string;
  translated_image?: string;
  bubbles: BubbleInfo[];
  error?: string;
  processing_time_seconds?: number;
  ocr_texts?: string[];
  memory_note?: string;
}

export interface TranslateBatchResponse {
  results: TranslateBatchItemResponse[];
  total_time_seconds: number;
  success_count: number;
  error_count: number;
}

export interface HealthResponse {
  status: string;
  version: string;
  backend_version: string;
  gpu_available: boolean;
  device: string;
  cuda_available: boolean;
}

export interface TranslateRequest {
  image: string; // raw base64 (no data: prefix)
  input_language: string;
  output_language: string;
  provider: string;
  base_url?: string;   // for OpenAI-Compatible provider, or Azure endpoint for Azure OpenAI
  model_name?: string; // for Azure OpenAI, this is the deployment name
  api_key?: string;
  temperature: number;
  top_p: number;
  top_k: number;
  max_tokens?: number;
  translation_mode: 'one-step' | 'two-step';
  ocr_method: 'LLM' | 'manga-ocr' | 'paddleocr-vl';
  reasoning_effort?: string;
  special_instructions?: string;
  llm_instructions?: string;
  context_memory_enabled?: boolean;
  context_memory?: string;
  backup_api_keys?: string[];
  fallback_providers?: { provider: string; model_name?: string; api_keys: string[]; base_url?: string }[];
  fix_hint?: { bubble_index?: number; original_text?: string; instruction: string };
  font_dir?: string;
  max_font_size: number;
  min_font_size: number;
  supersampling_factor: number;
  send_full_page_context: boolean;
  image_detail: string;
  outside_text_enabled: boolean;
  previous_context_texts?: string[][]; // prior pages' OCR transcripts, oldest-to-newest, for cross-page consistency
}

export interface UrlPattern {
  baseUrl: string;
  pageNumber: number;
  padding: number;
  extension: string;
}

export interface ChapterCollectionResult {
  totalPages: number;
  foundUrls: string[];
  confirmedUrls: string[];
  pattern: UrlPattern | null;
}

export interface AppSettings {
  backendUrl: string;
  autoDetect: boolean;
  showBubbleBboxes: boolean;
  // Master kill switch: when false, no translate request is ever sent
  // (checked in the background service worker, which is the single choke
  // point every translate path routes through) regardless of what UI
  // action triggered it.
  extensionEnabled: boolean;
  uiLanguage: UiLanguage;
  config: TranslateConfig;
}

export const DEFAULT_SETTINGS: AppSettings = {
  backendUrl: 'http://localhost:7677',
  autoDetect: false,
  showBubbleBboxes: false,
  extensionEnabled: true,
  uiLanguage: 'en',
  config: {
    inputLanguage: 'Japanese',
    outputLanguage: 'English',
    provider: 'Google',
    temperature: 0.1,
    topP: 0.95,
    topK: 1,
    translationMode: 'one-step',
    ocrMethod: 'LLM',
    maxFontSize: 16,
    minFontSize: 8,
    supersamplingFactor: 4,
    sendFullPageContext: true,
    imageDetail: 'auto',
    outsideTextEnabled: false,
    preTranslate: false,
    previousContextEnabled: false,
    contextMemoryEnabled: false,
  },
};

export const LANGUAGES = [
  'Japanese', 'Korean', 'Chinese (Simplified)', 'Chinese (Traditional)',
  'English', 'Afrikaans', 'Albanian', 'Arabic', 'Armenian', 'Bengali',
  'Bosnian', 'Bulgarian', 'Catalan', 'Croatian', 'Czech', 'Danish',
  'Dutch', 'Estonian', 'Persian (Farsi)', 'Finnish', 'French', 'Galician',
  'Georgian', 'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi',
  'Hungarian', 'Icelandic', 'Indonesian', 'Italian', 'Kannada',
  'Latvian', 'Lithuanian', 'Malay', 'Marathi', 'Norwegian', 'Polish',
  'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Serbian (Cyrillic)',
  'Serbian (Latin)', 'Slovak', 'Slovenian', 'Spanish', 'Swahili',
  'Swedish', 'Tamil', 'Telugu', 'Filipino (Tagalog)', 'Turkish',
  'Ukrainian', 'Urdu', 'Uzbek', 'Vietnamese', 'Welsh',
] as const;

export const SOURCE_LANGUAGES = ['Auto', 'Japanese', 'Korean', 'English', 'Vietnamese'] as const;
export const TARGET_LANGUAGES = ['Japanese', 'Korean', 'English', 'Vietnamese'] as const;

export const PROVIDERS = [
  'Google', 'OpenAI', 'Azure OpenAI', 'Anthropic', 'xAI', 'DeepSeek',
  'Z.ai', 'Moonshot AI', 'OpenRouter', 'OpenAI-Compatible',
] as const;
