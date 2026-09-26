import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { clickScannerAction } from './shadow-dom';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site/index.html')}`;
const SINGLE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;

// A batch of translator-focused features kept out of the main tabs, in a new
// "Pro" tab (per the repo owner's UI-placement decision) or wherever they
// were already contextual (export toolbar, Story DB tab, the manual region
// editor). See MEMORY.md's roadmap section.
test.describe('Pro-tab settings', () => {
  test('supersampling factor persists across reload and is sent with a translate request', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Pro' }).click();
    await expect(popup.locator('#f-supersampling')).toHaveValue('4');

    await popup.locator('#f-supersampling').selectOption('1');
    await popup.waitForTimeout(300);

    const reloaded = await context.newPage();
    await reloaded.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await reloaded.getByRole('button', { name: 'Pro' }).click();
    await expect(reloaded.locator('#f-supersampling')).toHaveValue('1');

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
    await mangaPage.bringToFront();
    await reloaded.locator('.tab-btn[data-tab="translate"]').click();
    await reloaded.locator('#btn-scan').click();
    await mangaPage.waitForTimeout(1500);
    const cdp = await context.newCDPSession(mangaPage);
    await cdp.send('DOM.enable');
    await clickScannerAction(mangaPage, cdp, 'select-all');
    await mangaPage.waitForTimeout(150);
    await clickScannerAction(mangaPage, cdp, 'translate');
    await mangaPage.waitForTimeout(2000);

    expect(capturedBody).toBeTruthy();
    expect(capturedBody.supersampling_factor).toBe(1);
  });

  test('replacement dictionaries persist across reload and are sent as pre_/post_replacements', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Pro' }).click();
    await popup.locator('#f-post-replacements').fill('Akila => Akira\n/\\s+!/ => !');
    await popup.locator('#f-post-replacements').blur();
    await popup.locator('#f-pre-replacements').fill('アキラ => 晃');
    await popup.locator('#f-pre-replacements').blur();
    await popup.waitForTimeout(300);

    const reloaded = await context.newPage();
    await reloaded.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await reloaded.getByRole('button', { name: 'Pro' }).click();
    await expect(reloaded.locator('#f-post-replacements')).toHaveValue('Akila => Akira\n/\\s+!/ => !');
    await expect(reloaded.locator('#f-pre-replacements')).toHaveValue('アキラ => 晃');

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
    await mangaPage.goto(SINGLE_URL);
    await mangaPage.bringToFront();
    await reloaded.locator('.tab-btn[data-tab="translate"]').click();
    await reloaded.locator('#btn-scan').click();
    await mangaPage.waitForTimeout(1500);
    const cdp = await context.newCDPSession(mangaPage);
    await cdp.send('DOM.enable');
    await clickScannerAction(mangaPage, cdp, 'select-all');
    await mangaPage.waitForTimeout(150);
    await clickScannerAction(mangaPage, cdp, 'translate');
    await mangaPage.waitForTimeout(2000);

    expect(capturedBody).toBeTruthy();
    expect(capturedBody.post_replacements).toBe('Akila => Akira\n/\\s+!/ => !');
    expect(capturedBody.pre_replacements).toBe('アキラ => 晃');
  });
});

