/* Shared types between content script, background, and popup. */

import type { UiLanguage } from './i18n.js';

export interface TranslateConfig {
  inputLanguage: string;
  outputLanguage: string;
  provider: string;
  baseUrl?: string;     // for OpenAI-Compatible provider, or Azure endpoint for Azure OpenAI
  modelName?: string;   // for Azure OpenAI, this is the deployment name
  apiKey?: string;
  temperature: number;
  topP: number;
  topK: number;
  maxTokens?: number;
  translationMode: 'one-step' | 'two-step';
  ocrMethod: 'LLM' | 'manga-ocr' | 'paddleocr-vl';
  reasoningEffort?: string;
  specialInstructions?: string; // per-story notes (glossary, character relationships)
  llmInstructions?: string; // persistent, story-independent style/behavior guidance
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

export interface TranslateResponse {
  translated_image: string; // raw base64
  bubbles: BubbleInfo[];
  processing_time_seconds: number;
  source_language: string;
  target_language: string;
  provider: string;
  ocr_texts?: string[]; // this page's OCR transcripts, in reading order
}

export interface TranslateBatchItemResponse {
  id?: string;
  translated_image?: string;
  bubbles: BubbleInfo[];
  error?: string;
  processing_time_seconds?: number;
  ocr_texts?: string[];
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
