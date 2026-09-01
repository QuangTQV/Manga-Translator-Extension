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

  test('a provider group\'s own reasoning effort persists across a popup reload, independent of the general setting', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

    await seedSettings(
      worker,
      baseSeed({
        config: {
          reasoningEffort: 'high',
          providerGroups: [{
            provider: 'Google', enabled: true,
            apiKeys: [{ key: 'key-1', enabled: true }],
          }],
        },
      }),
      firstKeyMatches('key-1'),
    );

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'LLM Config' }).click();

    // Left unset, the row's own select starts on "use general setting" (the
    // blank option), not mirroring the general dropdown's current value.
    const rowSelect = popup.locator('#provider-groups-list .fallback-provider-row select.fb-reasoning-effort').first();
    await expect(rowSelect).toHaveValue('');
    await expect(popup.locator('#f-reasoning-effort')).toHaveValue('high');

    await rowSelect.selectOption('none');
    await popup.waitForTimeout(300);

    const reloaded = await context.newPage();
    await reloaded.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await reloaded.getByRole('button', { name: 'LLM Config' }).click();
    await expect(reloaded.locator('#provider-groups-list .fallback-provider-row select.fb-reasoning-effort').first()).toHaveValue('none');
    // The general setting is untouched by editing the per-group override.
    await expect(reloaded.locator('#f-reasoning-effort')).toHaveValue('high');
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

  test('slow-LLM warning toggle and threshold persist across a popup reload', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'LLM Config' }).click();

    // Default: on, threshold 40.
    await expect(popup.locator('#f-slow-llm-warning')).toBeChecked();
    await expect(popup.locator('#f-slow-llm-threshold')).toHaveValue('40');

    // The visible control is a CSS toggle-switch on a zero-size <input> —
    // set DOM state directly and fire the 'change' the app listens for.
    await popup.locator('#f-slow-llm-warning').evaluate((el: HTMLInputElement) => {
      el.checked = false;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await popup.locator('#f-slow-llm-threshold').fill('25');
    await popup.locator('#f-slow-llm-threshold').dispatchEvent('change');
    await popup.waitForTimeout(300);

    const reloaded = await context.newPage();
    await reloaded.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await reloaded.getByRole('button', { name: 'LLM Config' }).click();
    await expect(reloaded.locator('#f-slow-llm-warning')).not.toBeChecked();
    await expect(reloaded.locator('#f-slow-llm-threshold')).toHaveValue('25');
  });
});
