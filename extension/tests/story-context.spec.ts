import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { clickScannerAction } from './shadow-dom';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site/index.html')}`;

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
    const noteText = popup.locator('.story-continuity-note-row .scn-text');
    await expect(noteText).toHaveValue('Something happened');
    // A textarea, not a single-line input — a continuity note is often a full
    // sentence or two, and a single-line input just clips/scrolls it
    // horizontally instead of showing it (reported by the repo owner).
    await expect(noteText).toHaveJSProperty('tagName', 'TEXTAREA');
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
    await popup.locator('#story-graph').scrollIntoViewIfNeeded();
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

  test('character avatar and reference images can be added, show on the map, and are saved', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-1' }),
      firstKeyMatches('seed-key'),
    );
    const detail = {
      id: 'story-1', name: 'My Manga', updated_at: 0,
      characters: [{ id: 'c1', name: 'Aoi', gender: 'female' }],
      relationships: [], glossary: [], continuity_notes: [], continuity_notes_enabled: false,
    };
    await context.route('**/stories', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'story-1', name: 'My Manga', updated_at: 0 }]) });
    });
    let putBody: any = null;
    await context.route('**/stories/story-1', async (route) => {
      if (route.request().method() === 'PUT') {
        putBody = route.request().postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...detail, ...putBody }) });
        return;
      }
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(detail) });
    });

    // A real (4x4 red) PNG, so createImageBitmap can decode it.
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAAEElEQVR4nGP4z8AARwzEcQCukw/x0F8jngAAAABJRU5ErkJggg==', 'base64');

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Story DB' }).click();
    await expect(popup.locator('.story-char-row')).toHaveCount(1, { timeout: 5_000 });

    const row = popup.locator('.story-char-row').first();
    const [avatarChooser] = await Promise.all([popup.waitForEvent('filechooser'), row.locator('.sc-add-btn.round').click()]);
    await avatarChooser.setFiles({ name: 'a.png', mimeType: 'image/png', buffer: png });
    await expect(row.locator('.sc-thumb.round img')).toBeVisible();
    await expect(popup.locator('#story-graph image')).toHaveCount(1);

    for (let i = 0; i < 2; i++) {
      const [refChooser] = await Promise.all([popup.waitForEvent('filechooser'), row.locator('.sc-add-btn:not(.round)').click()]);
      await refChooser.setFiles({ name: `r${i}.png`, mimeType: 'image/png', buffer: png });
      await expect(row.locator('.sc-thumb:not(.round)')).toHaveCount(i + 1);
    }
    // The cap is 2 per character: the add button goes away.
    await expect(row.locator('.sc-add-btn:not(.round)')).toHaveCount(0);

    await popup.locator('#btn-story-save').click();
    await expect.poll(() => putBody, { timeout: 5_000 }).not.toBeNull();
    expect(putBody.characters[0].avatar).toMatch(/^data:image\/jpeg;base64,/);
    expect(putBody.characters[0].reference_images).toHaveLength(2);

    // Removing the avatar clears it from the map too.
    await row.locator('.sc-thumb.round .sc-thumb-x').click();
    await expect(popup.locator('#story-graph image')).toHaveCount(0);
  });

  for (const enabled of [true, false]) {
    test(`translate requests ${enabled ? 'carry' : 'omit'} story_use_reference_images when the toggle is ${enabled ? 'on' : 'off'}`, async ({ context, extensionId }) => {
      let [worker] = context.serviceWorkers();
      if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
      await seedSettings(
        worker,
        baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-1', config: { useStoryDb: true, useStoryReferenceImages: enabled } }),
        firstKeyMatches('seed-key'),
      );
      let capturedBody: any = null;
      await context.route('**/translate', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        capturedBody = route.request().postDataJSON();
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            translated_image: FAKE_TRANSLATED_IMAGE_B64, bubbles: [], processing_time_seconds: 0.1,
            source_language: 'Japanese', target_language: 'English', provider: 'Google', ocr_texts: [], memory_note: null,
          }),
        });
      });

      const mangaPage = await context.newPage();
      await mangaPage.goto(TEST_SITE_URL);
      const popup = await context.newPage();
      await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
      await popup.getByRole('button', { name: 'Story DB' }).click();
      if (enabled) await expect(popup.locator('#f-story-ref-images')).toBeChecked();
      else await expect(popup.locator('#f-story-ref-images')).not.toBeChecked();

      await popup.locator('.tab-btn[data-tab="translate"]').click();
      await mangaPage.bringToFront();
      await popup.locator('#btn-scan').click();
      await mangaPage.waitForTimeout(1500);
      const cdp = await context.newCDPSession(mangaPage);
      await cdp.send('DOM.enable');
      await clickScannerAction(mangaPage, cdp, 'select-all');
      await mangaPage.waitForTimeout(150);
      await clickScannerAction(mangaPage, cdp, 'translate');
      await mangaPage.waitForTimeout(2000);

      expect(capturedBody).toBeTruthy();
      expect(capturedBody.story_id).toBe('story-1');
      if (enabled) expect(capturedBody.story_use_reference_images).toBe(true);
      else expect(capturedBody.story_use_reference_images).toBeUndefined();
    });
  }

  test('the Translate tab\'s "Use Story DB" toggle is off by default, and no story_id is sent while it\'s off even with a story selected', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    // Note: no useStoryDb in the seed — defaults to unset/false.
    await seedSettings(
      worker,
      baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-1' }),
      firstKeyMatches('seed-key'),
    );
    let capturedBody: any = null;
    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      capturedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          translated_image: FAKE_TRANSLATED_IMAGE_B64, bubbles: [], processing_time_seconds: 0.1,
          source_language: 'Japanese', target_language: 'English', provider: 'Google', ocr_texts: [], memory_note: null,
        }),
      });
    });

    const mangaPage = await context.newPage();
    await mangaPage.goto(TEST_SITE_URL);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(popup.locator('#f-use-story-db')).not.toBeChecked();

    await mangaPage.bringToFront();
    await popup.locator('#btn-scan').click();
    await mangaPage.waitForTimeout(1500);
    const cdp = await context.newCDPSession(mangaPage);
    await cdp.send('DOM.enable');
    await clickScannerAction(mangaPage, cdp, 'select-all');
    await mangaPage.waitForTimeout(150);
    await clickScannerAction(mangaPage, cdp, 'translate');
    await mangaPage.waitForTimeout(2000);

    expect(capturedBody).toBeTruthy();
    expect(capturedBody.story_id).toBeUndefined();
  });
});

