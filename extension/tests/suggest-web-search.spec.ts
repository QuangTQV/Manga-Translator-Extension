import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

// The "Suggest" (Story Notes draft) button can optionally ask the model to
// use its provider's own built-in web search to ground the draft in real
// character names/relationships instead of guessing from sample pages
// alone. They default to off/empty for a brand-new profile. They used to be
// treated as transient, per-action-only fields that reset on every popup
// open, but that caused a real reported bug (typed text silently lost on
// reopen if you hadn't clicked Suggest yet) — they're now persisted like any
// other setting; see tests/popup.spec.ts's "persist across closing and
// reopening the popup" test for that behavior.
test.describe('popup — Suggest Story Notes web search option', () => {
  test('web search checkbox and story title default to off/empty and are independently editable', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

    await seedSettings(
      worker,
      baseSeed({
        config: {
          providerGroups: [{ provider: 'Google', enabled: true, apiKeys: [{ key: 'key-1', enabled: true }] }],
        },
      }),
      firstKeyMatches('key-1'),
    );

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    const webSearchToggle = popup.locator('#f-suggest-web-search');
    const titleInput = popup.locator('#f-suggest-story-title');

    await expect(webSearchToggle).not.toBeChecked();
    await expect(titleInput).toHaveValue('');

    await titleInput.fill('Attack on Titan');
    await webSearchToggle.check();
    await expect(titleInput).toHaveValue('Attack on Titan');
    await expect(webSearchToggle).toBeChecked();
  });
});
