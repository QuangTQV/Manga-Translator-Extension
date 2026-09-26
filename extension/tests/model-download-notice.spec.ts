import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { clickScannerAction } from './shadow-dom';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SINGLE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;

const TRANSLATE_OK = JSON.stringify({
  translated_image: FAKE_TRANSLATED_IMAGE_B64, bubbles: [], processing_time_seconds: 0.1,
  source_language: 'Japanese', target_language: 'English', provider: 'Google', ocr_texts: [], memory_note: null,
});

async function startTranslate(context: any, extensionId: string, mangaUrl: string) {
  const mangaPage = await context.newPage();
  await mangaPage.goto(mangaUrl);
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
  return mangaPage;
}

// The backend fetches ML weights lazily on first use (LaMa, manga-ocr,
// PaddleOCR-VL). While a request is slow the service worker polls /health and
// the page gets a toast saying so, instead of a translation that just hangs.
test.describe('first-use model download notice', () => {
  test('a slow translate shows what is being downloaded, from the backend /health', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    let healthCalls = 0;
    await context.route('**/health', async (route) => {
      healthCalls += 1;
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', downloads: [{ name: 'PaddleOCR-VL', approx_mb: 1930, elapsed_seconds: 3 }] }),
      });
    });
    // Slower than the watcher's start-up delay, so it has time to poll.
    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await new Promise((r) => setTimeout(r, 9_000));
      await route.fulfill({ status: 200, contentType: 'application/json', body: TRANSLATE_OK });
    });

    const mangaPage = await startTranslate(context, extensionId, SINGLE_URL);
    const toast = mangaPage.locator('#mt-toast');
    await expect(toast).toBeVisible({ timeout: 15_000 });
    await expect(toast).toContainText('PaddleOCR-VL');
    await expect(toast).toContainText('1.9 GB');
    expect(healthCalls).toBeGreaterThan(0);
  });

  test('a quick translate never polls /health and shows no toast', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    // The popup itself hits /health for its "Backend OK" pill, so only count
    // calls made after the translate request started.
    let translateStarted = false;
    let healthCallsDuringTranslate = 0;
    await context.route('**/health', async (route) => {
      if (translateStarted) healthCallsDuringTranslate += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', downloads: [] }) });
    });
    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      translateStarted = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: TRANSLATE_OK });
    });

    const mangaPage = await startTranslate(context, extensionId, SINGLE_URL);
    await mangaPage.waitForTimeout(6_000);
    expect(translateStarted).toBe(true);
    expect(healthCallsDuringTranslate).toBe(0);
    await expect(mangaPage.locator('#mt-toast')).toHaveCount(0);
  });

  test('nothing is shown while a slow request runs but the backend is not downloading anything', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    let translateStarted = false;
    let healthCalls = 0;
    await context.route('**/health', async (route) => {
      if (translateStarted) healthCalls += 1;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', downloads: [] }) });
    });
    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      translateStarted = true;
      await new Promise((r) => setTimeout(r, 8_000));
      await route.fulfill({ status: 200, contentType: 'application/json', body: TRANSLATE_OK });
    });

    const mangaPage = await startTranslate(context, extensionId, SINGLE_URL);
    await mangaPage.waitForTimeout(7_500);
    expect(healthCalls).toBeGreaterThan(0); // it did ask...
    await expect(mangaPage.locator('#mt-toast')).toHaveCount(0); // ...and had nothing to say
  });
});
