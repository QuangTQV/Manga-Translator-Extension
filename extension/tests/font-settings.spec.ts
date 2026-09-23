import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { clickScannerAction } from './shadow-dom';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site/index.html')}`;

// Font pack + min/max font size (LLM Config -> Translate tab "Font" section)
// — backend/endpoints/translate.py:list_fonts backs the dropdown so a
// translator who drops a font pack into backend/fonts/ sees it without
// editing any config file.
test.describe('popup — font settings', () => {
  test('the font list comes from the backend, and a saved font not in that list is kept as an extra option', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed({ config: { fontDir: 'MyOwnFont', minFontSize: 10, maxFontSize: 22 } }), firstKeyMatches('seed-key'));

    await context.route('**/fonts', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ fonts: ['Roboto', 'Noto Sans SC'] }) });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    const select = popup.locator('#f-font-pack');
    await expect(select.locator('option')).toHaveCount(4, { timeout: 5_000 }); // Auto + Roboto + Noto Sans SC + the saved unknown one
    await expect(select).toHaveValue('MyOwnFont');
    await expect(popup.locator('#f-min-font-size')).toHaveValue('10');
    await expect(popup.locator('#f-max-font-size')).toHaveValue('22');
  });

  test('picking a font and sizes persists across reload and is sent with a translate request', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    await context.route('**/fonts', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ fonts: ['Roboto', 'Comicka'] }) });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(popup.locator('#f-font-pack option')).toHaveCount(3, { timeout: 5_000 });

    await popup.locator('#f-font-pack').selectOption('Comicka');
    await popup.locator('#f-min-font-size').fill('12');
    await popup.locator('#f-max-font-size').fill('30');
    await popup.locator('#f-min-font-size').dispatchEvent('change');
    await popup.waitForTimeout(300); // autosave debounce

    const reloaded = await context.newPage();
    await reloaded.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(reloaded.locator('#f-font-pack')).toHaveValue('Comicka', { timeout: 5_000 });
    await expect(reloaded.locator('#f-min-font-size')).toHaveValue('12');
    await expect(reloaded.locator('#f-max-font-size')).toHaveValue('30');

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
    await reloaded.locator('#btn-scan').click();
    await mangaPage.waitForTimeout(1500);
    const cdp = await context.newCDPSession(mangaPage);
    await cdp.send('DOM.enable');
    await clickScannerAction(mangaPage, cdp, 'select-all');
    await mangaPage.waitForTimeout(150);
    await clickScannerAction(mangaPage, cdp, 'translate');
    await mangaPage.waitForTimeout(2000);

    expect(capturedBody).toBeTruthy();
    expect(capturedBody.font_dir).toBe('Comicka');
    expect(capturedBody.min_font_size).toBe(12);
    expect(capturedBody.max_font_size).toBe(30);
  });
});
