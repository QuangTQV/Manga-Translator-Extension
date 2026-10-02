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

  // Reordering via the move-up/move-down buttons used to teleport a row to
  // its new slot with a plain insertBefore() and zero motion. animateRowSwap()
  // now plays a short FLIP transform on both affected rows.
  test('moving a provider group up swaps its DOM order and plays a transform transition', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({
        config: {
          providerGroups: [
            { provider: 'Azure OpenAI', enabled: true, apiKeys: [{ key: 'azure-key-1', enabled: true }] },
            { provider: 'Google', enabled: true, apiKeys: [{ key: 'google-key-1', enabled: true }] },
          ],
        },
      }),
      firstKeyMatches('azure-key-1'),
    );

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'LLM Config' }).click();

    const rows = popup.locator('#provider-groups-list .fallback-provider-row');
    await expect(rows).toHaveCount(2);
    const secondRow = rows.nth(1);
    await expect(secondRow.locator('.fb-provider')).toHaveValue('Google');

    // Scoped to the row's own header — a provider row also nests its API
    // keys' own up/down buttons, which share the same class names.
    await secondRow.locator('.fallback-provider-row-header .btn-move-up').click();

    // The DOM order swaps immediately (the actual insertBefore runs
    // synchronously) — Google's row is now first...
    await expect(rows.nth(0).locator('.fb-provider')).toHaveValue('Google');
    // ...but it's still mid-flight: animateRowSwap sets `transition` right
    // before handing control back (so the browser actually animates the
    // transform it set a moment earlier), and only clears it once
    // `transitionend` fires — checking `style.transform` itself wouldn't
    // prove anything, since the JS already set it to its final value (`''`)
    // before this assertion runs; the lingering `transition` value is what's
    // observable synchronously.
    const transitionsRightAfter = await rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).style.transition));
    expect(transitionsRightAfter.some((t) => t.includes('transform'))).toBe(true);

    // Settled back to no inline transition shortly after.
    await expect.poll(async () => {
      const transitions = await rows.evaluateAll((els) => els.map((el) => (el as HTMLElement).style.transition));
      return transitions.every((t) => !t);
    }, { timeout: 1_000 }).toBe(true);
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

  // storyDraftBanner/storyDomainMismatchWarning/storyContentFields used to
  // snap via plain style.display with no transition — the one place in the
  // Story DB workflow (switch/save/draft-detection, all frequent) still
  // missing the opacity-fade treatment used everywhere else in the popup.
  test('the unsaved-draft banner fades out instead of vanishing on the same tick when discarded', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-1' }), firstKeyMatches('seed-key'));
    // Seed a draft directly in storage — equivalent to a previous popup
    // session having typed an unsaved edit, without re-running that flow here.
    await worker.evaluate(async () => {
      await chrome.storage.local.set({
        'mtStoryDraft:story-1': {
          name: 'My Manga', characters: [{ id: 'c1', name: 'Some typo I regret' }],
          relationships: [], glossary: [], continuityNotes: [], continuityNotesEnabled: false,
          updateDescription: '', savedAt: Date.now(),
        },
      });
    });
    await context.route('**/stories', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'story-1', name: 'My Manga', updated_at: 0 }]) });
    });
    await context.route('**/stories/story-1', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          id: 'story-1', name: 'My Manga', updated_at: 0,
          characters: [{ id: 'c1', name: 'Akira', gender: 'male', role: null, voice_notes: null }],
          relationships: [], glossary: [], continuity_notes: [], continuity_notes_enabled: false,
        }),
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Story DB' }).click();

    const banner = popup.locator('#story-draft-banner');
    await expect(banner).toBeVisible({ timeout: 5_000 });
    await expect(banner).toHaveCSS('opacity', '1');

    popup.on('dialog', (dialog) => { void dialog.accept(); });
    await popup.locator('#btn-story-draft-discard').click();

    // Fading, not gone yet.
    await expect(banner).toHaveCSS('opacity', '0');
    // Actually hidden shortly after (toBeHidden doesn't look at opacity —
    // this is checking the deferred display:none, not the fade itself).
    await expect(banner).toBeHidden({ timeout: 1_000 });
  });
});