test.describe('popup — Story DB update from description', () => {
  test('drafts characters/relationships/continuity note from a free-text update and merges them into the form', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({
        accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-1',
        config: { providerGroups: [{ provider: 'Google', modelName: 'gemini-3.1-flash', enabled: true, apiKeys: [{ key: 'k1', enabled: true }] }] },
      }),
      firstKeyMatches('k1'),
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
          characters: [{ id: 'c-akira', name: 'Akira', gender: 'male' }],
          relationships: [], glossary: [], continuity_notes: [], continuity_notes_enabled: false,
        }),
      });
    });

    let capturedBody: any = null;
    await context.route('**/stories/update-from-description', async (route) => {
      capturedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          characters: [
            { id: 'c-akira', name: 'Akira', gender: 'male', role: 'protagonist' },
            { id: 'c-hina', name: 'Hina', gender: 'female', role: 'antagonist' },
          ],
          relationships: [{ id: 'r1', character_a_id: 'c-akira', character_b_id: 'c-hina', surface_relation: 'secret enemies', address_notes: 'ta/ngươi now' }],
          continuity_note: { id: 'n1', text: 'Hina is revealed as the mastermind.', source_label: 'Chapter 39' },
        }),
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Story DB' }).click();
    await expect(popup.locator('#story-content-fields')).toBeVisible({ timeout: 5_000 });
    await expect(popup.locator('.story-char-row')).toHaveCount(1);

    await popup.locator('#f-story-update-description').fill("Update up to chapter 39: Hina turns out to be the villain, Akira's childhood friend.");
    await popup.locator('#f-story-update-web-search').check({ force: true });
    await popup.locator('#btn-story-update-from-description').click();

    await expect(popup.locator('.story-char-row')).toHaveCount(2, { timeout: 5_000 });
    await expect(popup.locator('.story-char-row').nth(1).locator('.sc-name')).toHaveValue('Hina');
    await expect(popup.locator('.story-rel-row')).toHaveCount(1);
    await expect(popup.locator('.story-rel-row .sr-relation')).toHaveValue('secret enemies');
    await expect(popup.locator('.story-continuity-note-row')).toHaveCount(1);
    await expect(popup.locator('.story-continuity-note-row .scn-text')).toHaveValue('Hina is revealed as the mastermind.');
    await expect(popup.locator('#f-story-update-description')).toHaveValue('');

    expect(capturedBody.description).toContain('villain');
    expect(capturedBody.provider).toBe('Google');
    expect(capturedBody.api_key).toBe('k1');
    expect(capturedBody.characters).toHaveLength(1); // what was in the form before the update
    expect(capturedBody.enable_web_search).toBe(true);
    expect(capturedBody.story_title).toBe('My Manga');
  });

  test('shows an error and does not touch the form when the description is empty', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-1' }), firstKeyMatches('seed-key'));
    await context.route('**/stories', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'story-1', name: 'My Manga', updated_at: 0 }]) });
    });
    await context.route('**/stories/story-1', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ id: 'story-1', name: 'My Manga', updated_at: 0, characters: [], relationships: [], glossary: [], continuity_notes: [], continuity_notes_enabled: false }),
      });
    });
    let called = false;
    await context.route('**/stories/update-from-description', async (route) => { called = true; await route.abort(); });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Story DB' }).click();
    await expect(popup.locator('#story-content-fields')).toBeVisible({ timeout: 5_000 });
    await popup.locator('#btn-story-update-from-description').click();
    await expect(popup.locator('#story-update-status')).toContainText('Describe what happened');
    expect(called).toBe(false);
  });
});

