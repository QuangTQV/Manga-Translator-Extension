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
});