test.describe('Pro-tab lettering', () => {
  test('lettering options persist, color pickers appear only for Custom, and the choices are sent with a translate request', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Pro' }).click();
    await expect(popup.locator('#f-lettering-text-color')).toBeHidden();
    await expect(popup.locator('#f-lettering-outline-color-mode')).toBeHidden();

    await popup.locator('#f-lettering-uppercase').evaluate((el: HTMLInputElement) => {
      el.checked = true;
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await popup.locator('#f-lettering-align').selectOption('left');
    await popup.locator('#f-lettering-text-color-mode').selectOption('custom');
    await expect(popup.locator('#f-lettering-text-color')).toBeVisible();
    await popup.locator('#f-lettering-text-color').evaluate((el: HTMLInputElement) => {
      el.value = '#112233';
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await popup.locator('#f-lettering-outline-width').selectOption('2');
    await expect(popup.locator('#f-lettering-outline-color-mode')).toBeVisible();
    await expect(popup.locator('#f-lettering-outline-color')).toBeHidden();
    await popup.waitForTimeout(300);

    const reloaded = await context.newPage();
    await reloaded.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await reloaded.getByRole('button', { name: 'Pro' }).click();
    await expect(reloaded.locator('#f-lettering-uppercase')).toBeChecked();
    await expect(reloaded.locator('#f-lettering-align')).toHaveValue('left');
    await expect(reloaded.locator('#f-lettering-text-color-mode')).toHaveValue('custom');
    await expect(reloaded.locator('#f-lettering-text-color')).toHaveValue('#112233');
    await expect(reloaded.locator('#f-lettering-outline-width')).toHaveValue('2');
    await expect(reloaded.locator('#f-lettering-outline-color-mode')).toHaveValue('auto');

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
    await mangaPage.goto(SINGLE_URL);
    await mangaPage.bringToFront();
    await reloaded.locator('.tab-btn[data-tab="translate"]').click();
    await reloaded.locator('#btn-scan').click();
    await mangaPage.waitForTimeout(1500);
    const cdp = await context.newCDPSession(mangaPage);
    await cdp.send('DOM.enable');
    await clickScannerAction(mangaPage, cdp, 'select-all');
    await mangaPage.waitForTimeout(150);
    await clickScannerAction(mangaPage, cdp, 'translate');
    await mangaPage.waitForTimeout(2000);

    expect(capturedBody).toBeTruthy();
    expect(capturedBody.lettering_uppercase).toBe(true);
    expect(capturedBody.lettering_align).toBe('left');
    expect(capturedBody.lettering_text_color).toBe('#112233');
    expect(capturedBody.lettering_outline_width).toBe(2);
    expect(capturedBody.lettering_outline_color).toBeUndefined();
  });
});

test.describe('CBZ export', () => {
  // The 4-page test-site fixture auto-translates concurrently and is flaky
  // for anything timing-sensitive (see CLAUDE.md) — the single-image fixture
  // is enough to prove the export is a real, correctly-named CBZ; the
  // index-based (not URL-derived) naming is checked from its contents,
  // reusing the same jszip the extension itself bundles.
  test('exports as a numbered .cbz, not the (URL-derived) filename a plain-ZIP export would use', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    await context.route('**/translate', async (route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          translated_image: FAKE_TRANSLATED_IMAGE_B64, bubbles: [], processing_time_seconds: 0.1,
          source_language: 'Japanese', target_language: 'English', provider: 'Google', ocr_texts: [],
        }),
      });
    });

    const mangaPage = await context.newPage();
    await mangaPage.goto(SINGLE_URL);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    await mangaPage.bringToFront();
    await popup.locator('#btn-scan').click();
    await mangaPage.waitForTimeout(1500);
    const cdp = await context.newCDPSession(mangaPage);
    await cdp.send('DOM.enable');
    await clickScannerAction(mangaPage, cdp, 'select-all');
    await mangaPage.waitForTimeout(150);
    await clickScannerAction(mangaPage, cdp, 'translate');
    // "Export CBZ" is always present in the toolbar (clicking it before any
    // page finished translating just toasts "nothing translated yet" and
    // does nothing) — wait for the completion toast, a safe point well
    // before the scanner's ~2.5s auto-close, instead of a guessed delay.
    await expect(mangaPage.locator('#mt-toast')).toBeVisible({ timeout: 5_000 });
    const [download] = await Promise.all([
      mangaPage.waitForEvent('download'),
      clickScannerAction(mangaPage, cdp, 'export-cbz'),
    ]);
    expect(download.suggestedFilename()).toMatch(/^manga-translated-\d{4}-\d{2}-\d{2}\.cbz$/);

    const downloadPath = await download.path();
    const fs = await import('node:fs');
    const JSZip = (await import('jszip')).default;
    const zip = await JSZip.loadAsync(fs.readFileSync(downloadPath!));
    expect(Object.keys(zip.files)).toEqual(['page_001.png']);
  });
});

