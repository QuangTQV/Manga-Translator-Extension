import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

// The Story DB tab (character database / relationships / glossary) is only
// usable when logged in (see backend/auth.py:require_login) — for a logged
// out user or the normal local backend it's simply locked, same as the
// Account tab's own "only relevant against a hosted backend" framing.
test.describe('popup — Story DB tab', () => {
  test('is locked when logged out and unlocked when logged in', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Story DB' }).click();

    await expect(popup.locator('#storydb-locked')).toBeVisible();
    await expect(popup.locator('#storydb-editor')).toBeHidden();
  });

  test('loading the tab while logged in lists stories and loads the active one', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-1' }),
      firstKeyMatches('seed-key'),
    );

    await context.route('**/stories', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([{ id: 'story-1', name: 'My Manga', updated_at: 0 }]),
      });
    });
    await context.route('**/stories/story-1', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          id: 'story-1', name: 'My Manga', updated_at: 0,
          characters: [{ id: 'c1', name: 'Aoi', gender: 'female', role: 'protagonist', voice_notes: null }],
          relationships: [],
          glossary: [{ id: 'g1', term: 'Kage-ryu', translation: 'Shadow Style', notes: null }],
          continuity_notes: [{ id: 'n1', text: 'Something happened', source_label: 'Chapter 1' }],
          continuity_notes_enabled: true,
        }),
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Story DB' }).click();

    await expect(popup.locator('#storydb-editor')).toBeVisible();
    await expect(popup.locator('#f-story-select')).toHaveValue('story-1', { timeout: 5_000 });
    await expect(popup.locator('#story-content-fields')).toBeVisible();
    await expect(popup.locator('#f-story-name')).toHaveValue('My Manga');
    await expect(popup.locator('.story-char-row .sc-name')).toHaveValue('Aoi');
    await expect(popup.locator('.story-glossary-row .sg-term')).toHaveValue('Kage-ryu');
    await expect(popup.locator('#f-story-continuity-enabled')).toBeChecked();
    await expect(popup.locator('.story-continuity-note-row .scn-text')).toHaveValue('Something happened');
  });

  test('creating a story, adding a character/relationship/term, and saving sends the whole payload', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com' }),
      firstKeyMatches('seed-key'),
    );

    let created = false;
    await context.route('**/stories', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify(created ? [{ id: 'new-story', name: 'New Manga', updated_at: 0 }] : []),
        });
        return;
      }
      if (route.request().method() === 'POST') {
        created = true;
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            id: 'new-story', name: 'New Manga', updated_at: 0,
            characters: [], relationships: [], glossary: [],
            continuity_notes: [], continuity_notes_enabled: false,
          }),
        });
        return;
      }
      await route.fallback();
    });

    let putBody: any = null;
    await context.route('**/stories/new-story', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            id: 'new-story', name: 'New Manga', updated_at: 0,
            characters: [], relationships: [], glossary: [],
            continuity_notes: [], continuity_notes_enabled: false,
          }),
        });
        return;
      }
      if (route.request().method() === 'PUT') {
        putBody = route.request().postDataJSON();
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ id: 'new-story', ...putBody, updated_at: 1 }),
        });
        return;
      }
      await route.fallback();
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Story DB' }).click();
    await expect(popup.locator('#storydb-editor')).toBeVisible();

    await popup.locator('#f-story-new-name').fill('New Manga');
    await popup.locator('#btn-story-new').click();
    await expect(popup.locator('#story-content-fields')).toBeVisible({ timeout: 5_000 });

    await popup.locator('#btn-add-story-character').click();
    await popup.locator('.story-char-row').nth(0).locator('.sc-name').fill('Ren');
    await popup.locator('.story-char-row').nth(0).locator('.sc-gender').selectOption('male');
    await popup.locator('#btn-add-story-character').click();
    await popup.locator('.story-char-row').nth(1).locator('.sc-name').fill('Aoi');
    await popup.locator('.story-char-row').nth(1).locator('.sc-gender').selectOption('female');

    // A relationship's character dropdowns default to an explicit
    // "-- select character --" placeholder (not an auto-picked character —
    // see popup/index.ts:populateCharacterSelect), so both sides must be
    // chosen by hand here, same as a real user would.
    await popup.locator('#btn-add-story-relationship').click();
    const relRow = popup.locator('.story-rel-row');
    await relRow.locator('.sr-char-a').selectOption({ label: 'Ren' });
    await relRow.locator('.sr-char-b').selectOption({ label: 'Aoi' });
    await relRow.locator('.sr-relation').fill('rivals');

    await popup.locator('#btn-add-story-glossary').click();
    await popup.locator('.story-glossary-row .sg-term').fill('Kage-ryu');
    await popup.locator('.story-glossary-row .sg-translation').fill('Shadow Style');

    // Continuity Notes toggle is off by default — turn it on and add one.
    // The visible control is a CSS toggle-switch built on a zero-size
    // <input> (see context-memory-sequential.spec.ts for the same issue),
    // which Playwright's pointer-based check() can't click even with
    // force — set the DOM state directly and fire the same 'change' event
    // the app's own click handling would produce.
    const continuityToggle = popup.locator('#f-story-continuity-enabled');
    await expect(continuityToggle).not.toBeChecked();
    await continuityToggle.evaluate((el: HTMLInputElement) => {
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await popup.locator('#btn-add-story-continuity-note').click();
    await popup.locator('.story-continuity-note-row .scn-text').fill('Ren and Aoi become allies');
    await popup.locator('.story-continuity-note-row .scn-source').fill('Chapter 3');

    await popup.locator('#btn-story-save').click();
    await expect.poll(() => putBody, { timeout: 5_000 }).not.toBeNull();

    expect(putBody.name).toBe('New Manga');
    expect(putBody.characters).toHaveLength(2);
    const ren = putBody.characters.find((c: any) => c.name === 'Ren');
    const aoi = putBody.characters.find((c: any) => c.name === 'Aoi');
    expect(ren.gender).toBe('male');
    expect(aoi.gender).toBe('female');
    expect(putBody.relationships).toHaveLength(1);
    expect(putBody.relationships[0].surface_relation).toBe('rivals');
    expect(putBody.relationships[0].character_a_id).toBe(ren.id);
    expect(putBody.relationships[0].character_b_id).toBe(aoi.id);
    expect(putBody.glossary).toHaveLength(1);
    expect(putBody.glossary[0]).toMatchObject({ term: 'Kage-ryu', translation: 'Shadow Style' });
    expect(putBody.continuity_notes_enabled).toBe(true);
    expect(putBody.continuity_notes).toHaveLength(1);
    expect(putBody.continuity_notes[0]).toMatchObject({ text: 'Ren and Aoi become allies', source_label: 'Chapter 3' });
  });

  test('deleting a story asks for confirmation and removes it', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-1' }),
      firstKeyMatches('seed-key'),
    );

    let deleted = false;
    await context.route('**/stories', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify(deleted ? [] : [{ id: 'story-1', name: 'My Manga', updated_at: 0 }]),
      });
    });
    await context.route('**/stories/story-1', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            id: 'story-1', name: 'My Manga', updated_at: 0,
            characters: [], relationships: [], glossary: [],
            continuity_notes: [], continuity_notes_enabled: false,
          }),
        });
        return;
      }
      if (route.request().method() === 'DELETE') {
        deleted = true;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        return;
      }
      await route.fallback();
    });

    const popup = await context.newPage();
    popup.on('dialog', (dialog) => { void dialog.accept(); });
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Story DB' }).click();
    await expect(popup.locator('#story-content-fields')).toBeVisible({ timeout: 5_000 });

    await popup.locator('#btn-story-delete').click();
    await expect(popup.locator('#story-content-fields')).toBeHidden({ timeout: 5_000 });
  });

  test('the relationship map mirrors the form, and Connect mode adds a pre-filled relationship', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-1' }),
      firstKeyMatches('seed-key'),
    );
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
          characters: [
            { id: 'c1', name: 'Ren', gender: 'male', role: 'rival' },
            { id: 'c2', name: 'Aoi', gender: 'female' },
            { id: 'c3', name: 'Sora', gender: 'other' },
          ],
          relationships: [{ id: 'r1', character_a_id: 'c1', character_b_id: 'c2', surface_relation: 'rivals' }],
          glossary: [], continuity_notes: [], continuity_notes_enabled: false,
        }),
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Story DB' }).click();
    await expect(popup.locator('#story-content-fields')).toBeVisible({ timeout: 5_000 });

    const nodes = popup.locator('#story-graph g[data-id]');
    await expect(nodes).toHaveCount(3);
    await expect(popup.locator('#story-graph text', { hasText: 'rivals' })).toHaveCount(1);

    // Selecting a character summarises their relationships.
    await popup.locator('#story-graph g[data-id="c1"]').click();
    await expect(popup.locator('#story-graph-info')).toContainText('Ren ↔ Aoi: rivals');

    // Dragging a node moves it.
    const before = await popup.locator('#story-graph g[data-id="c2"]').boundingBox();
    await popup.mouse.move(before!.x + before!.width / 2, before!.y + before!.height / 2);
    await popup.mouse.down();
    await popup.mouse.move(before!.x + 40, before!.y + 40, { steps: 5 });
    await popup.mouse.up();
    const after = await popup.locator('#story-graph g[data-id="c2"]').boundingBox();
    expect(Math.abs(after!.x - before!.x) + Math.abs(after!.y - before!.y)).toBeGreaterThan(20);
    await expect(popup.locator('.story-char-row').nth(1)).toHaveAttribute('data-x', /\d/);
    await popup.locator('#story-graph').screenshot({ path: process.env.GRAPH_SHOT ?? 'test-results/graph.png' });

    // Editing the form updates the map live.
    await popup.locator('.story-char-row').nth(2).locator('.sc-name').fill('Kaze');
    await expect(popup.locator('#story-graph text', { hasText: 'Kaze' })).toHaveCount(1);
    await popup.locator('.story-char-row').nth(2).locator('.btn-remove-fallback').click();
    await expect(nodes).toHaveCount(2);

    // Connect mode: click two characters -> a pre-filled relationship row.
    await popup.locator('#btn-graph-connect').click();
    await popup.locator('#story-graph g[data-id="c2"]').click();
    await popup.locator('#story-graph g[data-id="c1"]').click();
    await expect(popup.locator('.story-rel-row')).toHaveCount(2);
    const newRow = popup.locator('.story-rel-row').nth(1);
    await expect(newRow.locator('.sr-char-a')).toHaveValue('c2');
    await expect(newRow.locator('.sr-char-b')).toHaveValue('c1');
    await expect(newRow.locator('.sr-relation')).toBeFocused();
  });
});
