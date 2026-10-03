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
    const banner = mangaPage.locator('#mt-model-download-banner');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('PaddleOCR-VL');
    await expect(banner).toContainText('1.9 GB');
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
    await expect(mangaPage.locator('#mt-model-download-banner')).toHaveCount(0);
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
    await expect(mangaPage.locator('#mt-model-download-banner')).toHaveCount(0); // ...and had nothing to say
  });

  // A gated/misconfigured model repo can fail every single download attempt
  // (see the backend's own failure-cooldown fix for the retry side of
  // this), which used to mean this notice reappeared on every single page —
  // "Don't remind me about this" lets the reader quiet it even before
  // that's sorted out on their end.
  test('"Don\'t remind me about this" stops the notice for that model, but not for a different one', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    let healthDownloads: { name: string; approx_mb: number | null; elapsed_seconds: number }[] = [
      { name: 'deepghs/AnimeText_yolo', approx_mb: null, elapsed_seconds: 3 },
    ];
    await context.route('**/health', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', downloads: healthDownloads }) });
    });
    // Long enough for the dismiss, a second /health poll cycle (every
    // 2.5s), and the assertions below to all land before it resolves.
    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await new Promise((r) => setTimeout(r, 18_000));
      await route.fulfill({ status: 200, contentType: 'application/json', body: TRANSLATE_OK });
    });

    // Auto-translate, not the scanner — the scanner's full-page modal
    // backdrop would intercept clicks meant for this banner, which sits in
    // the regular page (outside the scanner's shadow root).
    const mangaPage = await context.newPage();
    await mangaPage.goto(SINGLE_URL);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await mangaPage.bringToFront();
    await popup.locator('#btn-auto').click();
    const banner = mangaPage.locator('#mt-model-download-banner');
    await expect(banner).toBeVisible({ timeout: 15_000 });
    await expect(banner).toContainText('deepghs/AnimeText_yolo');

    await banner.getByRole('button', { name: "Don't remind me about this" }).click();
    await expect(banner).toHaveCount(0, { timeout: 1_000 });

    const dismissed = await worker.evaluate(async () => {
      const result = await chrome.storage.local.get('mtModelDownloadNoticeDismissed');
      return result.mtModelDownloadNoticeDismissed;
    });
    expect(dismissed).toEqual(['deepghs/AnimeText_yolo']);

    // The same in-flight request's health-poll now reports a SECOND model
    // alongside the dismissed one — the dismissed one must stay quiet while
    // the new one still gets its own notice.
    healthDownloads = [
      { name: 'deepghs/AnimeText_yolo', approx_mb: null, elapsed_seconds: 20 },
      { name: 'kha-white/manga-ocr-base', approx_mb: 890, elapsed_seconds: 1 },
    ];
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('manga-ocr-base');
    await expect(banner).not.toContainText('AnimeText_yolo');
  });
});
