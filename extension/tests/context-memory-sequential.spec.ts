import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

// Context Memory only works correctly if a later page can actually see an
// earlier page's summary — with the default parallel worker pool, a page
// routinely starts before an earlier one has finished writing its note
// (see content-script's autoTranslateSequentialForContextMemory), so this
// toggle forces one-page-at-a-time translation while Context Memory is on.
// Defaults to true: a silently-broken Context Memory (parallel, no note
// ever seen) is worse than an unexpectedly slower one.
test.describe('popup — Translate tab Context Memory sequential toggle', () => {
  test('defaults to on for a fresh profile even though not explicitly seeded', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

    await seedSettings(
      worker,
      baseSeed({
        config: {
          providerGroups: [{ provider: 'Google', enabled: true, apiKeys: [{ key: 'key-1', enabled: true }] }],
          contextMemoryEnabled: true,
          // contextMemorySequential deliberately omitted — must fall back to true.
        },
      }),
      firstKeyMatches('key-1'),
    );

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    await expect(popup.locator('#f-context-memory')).toBeChecked();
    await expect(popup.locator('#f-context-memory-sequential')).toBeChecked();
  });

  test('turning it off persists across a popup reload', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

    await seedSettings(
      worker,
      baseSeed({
        config: {
          providerGroups: [{ provider: 'Google', enabled: true, apiKeys: [{ key: 'key-1', enabled: true }] }],
          contextMemoryEnabled: true,
          contextMemorySequential: true,
        },
      }),
      firstKeyMatches('key-1'),
    );

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    const sequentialToggle = popup.locator('#f-context-memory-sequential');
    await expect(sequentialToggle).toBeChecked();
    // The visible control is a CSS toggle-switch built on a zero-size
    // <input>, which Playwright's pointer-based check()/uncheck() can't
    // click even with force — set the DOM state directly and fire the same
    // 'change' event the app's own click handling would produce.
    await sequentialToggle.evaluate((el: HTMLInputElement) => {
      el.checked = false;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    // autoSave() also fires on blur/tab-switch; give the async write a beat.
    await popup.waitForTimeout(300);

    const reloaded = await context.newPage();
    await reloaded.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(reloaded.locator('#f-context-memory-sequential')).not.toBeChecked();
    // Context Memory itself stays on — only the sequential-processing choice changed.
    await expect(reloaded.locator('#f-context-memory')).toBeChecked();
  });
});