test('a character with explicit x/y: null (the real backend\'s JSON shape) still gets a valid default graph position, not NaN', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-1' }), firstKeyMatches('seed-key'));
  await context.route('**/stories', async (route) => {
    if (route.request().method() !== 'GET') { await route.fallback(); return; }
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'story-1', name: 'My Manga', updated_at: 0 }]) });
  });
  await context.route('**/stories/story-1', async (route) => {
    if (route.request().method() !== 'GET') { await route.fallback(); return; }
    // Pydantic serialises an unset Optional[float] field as JSON null, not
    // by omitting the key — this is the real backend's actual response
    // shape (unlike a hand-written test fixture that just leaves x/y out).
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        id: 'story-1', name: 'My Manga', updated_at: 0,
        characters: [{ id: 'c1', name: 'Akira', gender: 'male', role: null, voice_notes: null, x: null, y: null, avatar: null, reference_images: [] }],
        relationships: [], glossary: [], continuity_notes: [], continuity_notes_enabled: false,
      }),
    });
  });

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await popup.getByRole('button', { name: 'Story DB' }).click();
  await expect(popup.locator('.story-char-row')).toHaveCount(1, { timeout: 5_000 });
  await expect(popup.locator('.story-char-row')).not.toHaveAttribute('data-x', /.*/);

  const node = popup.locator('#story-graph g[data-id="c1"]');
  await expect(node).toHaveCount(1);
  const transform = await node.getAttribute('transform');
  expect(transform).not.toContain('NaN');
  const box = await node.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(0);
});

