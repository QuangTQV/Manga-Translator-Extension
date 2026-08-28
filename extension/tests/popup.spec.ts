import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

test.describe('popup — LLM Config tab', () => {
  test('rotation strategy select toggles per-key weight input visibility', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

    await seedSettings(
      worker,
      baseSeed({
        config: {
          providerGroups: [{
            provider: 'Google', enabled: true,
            apiKeys: [{ key: 'key-1', enabled: true, weight: 3 }],
          }],
          rotationStrategy: 'round_robin',
        },
      }),
      firstKeyMatches('key-1'),
    );

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'LLM Config' }).click();

    const weightInput = popup.locator('#provider-groups-list .backup-key-row input.bk-weight').first();

    // Seeded as round_robin -> the weight input exists in the DOM but is hidden.
    await expect(weightInput).toBeHidden();

    await popup.locator('#f-rotation-strategy').selectOption('random');
    await expect(weightInput).toBeVisible();
    await expect(weightInput).toHaveValue('3');

    await popup.locator('#f-rotation-strategy').selectOption('sequential');
    await expect(weightInput).toBeHidden();
  });

  test('editing a key weight persists across a popup reload', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

    await seedSettings(
      worker,
      baseSeed({
        config: {
          providerGroups: [{
            provider: 'Google', enabled: true,
            apiKeys: [{ key: 'key-1', enabled: true, weight: 1 }],
          }],
          rotationStrategy: 'random',
        },
      }),
      firstKeyMatches('key-1'),
    );

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'LLM Config' }).click();

    const weightInput = popup.locator('#provider-groups-list .backup-key-row input.bk-weight').first();
    await weightInput.fill('7');
    await weightInput.dispatchEvent('change');
    // autoSave() also fires on blur/tab-switch; give the async write a beat.
    await popup.waitForTimeout(300);

    const reloaded = await context.newPage();
    await reloaded.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await reloaded.getByRole('button', { name: 'LLM Config' }).click();
    await expect(reloaded.locator('#f-rotation-strategy')).toHaveValue('random');
    await expect(reloaded.locator('#provider-groups-list .backup-key-row input.bk-weight').first()).toHaveValue('7');
  });

  test('duplicate-key warning fires for same provider+model+key, not for a different model', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

    await seedSettings(
      worker,
      baseSeed({
        config: {
          providerGroups: [
            { provider: 'Google', modelName: 'gemini-3.1-flash', enabled: true, apiKeys: [{ key: 'same-key', enabled: true }] },
            { provider: 'Google', modelName: 'gemini-3.1-pro', enabled: true, apiKeys: [{ key: 'same-key', enabled: true }] },
          ],
        },
      }),
      firstKeyMatches('same-key'),
    );

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'LLM Config' }).click();

    const warning = popup.locator('#duplicate-key-warning');
    // Same key, different model -> not flagged as a duplicate (many
    // providers meter rate limits per model, so this is a legitimate setup).
    await expect(warning).toBeHidden();

    // Change the second group's model to match the first -> now it IS a
    // true duplicate (same provider+model+key) and should be flagged.
    await popup.locator('#provider-groups-list .fallback-provider-row').nth(1)
      .locator('.fb-model').fill('gemini-3.1-flash');
    await popup.locator('#provider-groups-list .fallback-provider-row').nth(1)
      .locator('.fb-model').dispatchEvent('change');

    await expect(warning).toBeVisible();
    await expect(warning).toContainText('gemini-3.1-flash');
  });
});
