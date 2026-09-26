import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { clickScannerAction } from './shadow-dom';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SINGLE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;

// The "Text reading" select drives the backend's (translation_mode,
// ocr_method) pair from one control: AI reads the image (one-step + LLM) vs a
// local OCR followed by an AI text translation (two-step + manga-ocr /
// paddleocr-vl).
test.describe('popup — Text reading', () => {
  test('defaults to AI reading, persists a local OCR choice across reload, and sends the matching pair', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(popup.locator('#f-text-reading')).toHaveValue('llm');

    await popup.locator('#f-text-reading').selectOption('manga-ocr');
    await popup.waitForTimeout(300);

    const reloaded = await context.newPage();
    await reloaded.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(reloaded.locator('#f-text-reading')).toHaveValue('manga-ocr');

    const bodies: any[] = [];
    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      bodies.push(route.request().postDataJSON());
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
    await reloaded.locator('#btn-scan').click();
    await mangaPage.waitForTimeout(1500);
    const cdp = await context.newCDPSession(mangaPage);
    await cdp.send('DOM.enable');
    await clickScannerAction(mangaPage, cdp, 'select-all');
    await mangaPage.waitForTimeout(150);
    await clickScannerAction(mangaPage, cdp, 'translate');
    await mangaPage.waitForTimeout(2000);

    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies[0].translation_mode).toBe('two-step');
    expect(bodies[0].ocr_method).toBe('manga-ocr');

    // Back to AI reading: the pair returns to the one-step defaults. (The
    // popup page closes itself once a scan starts, so use a fresh one.)
    const again = await context.newPage();
    await again.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(again.locator('#f-text-reading')).toHaveValue('manga-ocr');
    await again.locator('#f-text-reading').selectOption('llm');
    await again.waitForTimeout(300);
    const stored = await worker.evaluate(async () => (await chrome.storage.local.get(null)) as any);
    const cfg = Object.values(stored).map((v: any) => v?.config).find(Boolean);
    expect(cfg.translationMode).toBe('one-step');
    expect(cfg.ocrMethod).toBe('LLM');
  });

  test('a paddleocr-vl setting round-trips into the select', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed({ config: { translationMode: 'two-step', ocrMethod: 'paddleocr-vl' } }), firstKeyMatches('seed-key'));
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(popup.locator('#f-text-reading')).toHaveValue('paddleocr-vl');
  });
});
