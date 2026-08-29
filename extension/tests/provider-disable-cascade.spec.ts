import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

// Disabling a provider group already skipped it entirely during rotation
// (buildProviderRotation filters on group.enabled) — its keys were already
// inert, but the popup left them looking checked/active, which read as
// inconsistent. Unchecking a provider now visually dims its keys and locks
// each key's own enabled checkbox, without touching the key's underlying
// stored value — re-enabling the provider must restore exactly which keys
// were on before.
test.describe('popup — LLM Config tab disabling a provider dims and locks its keys', () => {
  test('unchecking the provider dims the key list and disables per-key checkboxes; re-checking restores them', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

    await seedSettings(
      worker,
      baseSeed({
        config: {
          providerGroups: [{
            provider: 'Google', enabled: true,
            apiKeys: [{ key: 'key-1', enabled: true }, { key: 'key-2', enabled: false }],
          }],
        },
      }),
      firstKeyMatches('key-1'),
    );

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'LLM Config' }).click();

    const providerRow = popup.locator('#provider-groups-list .fallback-provider-row').first();
    const providerEnabled = providerRow.locator('.fb-enabled');
    const keyEnabledCheckboxes = providerRow.locator('.backup-key-row .bk-enabled');

    await expect(providerRow).not.toHaveClass(/provider-disabled/);
    await expect(keyEnabledCheckboxes.nth(0)).toBeEnabled();
    await expect(keyEnabledCheckboxes.nth(0)).toBeChecked();
    await expect(keyEnabledCheckboxes.nth(1)).not.toBeChecked();

    await providerEnabled.uncheck();
    await expect(providerRow).toHaveClass(/provider-disabled/);
    await expect(keyEnabledCheckboxes.nth(0)).toBeDisabled();
    await expect(keyEnabledCheckboxes.nth(1)).toBeDisabled();
    // Underlying per-key state must survive being dimmed — not silently
    // flipped to unchecked just because the provider is off.
    await expect(keyEnabledCheckboxes.nth(0)).toBeChecked();
    await expect(keyEnabledCheckboxes.nth(1)).not.toBeChecked();

    await providerEnabled.check();
    await expect(providerRow).not.toHaveClass(/provider-disabled/);
    await expect(keyEnabledCheckboxes.nth(0)).toBeEnabled();
    await expect(keyEnabledCheckboxes.nth(0)).toBeChecked();
    await expect(keyEnabledCheckboxes.nth(1)).not.toBeChecked();
  });
});
