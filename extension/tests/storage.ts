import type { Worker } from '@playwright/test';

/** On a brand-new profile, the extension's own chrome.runtime.onInstalled
 * handler (chrome.storage.local.set(DEFAULT_SETTINGS) when storage is
 * empty) can race a test's own seed write, non-deterministically
 * clobbering it. Not a real user-facing bug — a real user's storage is
 * never empty at update time — but tests need a write/verify/retry loop to
 * reach a deterministic starting state on a fresh profile.
 *
 * `verify` must check something that couldn't coincidentally also be true
 * of DEFAULT_SETTINGS (e.g. a seeded API key value, not just an array
 * length — DEFAULT_SETTINGS also seeds exactly one, empty, provider group,
 * so a length-only check can pass on the *wrong* write and silently hide
 * the race instead of catching it). */
export async function seedSettings(
  worker: Worker,
  settings: unknown,
  verify: (stored: any) => boolean,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    await worker.evaluate(async (value) => {
      await chrome.storage.local.set({ manga_translator_settings: value });
    }, settings);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const stored = await worker.evaluate(async () => {
      const result = await chrome.storage.local.get('manga_translator_settings');
      return result.manga_translator_settings;
    });
    if (verify(stored)) return;
  }
  throw new Error('seedSettings: storage never settled to the seeded value (onInstalled race?)');
}

/** Convenience verify() for the common case: the seeded settings' first
 * provider group's first API key matches what was actually written. */
export function firstKeyMatches(expectedKey: string): (stored: any) => boolean {
  return (stored) => stored?.config?.providerGroups?.[0]?.apiKeys?.[0]?.key === expectedKey;
}

export function baseSeed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Split off `config` before spreading the rest of `overrides` at the top
  // level — otherwise a trailing `...overrides` would replace the whole
  // merged `config` object below with the caller's raw (partial) one
  // instead of merging into it.
  const { config: configOverrides, ...topLevelOverrides } = overrides;
  return {
    backendUrl: 'http://localhost:7677',
    autoDetect: false,
    showBubbleBboxes: false,
    extensionEnabled: true,
    uiLanguage: 'en',
    ...topLevelOverrides,
    config: {
      inputLanguage: 'Japanese',
      outputLanguage: 'English',
      providerGroups: [{ provider: 'Google', apiKeys: [{ key: 'seed-key', enabled: true }], enabled: true }],
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
      rotationStrategy: 'round_robin',
      cooldownSeconds: 15,
      ...(configOverrides as Record<string, unknown> | undefined),
    },
  };
}
