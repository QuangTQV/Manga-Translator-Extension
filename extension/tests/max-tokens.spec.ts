import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

// maxTokens existed as a config field and was already sent to the backend
// (content-script's buildTranslateRequest), but had no popup control at
// all — no user could actually set it. This mattered in practice: a
// reasoning model can burn its whole default token budget on internal
// "thinking" and return empty content, and raising this was the only fix,
// which nobody could reach from the UI.
test.describe('popup — LLM Config tab Max Tokens', () => {
  test('empty by default, and persists a chosen value across a popup reload', async ({ context, extensionId }) => {
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
    await popup.getByRole('button', { name: 'LLM Config' }).click();

    const maxTokensInput = popup.locator('#f-max-tokens');
    await expect(maxTokensInput).toHaveValue('');

    await maxTokensInput.fill('16000');
    await maxTokensInput.dispatchEvent('change');
    // autoSave() also fires on blur/tab-switch; give the async write a beat.
    await popup.waitForTimeout(300);

    const reloaded = await context.newPage();
    await reloaded.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await reloaded.getByRole('button', { name: 'LLM Config' }).click();
    await expect(reloaded.locator('#f-max-tokens')).toHaveValue('16000');
  });

  test('clearing the field back to empty persists as unset (provider default)', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

    await seedSettings(
      worker,
      baseSeed({
        config: {
          providerGroups: [{ provider: 'Google', enabled: true, apiKeys: [{ key: 'key-1', enabled: true }] }],
          maxTokens: 8000,
        },
      }),
      firstKeyMatches('key-1'),
    );

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'LLM Config' }).click();

    const maxTokensInput = popup.locator('#f-max-tokens');
    await expect(maxTokensInput).toHaveValue('8000');
    await maxTokensInput.fill('');
    await maxTokensInput.dispatchEvent('change');
    await popup.waitForTimeout(300);

    const reloaded = await context.newPage();
    await reloaded.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await reloaded.getByRole('button', { name: 'LLM Config' }).click();
    await expect(reloaded.locator('#f-max-tokens')).toHaveValue('');
  });
});
