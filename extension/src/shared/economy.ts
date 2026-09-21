import type { AppSettings, TranslateConfig } from './types.js';

// Economy mode trades a little translation quality for a lot less LLM spend.
// It is applied at request time to a *copy* of the config, never written back —
// so the user's own full-page-context / previous-page / image-detail choices
// are untouched and simply take effect again when economy mode is switched off.
//
// Context memory is deliberately left as the user set it: it is the cheap way
// to keep names/pronouns consistent (one sentence per page, no images).
export function effectiveConfig(config: TranslateConfig): TranslateConfig {
  if (!config.economyMode) return config;
  return {
    ...config,
    imageDetail: 'low',
    sendFullPageContext: false,
    previousContextEnabled: false,
    useStoryReferenceImages: false,
  };
}

export function withEffectiveConfig(settings: AppSettings): AppSettings {
  return settings.config.economyMode ? { ...settings, config: effectiveConfig(settings.config) } : settings;
}