test.describe('popup — Story DB unsaved-draft recovery', () => {
  test('typed changes survive closing and reopening the popup, and Save story clears the draft', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-1' }), firstKeyMatches('seed-key'));
    await context.route('**/stories', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'story-1', name: 'My Manga', updated_at: 0 }]) });
    });
    let putBody: any = null;
    let serverCharacters: any[] = [{ id: 'c1', name: 'Akira', gender: 'male', role: null, voice_notes: null, x: null, y: null, avatar: null, reference_images: [] }];
    await context.route('**/stories/story-1', async (route) => {
      if (route.request().method() === 'GET') {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({
            id: 'story-1', name: 'My Manga', updated_at: 0,
            characters: serverCharacters,
            relationships: [], glossary: [], continuity_notes: [], continuity_notes_enabled: false,
          }),
        });
        return;
      }
      if (route.request().method() === 'PUT') {
        putBody = route.request().postDataJSON();
        serverCharacters = putBody.characters;
        await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'story-1', ...putBody, updated_at: 1 }) });
        return;
      }
      await route.fallback();
    });

    // First "session": open the popup, edit something, and add a character —
    // but close the popup (a Chrome action popup is destroyed, not just
    // hidden, the moment it loses focus) before ever clicking Save story.
    const popup1 = await context.newPage();
    await popup1.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup1.getByRole('button', { name: 'Story DB' }).click();
    await expect(popup1.locator('.story-char-row')).toHaveCount(1, { timeout: 5_000 });
    await popup1.locator('.story-char-row .sc-name').fill('Akira the Bold');
    await popup1.locator('#btn-add-story-character').click();
    await popup1.locator('.story-char-row').nth(1).locator('.sc-name').fill('Hina');
    await popup1.waitForTimeout(700); // debounced draft save
    await popup1.close();

    // Second "session": reopen — the unsaved edits should come back, with a
    // visible "restored a draft" banner.
    const popup2 = await context.newPage();
    await popup2.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup2.getByRole('button', { name: 'Story DB' }).click();
    await expect(popup2.locator('#story-draft-banner')).toBeVisible({ timeout: 5_000 });
    // Regression check: the Discard button reuses .btn-add-fallback (which
    // defaults to width:100%) with an inline `flex:none` that doesn't cancel
    // that width — without an explicit `width:auto` override too, the button
    // claims almost the whole row and squeezes the banner's message text
    // down to one word per line. A single line's worth of height is enough
    // room for the whole sentence; several times that means it's wrapping
    // badly again.
    const bannerTextHeight = await popup2.locator('#story-draft-banner span').evaluate((el) => el.getBoundingClientRect().height);
    expect(bannerTextHeight).toBeLessThan(40);
    await expect(popup2.locator('.story-char-row')).toHaveCount(2);
    await expect(popup2.locator('.story-char-row').nth(0).locator('.sc-name')).toHaveValue('Akira the Bold');
    await expect(popup2.locator('.story-char-row').nth(1).locator('.sc-name')).toHaveValue('Hina');

    // Saving commits it for real and clears the draft.
    await popup2.locator('#btn-story-save').click();
    await expect.poll(() => putBody, { timeout: 5_000 }).not.toBeNull();
    expect(putBody.characters).toHaveLength(2);
    await expect(popup2.locator('#story-draft-banner')).toBeHidden();

    const popup3 = await context.newPage();
    await popup3.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup3.getByRole('button', { name: 'Story DB' }).click();
    await expect(popup3.locator('.story-char-row')).toHaveCount(2, { timeout: 5_000 });
    await expect(popup3.locator('#story-draft-banner')).toBeHidden();
  });

  test('Discard drops the draft and reloads the story fresh from the server', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-1' }), firstKeyMatches('seed-key'));
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
          characters: [{ id: 'c1', name: 'Akira', gender: 'male', role: null, voice_notes: null, x: null, y: null, avatar: null, reference_images: [] }],
          relationships: [], glossary: [], continuity_notes: [], continuity_notes_enabled: false,
        }),
      });
    });

    const popup1 = await context.newPage();
    await popup1.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup1.getByRole('button', { name: 'Story DB' }).click();
    await expect(popup1.locator('.story-char-row')).toHaveCount(1, { timeout: 5_000 });
    await popup1.locator('.story-char-row .sc-name').fill('Some typo I regret');
    await popup1.waitForTimeout(700);
    await popup1.close();

    const popup2 = await context.newPage();
    await popup2.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup2.getByRole('button', { name: 'Story DB' }).click();
    await expect(popup2.locator('#story-draft-banner')).toBeVisible({ timeout: 5_000 });
    await expect(popup2.locator('.story-char-row .sc-name')).toHaveValue('Some typo I regret');

    popup2.on('dialog', (dialog) => { void dialog.accept(); });
    await popup2.locator('#btn-story-draft-discard').click();
    await expect(popup2.locator('#story-draft-banner')).toBeHidden({ timeout: 5_000 });
    await expect(popup2.locator('.story-char-row .sc-name')).toHaveValue('Akira');
  });
});

