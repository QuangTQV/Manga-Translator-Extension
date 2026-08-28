import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

test.describe('popup — Translate tab language pickers', () => {
  test('source/target inputs offer a broad datalist of suggestions, not a strict dropdown', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    const sourceOptionCount = await popup.locator('#lang-source-list option').count();
    const targetOptionCount = await popup.locator('#lang-target-list option').count();
    // The backend accepts any language string — this just checks the
    // suggestion pool is the expanded ~58-language list, not the old
    // hardcoded 4/5-entry one.
    expect(sourceOptionCount).toBeGreaterThan(50);
    expect(targetOptionCount).toBeGreaterThan(50);

    // "Auto" is a source-only suggestion (auto-detect); it must not appear
    // as a target suggestion, translating *into* "auto-detect" is meaningless.
    await expect(popup.locator('#lang-source-list option[value="Auto"]')).toHaveCount(1);
    await expect(popup.locator('#lang-target-list option[value="Auto"]')).toHaveCount(0);
  });

  test('the "Auto" suggestion carries a distinguishing label but submits exactly "Auto"', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    // <datalist> gives no way to color an individual suggestion (a hard
    // cross-browser platform limitation), so a `label` marker is the only
    // way to make "Auto" stand out in the native suggestion popup — but
    // `value` must stay the literal string "Auto", since the backend
    // string-matches it verbatim (input_language.strip().lower() ==
    // "auto"). Changing the label must never change what gets submitted.
    const autoOption = await popup.locator('#lang-source-list option[value="Auto"]').evaluate(
      (el) => ({ value: (el as HTMLOptionElement).value, label: (el as HTMLOptionElement).label }),
    );
    expect(autoOption.value).toBe('Auto');
    expect(autoOption.label).not.toBe('Auto');
    expect(autoOption.label.toLowerCase()).toContain('auto');
  });

  test('the project\'s core languages stay frontloaded, not buried alphabetically among ~58 suggestions', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    const targetValues = await popup.locator('#lang-target-list option').evaluateAll(
      (options) => options.map((o) => (o as HTMLOptionElement).value),
    );
    // Vietnamese in particular used to sort alphabetically to the very end
    // (between "Uzbek" and "Welsh") once the list grew to ~58 entries —
    // it has to stay grouped with the other core languages up front.
    expect(targetValues.slice(0, 6)).toEqual([
      'Japanese', 'Korean', 'Vietnamese', 'English',
      'Chinese (Simplified)', 'Chinese (Traditional)',
    ]);
  });

  test('typing an arbitrary language not in the suggestion list is accepted and persists', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    // Klingon is deliberately NOT in the curated suggestion list — proves
    // the field accepts free text, not just the datalist's own options.
    await popup.locator('#f-target').fill('Klingon');
    await popup.locator('#f-target').dispatchEvent('change');
    await popup.waitForTimeout(300);

    const reloaded = await context.newPage();
    await reloaded.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(reloaded.locator('#f-target')).toHaveValue('Klingon');
  });

  test('clearing the field falls back to the default language on save, instead of persisting empty', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    await popup.locator('#f-target').fill('');
    await popup.locator('#f-target').dispatchEvent('change');
    await popup.waitForTimeout(300);

    const reloaded = await context.newPage();
    await reloaded.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(reloaded.locator('#f-target')).toHaveValue('English');
  });

  test('a fresh profile with no saved source language defaults to Auto', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    // Seed a config that has real provider data (so it's distinguishable
    // from the onInstalled race per seedSettings' own contract) but
    // deliberately omits inputLanguage, so the popup's own
    // DEFAULT_SETTINGS.config.inputLanguage fallback is what fills it in.
    await seedSettings(
      worker,
      {
        backendUrl: 'http://localhost:7677', extensionEnabled: true, uiLanguage: 'en',
        config: { providerGroups: [{ provider: 'Google', apiKeys: [{ key: 'no-lang-seeded' }], enabled: true }] },
      },
      firstKeyMatches('no-lang-seeded'),
    );

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(popup.locator('#f-source')).toHaveValue('Auto');
  });

  test('the source field is visually emphasized while set to Auto, and un-emphasized otherwise', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({ config: { inputLanguage: 'Auto' } }),
      firstKeyMatches('seed-key'),
    );

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    const sourceInput = popup.locator('#f-source');
    await expect(sourceInput).toHaveClass(/lang-auto/);

    await sourceInput.fill('Japanese');
    await expect(sourceInput).not.toHaveClass(/lang-auto/);

    await sourceInput.fill('Auto');
    await expect(sourceInput).toHaveClass(/lang-auto/);
  });
});