test.describe('PDF export', () => {
  // Hand-rolled PDF (see content-script/index.ts:buildPdf) rather than a
  // library — verified with a real PDF parser (pdf-lib, a test-only
  // devDependency), not just a magic-byte/regex check, so a structural
  // mistake in the hand-written xref/object syntax would actually be caught.
  test('exports a real, parseable PDF with one page per translated image', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    await context.route('**/translate', async (route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          translated_image: FAKE_TRANSLATED_IMAGE_B64, bubbles: [], processing_time_seconds: 0.1,
          source_language: 'Japanese', target_language: 'English', provider: 'Google', ocr_texts: [],
        }),
      });
    });

    const mangaPage = await context.newPage();
    await mangaPage.goto(SINGLE_URL);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    await mangaPage.bringToFront();
    await popup.locator('#btn-scan').click();
    await mangaPage.waitForTimeout(1500);
    const cdp = await context.newCDPSession(mangaPage);
    await cdp.send('DOM.enable');
    await clickScannerAction(mangaPage, cdp, 'select-all');
    await mangaPage.waitForTimeout(150);
    await clickScannerAction(mangaPage, cdp, 'translate');
    await expect(mangaPage.locator('#mt-toast')).toBeVisible({ timeout: 5_000 });

    const [download] = await Promise.all([
      mangaPage.waitForEvent('download'),
      clickScannerAction(mangaPage, cdp, 'export-pdf'),
    ]);
    expect(download.suggestedFilename()).toMatch(/^manga-translated-\d{4}-\d{2}-\d{2}\.pdf$/);

    const downloadPath = await download.path();
    const fs = await import('node:fs');
    const { PDFDocument } = await import('pdf-lib');
    const pdfDoc = await PDFDocument.load(fs.readFileSync(downloadPath!));
    expect(pdfDoc.getPageCount()).toBe(1);
    // The fixture is a 1x1 PNG re-encoded to JPEG — the page's MediaBox uses
    // the image's pixel dimensions directly as points (see buildPdf).
    const { width, height } = pdfDoc.getPage(0).getSize();
    expect(width).toBe(1);
    expect(height).toBe(1);
  });
});

test.describe('Story DB import/export', () => {
  test('Export downloads a JSON file with the current form contents, and Import fills the form back in', async ({ context, extensionId }) => {
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
          characters: [{ id: 'c1', name: 'Aoi', gender: 'female' }],
          relationships: [], glossary: [{ id: 'g1', term: 'Kage-ryu', translation: 'Shadow Style', notes: null }],
          continuity_notes: [], continuity_notes_enabled: false,
        }),
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Story DB' }).click();
    await expect(popup.locator('#story-content-fields')).toBeVisible({ timeout: 5_000 });

    const [download] = await Promise.all([
      popup.waitForEvent('download'),
      popup.locator('#btn-story-export').click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/My_Manga\.mtstory\.json$/);
    const downloadPath = await download.path();
    const fs = await import('node:fs');
    const exported = JSON.parse(fs.readFileSync(downloadPath!, 'utf8'));
    expect(exported.characters[0].name).toBe('Aoi');
    expect(exported.glossary[0].term).toBe('Kage-ryu');

    // Change the exported JSON, then import it back — the form should reflect it.
    exported.characters.push({ id: 'c2', name: 'Ren', gender: 'male' });
    const tmpFile = downloadPath!.replace(/\.json$/, '.edited.json');
    fs.writeFileSync(tmpFile, JSON.stringify(exported));

    const [fileChooser] = await Promise.all([
      popup.waitForEvent('filechooser'),
      popup.locator('#btn-story-import').click(),
    ]);
    await fileChooser.setFiles(tmpFile);
    await expect(popup.locator('.story-char-row')).toHaveCount(2, { timeout: 5_000 });
    await expect(popup.locator('.story-char-row').nth(1).locator('.sc-name')).toHaveValue('Ren');
  });
});

test.describe('manual region tool — bold/italic', () => {
  test('the B/I buttons wrap the translation textarea selection in markdown markers', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    await context.route('**/region/ocr', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'こんにちは', warning: null }) });
    });
    await context.route('**/region/render', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ image: FAKE_TRANSLATED_IMAGE_B64 }) });
    });

    const page = await context.newPage();
    await page.goto(SINGLE_URL);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await page.bringToFront();
    await popup.locator('#btn-region').click();
    await expect(page.locator('#mt-region-select')).toBeVisible({ timeout: 10_000 });

    const imgBox = (await page.locator('img').first().boundingBox())!;
    const x0 = imgBox.x + imgBox.width * 0.25;
    const y0 = imgBox.y + imgBox.height * 0.25;
    await page.mouse.move(x0, y0);
    await page.mouse.down();
    await page.mouse.move(x0 + imgBox.width * 0.3, y0 + imgBox.height * 0.2, { steps: 6 });
    await page.mouse.up();

    const editor = page.locator('#mt-region-editor');
    await expect(editor.locator('#orig')).toHaveValue('こんにちは', { timeout: 10_000 });
    const trans = editor.locator('#trans');
    await trans.fill('Hello there');
    // Select "Hello" (first 5 chars) and bold it.
    await trans.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 5));
    await editor.locator('#style-bold').click();
    await expect(trans).toHaveValue('**Hello** there');

    // Selecting the same bolded span again and clicking Bold un-bolds it.
    await trans.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(0, 9));
    await editor.locator('#style-bold').click();
    await expect(trans).toHaveValue('Hello there');
  });
});
