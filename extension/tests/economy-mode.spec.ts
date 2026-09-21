import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { clickScannerAction } from './shadow-dom';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site/index.html')}`;

// Economy mode overrides the costly options only at request time — the user's
// own values must survive untouched and come back when it is switched off.
for (const economyMode of [true, false]) {
  test(`translate request with economy mode ${economyMode ? 'on' : 'off'}`, async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({ config: { economyMode, sendFullPageContext: true, imageDetail: 'high', previousContextEnabled: true } }),
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
    await expect(popup.locator('#f-economy-mode')).toBeChecked({ checked: economyMode });

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
    if (economyMode) {
      expect(capturedBody.economy_mode).toBe(true);
      expect(capturedBody.send_full_page_context).toBe(false);
      expect(capturedBody.image_detail).toBe('low');
    } else {
      expect(capturedBody.economy_mode).toBeUndefined();
      expect(capturedBody.send_full_page_context).toBe(true);
      expect(capturedBody.image_detail).toBe('high');
    }

    // The user's own settings are never rewritten.
    const stored = await worker.evaluate(async () => (await chrome.storage.local.get(null)) as Record<string, any>);
    const cfg = Object.values(stored).map((v: any) => v?.config).find(Boolean);
    expect(cfg.sendFullPageContext).toBe(true);
    expect(cfg.imageDetail).toBe('high');
    expect(cfg.previousContextEnabled).toBe(true);
  });
}
