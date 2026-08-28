/* Shared types between content script, background, and popup. */

import type { UiLanguage } from './i18n.js';

// One entry in a key list (a provider's API Keys, or one fallback provider's
// own keys). enabled lets the user temporarily exclude a specific key from
// rotation (e.g. it's hitting rate limits hard right now) without
// losing/retyping it.
export interface BackupApiKeyEntry {
  key: string;
  enabled: boolean;
  weight?: number; // relative pick chance among ready candidates when rotationStrategy is "random" (default 1 = equal chance for every key)
}

// One provider in the rotation list — tried in list order, no entry is
// distinguished as "primary". enabled defaults to true when absent (older
// saved settings predate this field) — set false to temporarily skip this
// provider entirely during rotation without deleting it. Each of its own
// apiKeys can also be individually toggled the same way (e.g. one of this
// provider's keys is rate-limited but the others still work).
export interface ProviderGroupConfig {
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
      if (key) {
        const rawWeight = (item as { weight?: unknown }).weight;
        const weight = typeof rawWeight === 'number' && rawWeight > 0 ? rawWeight : undefined;
        out.push({ key, enabled: (item as { enabled?: unknown }).enabled !== false, ...(weight !== undefined ? { weight } : {}) });
      }
    }
  }
  return out;
}

// The primary provider used to have one distinguished `apiKey`/`apiKeyEnabled`
// field plus a separate `backupApiKeys` list before being merged into one
// flat `apiKeys` list (no more distinguished key), and before THAT merge,
// its provider/baseUrl/modelName/apiKeys lived at the top of TranslateConfig
// as a distinguished "primary" provider, separate from `fallbackProviders`.
// Both distinctions turned out to be artificial — the backend already
// round-robins the starting candidate across every key and every provider
// equally — so everything is now one flat, equally-weighted, user-orderable
// `providerGroups` list. This helper migrates a single group's raw shape;
// normalizeProviderGroups (below) handles the full top-level migration.
function normalizeOneProviderGroup(item: unknown): ProviderGroupConfig | null {
  if (!item || typeof item !== 'object') return null;
  const obj = item as Record<string, unknown>;
  if (typeof obj.provider !== 'string' || !obj.provider) return null;
  return {
    provider: obj.provider,
    modelName: typeof obj.modelName === 'string' ? obj.modelName : undefined,
    apiKeys: normalizeApiKeys(obj),
    baseUrl: typeof obj.baseUrl === 'string' ? obj.baseUrl : undefined,
    enabled: obj.enabled !== false,
  };
}

// A single provider's keys used to be saved as a plain string[], then as
// `apiKeys: BackupApiKeyEntry[]`, then (for what used to be the distinguished
// "primary" provider only) split across `apiKey`/`apiKeyEnabled` plus a
// separate `backupApiKeys` list. Accepts any of those shapes and always
// returns the flat, current one, with a migrated single `apiKey` placed
// first.
export function normalizeApiKeys(rawConfig: unknown): BackupApiKeyEntry[] {
  if (!rawConfig || typeof rawConfig !== 'object') return [];
  const obj = rawConfig as Record<string, unknown>;
  if (Array.isArray(obj.apiKeys)) return normalizeBackupApiKeys(obj.apiKeys);
  const merged: unknown[] = [];
  if (typeof obj.apiKey === 'string' && obj.apiKey.trim()) {
    merged.push({ key: obj.apiKey.trim(), enabled: obj.apiKeyEnabled !== false });
  }
  if (Array.isArray(obj.backupApiKeys)) merged.push(...obj.backupApiKeys);
  return normalizeBackupApiKeys(merged);
}

// Migrates a raw stored config into the current flat `providerGroups` list.
// Old settings had the "primary" provider's fields (provider/baseUrl/
// modelName/apiKeys, or even older apiKey/apiKeyEnabled/backupApiKeys) at
// the top level, plus a separate `fallbackProviders` list tried only after
// it — that old primary becomes position 0, followed by its old fallbacks,
// in the same order they used to run in, so nothing about existing
// rotation behavior changes on upgrade, only that the user can now freely
// reorder every entry including what used to be "primary".
export function normalizeProviderGroups(rawConfig: unknown): ProviderGroupConfig[] {
  if (!rawConfig || typeof rawConfig !== 'object') return [];
  const obj = rawConfig as Record<string, unknown>;
  if (Array.isArray(obj.providerGroups)) {
    const out: ProviderGroupConfig[] = [];
    for (const item of obj.providerGroups) {
      const g = normalizeOneProviderGroup(item);
      if (g) out.push(g);
    }
    return out;
  }
  const groups: ProviderGroupConfig[] = [];
  const oldPrimary = normalizeOneProviderGroup(obj);
  if (oldPrimary) groups.push(oldPrimary);
  if (Array.isArray(obj.fallbackProviders)) {
    for (const item of obj.fallbackProviders) {
      const g = normalizeOneProviderGroup(item);
      if (g) groups.push(g);
    }
  }
  return groups;
}