test.describe('popup — Story DB undo/redo', () => {
  test('Undo steps back through debounced edits, Redo steps forward, and a new edit clears redo', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-1' }), firstKeyMatches('seed-key'));
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
          characters: [{ id: 'c1', name: 'Akira', gender: 'male', role: null, voice_notes: null, x: null, y: null, avatar: null, reference_images: [] }],
          relationships: [], glossary: [], continuity_notes: [], continuity_notes_enabled: false,
        }),
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Story DB' }).click();
    await expect(popup.locator('.story-char-row')).toHaveCount(1, { timeout: 5_000 });
    await expect(popup.locator('#btn-story-undo')).toBeDisabled();
    await expect(popup.locator('#btn-story-redo')).toBeDisabled();

    // Edit 1: rename the character (a settled, debounced checkpoint).
    await popup.locator('.story-char-row .sc-name').fill('Akira the Bold');
    await popup.waitForTimeout(700);
    await expect(popup.locator('#btn-story-undo')).toBeEnabled();

    // Edit 2: add a second character (a structural change via the observer).
    await popup.locator('#btn-add-story-character').click();
    await popup.locator('.story-char-row').nth(1).locator('.sc-name').fill('Hina');
    await popup.waitForTimeout(700);
    await expect(popup.locator('.story-char-row')).toHaveCount(2);

    // Undo #1: back to just "Akira the Bold", one character.
    await popup.locator('#btn-story-undo').click();
    await expect(popup.locator('.story-char-row')).toHaveCount(1);
    await expect(popup.locator('.story-char-row .sc-name')).toHaveValue('Akira the Bold');
    await expect(popup.locator('#btn-story-redo')).toBeEnabled();

    // Undo #2: back to the original loaded name.
    await popup.locator('#btn-story-undo').click();
    await expect(popup.locator('.story-char-row .sc-name')).toHaveValue('Akira');
    await expect(popup.locator('#btn-story-undo')).toBeDisabled();

    // Redo brings back "Akira the Bold".
    await popup.locator('#btn-story-redo').click();
    await expect(popup.locator('.story-char-row .sc-name')).toHaveValue('Akira the Bold');
    await expect(popup.locator('.story-char-row')).toHaveCount(1);

    // A fresh edit after an undo clears the redo stack.
    await popup.locator('.story-char-row .sc-name').fill('Someone else entirely');
    await popup.waitForTimeout(700);
    await expect(popup.locator('#btn-story-redo')).toBeDisabled();

    // Ctrl+Z / Ctrl+Shift+Z keyboard shortcuts work too.
    await popup.locator('.story-char-row .sc-name').press('Control+z');
    await expect(popup.locator('.story-char-row .sc-name')).toHaveValue('Akira the Bold');
    await popup.locator('.story-char-row .sc-name').press('Control+Shift+z');
    await expect(popup.locator('.story-char-row .sc-name')).toHaveValue('Someone else entirely');
  });

  test('switching to a different story resets the undo/redo history', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-1' }), firstKeyMatches('seed-key'));
    await context.route('**/stories', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'story-1', name: 'Story One', updated_at: 0 }, { id: 'story-2', name: 'Story Two', updated_at: 0 }]) });
    });
    await context.route('**/stories/story-1', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'story-1', name: 'Story One', updated_at: 0, characters: [], relationships: [], glossary: [], continuity_notes: [], continuity_notes_enabled: false }) });
    });
    await context.route('**/stories/story-2', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ id: 'story-2', name: 'Story Two', updated_at: 0, characters: [], relationships: [], glossary: [], continuity_notes: [], continuity_notes_enabled: false }) });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Story DB' }).click();
    await expect(popup.locator('#story-content-fields')).toBeVisible({ timeout: 5_000 });

    await popup.locator('#btn-add-story-character').click();
    await popup.locator('.story-char-row .sc-name').fill('Someone');
    await popup.waitForTimeout(700);
    await expect(popup.locator('#btn-story-undo')).toBeEnabled();

    await popup.locator('#f-story-select').selectOption('story-2');
    await expect(popup.locator('#f-story-name')).toHaveValue('Story Two', { timeout: 5_000 });
    await expect(popup.locator('#btn-story-undo')).toBeDisabled();
    await expect(popup.locator('#btn-story-redo')).toBeDisabled();
  });
});

