import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

// Adding/removing a provider group, API key, or Story DB row used to be an
// instant cut — a plain .remove() / appendChild() with no transition, the
// one list-editing interaction in the popup that hadn't gotten the same
// spring/fade treatment as everything else (tabs, toasts, the save status
// banner). animateRowEnter()/animateRowRemoval() in popup/index.ts now
// fade+collapse a removed row and pop a new one in instead.
test.describe('popup — list row add/remove animation', () => {
  test('removing an API key row fades/collapses it instead of vanishing on the same tick', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'LLM Config' }).click();

    const row = popup.locator('.backup-key-row').first();
    await expect(row).toBeVisible();
    await row.locator('.btn-remove-fallback').click();

    // Still attached right after the click — the fade/collapse hasn't run
    // yet. If this starts failing, the removal regressed back to instant.
    await expect(row).toHaveCount(1);

    // ...but actually gone shortly after.
    await expect(row).toHaveCount(0, { timeout: 1_000 });
  });

  test('adding a provider group pops it in with the row-enter animation', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'LLM Config' }).click();

    await popup.locator('#btn-add-provider-group').click();
    const newRow = popup.locator('.fallback-provider-row').last();
    await expect(newRow).toHaveClass(/row-enter/);
    // The class is removed once the entrance animation finishes (its
    // `animationend` listener) — not left on indefinitely.
    await expect(newRow).not.toHaveClass(/row-enter/, { timeout: 1_000 });
  });

  // Story DB rows (characters/relationships/glossary/notes) share the same
  // two helpers — this covers one as the representative case rather than
  // repeating the above for all four.
  test('removing a Story DB character row also fades/collapses it', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 's1' }), firstKeyMatches('seed-key'));

    await context.route('**/stories', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 's1', name: 'Story One', updated_at: 0 }]) });
    });
    await context.route('**/stories/s1', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          id: 's1', name: 'Story One', updated_at: 0,
          characters: [{ id: 'c1', name: 'Ren', gender: 'male', role: null, voice_notes: null }],
          relationships: [], glossary: [], continuity_notes: [],
        }),
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Story DB' }).click();

    const row = popup.locator('.story-char-row').first();
    await expect(row).toBeVisible({ timeout: 5_000 });
    await row.locator('.btn-remove-fallback').click();

    await expect(row).toHaveCount(1);
    await expect(row).toHaveCount(0, { timeout: 1_000 });
  });
});