// A plain object spread (`{...DEFAULT_SETTINGS.config, ...raw.config}`) would
// carry every old top-level provider field forward into storage forever
// alongside the new merged `providerGroups` list — dead data that's
// silently ignored everywhere but never cleaned up. Spread this instead of
// the raw config object to drop them once migrated.
export function stripLegacyProviderFields(rawConfig: unknown): Record<string, unknown> {
  if (!rawConfig || typeof rawConfig !== 'object') return {};
  const {
    provider: _provider, baseUrl: _baseUrl, modelName: _modelName,
    apiKey: _apiKey, apiKeyEnabled: _apiKeyEnabled, apiKeys: _apiKeys,
    backupApiKeys: _backupApiKeys, fallbackProviders: _fallbackProviders,
    ...rest
  } = rawConfig as Record<string, unknown>;
  return rest;
}

export interface TranslateConfig {
  inputLanguage: string;
  outputLanguage: string;
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
  providerGroups: ProviderGroupConfig[]; // every provider tried in rotation, in list order — no entry is distinguished as "primary"; the backend round-robins the starting candidate across all of them (and all their keys) equally
  rotationStrategy?: 'round_robin' | 'random' | 'sequential'; // which key/provider a request tries first — round_robin (default) spreads load evenly, random picks any ready one, sequential always starts at the first configured entry
  cooldownSeconds?: number; // how long a rate-limited key/provider is skipped before being retried (default 15s)
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
  api_key_weight?: number; // relative pick chance for `api_key`, used only when rotation_strategy is "random"
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
  backup_api_key_weights?: number[]; // same order as backup_api_keys
  fallback_providers?: { provider: string; model_name?: string; api_keys: string[]; api_key_weights?: number[]; base_url?: string }[];
  fix_hint?: { bubble_index?: number; original_text?: string; instruction: string };
  rotation_strategy?: string;
  cooldown_seconds?: number;
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
    providerGroups: [{ provider: 'Google', apiKeys: [], enabled: true }],
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
    rotationStrategy: 'round_robin',
    cooldownSeconds: 15,
  },
};

// The first 6 are frontloaded on purpose — the extension's own core
// features (Vietnamese pronoun accuracy, the 4 languages that used to be
// the entire hardcoded list) center on this project's actual most-used
// languages, so they need to stay easy to spot in the datalist suggestions
// instead of sorting alphabetically into the other ~50 like everything
// else here. Keep any language you add for the same reason in this block,
// not the alphabetical one below it.
export const LANGUAGES = [
  'Japanese', 'Korean', 'Vietnamese', 'English',
  'Chinese (Simplified)', 'Chinese (Traditional)',
  'Afrikaans', 'Albanian', 'Arabic', 'Armenian', 'Bengali',
  'Bosnian', 'Bulgarian', 'Catalan', 'Croatian', 'Czech', 'Danish',
  'Dutch', 'Estonian', 'Persian (Farsi)', 'Finnish', 'French', 'Galician',
  'Georgian', 'German', 'Greek', 'Gujarati', 'Hebrew', 'Hindi',
  'Hungarian', 'Icelandic', 'Indonesian', 'Italian', 'Kannada',
  'Latvian', 'Lithuanian', 'Malay', 'Marathi', 'Norwegian', 'Polish',
  'Portuguese', 'Punjabi', 'Romanian', 'Russian', 'Serbian (Cyrillic)',
  'Serbian (Latin)', 'Slovak', 'Slovenian', 'Spanish', 'Swahili',
  'Swedish', 'Tamil', 'Telugu', 'Filipino (Tagalog)', 'Turkish',
  'Ukrainian', 'Urdu', 'Uzbek', 'Welsh',
] as const;

// The backend takes input_language/output_language as free-form strings —
// no allowlist, no validation — so these two lists are only UI suggestion
// sets (used to populate <datalist> options a user can pick from or type
// past; see popup/index.ts). "Auto" (source-only) means auto-detect.
export const SOURCE_LANGUAGES = ['Auto', ...LANGUAGES] as const;
export const TARGET_LANGUAGES = [...LANGUAGES] as const;

export const PROVIDERS = [
  'Google', 'OpenAI', 'Azure OpenAI', 'Anthropic', 'xAI', 'DeepSeek',
  'Z.ai', 'Moonshot AI', 'OpenRouter', 'OpenAI-Compatible',
] as const;