// "Active story" is one global selection, not per-site, so nothing stops a
// user from forgetting to switch it when they move from reading one manga to
// another — this warns (without auto-switching) when the currently active
// tab's domain was last translated using a different story than the one
// currently selected.
test.describe('popup — Story DB per-site mismatch warning', () => {
  test('warns when the active tab\'s domain was last translated with a different story, and clears once the matching story is selected', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-2', config: { useStoryDb: true } }),
      firstKeyMatches('seed-key'),
    );
    // Simulate a prior real translate on this domain having recorded story-1
    // as the one actually used there (background/index.ts's recordStoryDomainUsage).
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ mtStoryDomainMap: { 'example-manga-site.test': 'story-1' } });
    });

    await context.route('**/stories', async (route) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([
          { id: 'story-1', name: 'Seirei Gensouki', updated_at: 0 },
          { id: 'story-2', name: 'One Piece', updated_at: 0 },
        ]),
      });
    });
    for (const [id, name] of [['story-1', 'Seirei Gensouki'], ['story-2', 'One Piece']]) {
      await context.route(`**/stories/${id}`, async (route) => {
        if (route.request().method() !== 'GET') { await route.fallback(); return; }
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ id, name, updated_at: 0, characters: [], relationships: [], glossary: [], continuity_notes: [], continuity_notes_enabled: false }),
        });
      });
    }
    // The navigation itself is intercepted too — no real network/DNS needed
    // for a fake domain, Playwright just needs *some* response to load.
    await context.route('https://example-manga-site.test/**', async (route) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body>Manga page</body></html>' });
    });

    const mangaPage = await context.newPage();
    await mangaPage.goto('https://example-manga-site.test/chapter-1');

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    // The check runs once automatically on popup load — reload after making
    // the manga page the active tab so chrome.tabs.query({active:true, ...})
    // resolves to it, not to the popup's own tab (which was the most
    // recently created/navigated one until now).
    await mangaPage.bringToFront();
    await popup.reload();
    await popup.getByRole('button', { name: 'Story DB' }).click();

    const warning = popup.locator('#story-domain-mismatch-warning');
    await expect(warning).toBeVisible({ timeout: 5_000 });
    await expect(warning).toContainText('Seirei Gensouki');
    await expect(warning).toContainText('example-manga-site.test');

    await popup.locator('#f-story-select').selectOption({ label: 'Seirei Gensouki' });
    await expect(popup.locator('#f-story-name')).toHaveValue('Seirei Gensouki', { timeout: 5_000 });
    await expect(warning).toBeHidden();
  });

  test('a real translate request records its page domain against the story that was used', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-1' }),
      firstKeyMatches('seed-key'),
    );
    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          translated_image: FAKE_TRANSLATED_IMAGE_B64, bubbles: [], processing_time_seconds: 0.1,
          source_language: 'Japanese', target_language: 'English', provider: 'Google', ocr_texts: [], memory_note: null,
        }),
      });
    });
    // Bypasses the scanner UI and the actual manga page on purpose — this
    // test is only about background/index.ts:recordStoryDomainUsage actually
    // firing on a real translate call, not about how the request gets
    // triggered. Sent from a popup page rather than the manga page itself
    // (a regular page has no chrome.runtime access at all, only an injected
    // content script does) — chrome.runtime.sendMessage refuses to deliver a
    // message back to the exact same script that sent it ("Receiving end
    // does not exist"), so this can't be sent from the worker's own context.
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    const sendResult = await popup.evaluate(async () => {
      return new Promise<{ response: unknown; lastError?: string }>((resolve) => {
        chrome.runtime.sendMessage(
          { type: 'TRANSLATE_IMAGE_WITH_BODY', imageUrl: 'https://another-manga-site.test/page1.jpg', pageUrl: 'https://another-manga-site.test/chapter-1', body: { image: 'ZmFrZQ==', story_id: 'story-1' } },
          (response: unknown) => resolve({ response, lastError: chrome.runtime.lastError?.message }),
        );
      });
    });
    expect(sendResult.lastError).toBeUndefined();

    const map = await worker.evaluate(async () => {
      const result = await chrome.storage.local.get('mtStoryDomainMap');
      return result.mtStoryDomainMap;
    });
    expect(map).toMatchObject({ 'another-manga-site.test': 'story-1' });
  });
});
