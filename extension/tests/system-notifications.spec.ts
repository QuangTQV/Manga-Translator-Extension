import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { clickScannerAction } from './shadow-dom';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site/index.html')}`;
const SINGLE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;

const TRANSLATE_OK = JSON.stringify({
  translated_image: FAKE_TRANSLATED_IMAGE_B64, bubbles: [], processing_time_seconds: 0.1,
  source_language: 'Japanese', target_language: 'English', provider: 'Google', ocr_texts: [], memory_note: null,
});

// chrome.notifications.create only exists in extension pages (background,
// popup) — content scripts have to relay through SHOW_NOTIFICATION. This
// stubs the service worker's copy so a test can assert a system
// notification actually fired, without a real OS notification appearing.
async function captureNotifications(worker: any): Promise<void> {
  await worker.evaluate(() => {
    (self as any).__notifications = [];
    const orig = chrome.notifications.create.bind(chrome.notifications);
    (chrome.notifications as any).create = (...args: unknown[]) => {
      (self as any).__notifications.push(args);
      return (orig as any)(...args);
    };
  });
}

async function getNotifications(worker: any): Promise<any[]> {
  return worker.evaluate(() => (self as any).__notifications ?? []);
}

test.describe('system (OS-level) notifications', () => {
  // The scanner's batch translate is the longest-running action in the
  // extension and closes its own panel right after finishing — exactly the
  // moment a reader is likely to have switched to another tab while it ran.
  test('finishing a batch translate in the scanner fires a system notification', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));
    await captureNotifications(worker);

    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({ status: 200, contentType: 'application/json', body: TRANSLATE_OK });
    });

    const mangaPage = await context.newPage();
    await mangaPage.goto(TEST_SITE_URL);
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

    await expect.poll(async () => (await getNotifications(worker)).length, { timeout: 15_000 }).toBeGreaterThan(0);
    const [, options] = (await getNotifications(worker))[0];
    expect(options.message).toMatch(/4/); // the 4 synthetic test-site pages
  });

  // Config tab's "System notifications" toggle — background's
  // showSystemNotification() is the single choke point every notification
  // path routes through, so disabling it there is enough to cover all of
  // them; this exercises one (the batch-translate-done path above) as the
  // representative case.
  test('the Config tab\'s "System notifications" toggle suppresses them, but the in-page toast still shows', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed({ notificationsEnabled: false }), firstKeyMatches('seed-key'));
    await captureNotifications(worker);

    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      await route.fulfill({ status: 200, contentType: 'application/json', body: TRANSLATE_OK });
    });

    const mangaPage = await context.newPage();
    await mangaPage.goto(TEST_SITE_URL);
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

    await expect(mangaPage.locator('#mt-toast')).toContainText('4', { timeout: 15_000 });
    expect((await getNotifications(worker)).length).toBe(0);
  });

  // A provider outage or an exhausted shared quota hits every in-flight
  // image at once — this is the extension's signal that something is wrong
  // badly enough to need the reader's attention even if they've tabbed away.
  test('every configured key/provider failing fires exactly one system notification, not one per image', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));
    await captureNotifications(worker);

    await context.route('**/translate', async (route) => {
      await route.fulfill({
        status: 502, contentType: 'application/json',
        body: JSON.stringify({ detail: 'All API keys are currently rate limited, please try again shortly' }),
      });
    });

    const mangaPage = await context.newPage();
    await mangaPage.goto(TEST_SITE_URL);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await mangaPage.bringToFront();
    await popup.locator('#btn-auto').click();

    await expect(mangaPage.locator('.mt-retry-badge').first()).toBeVisible({ timeout: 20_000 });
    // The other 3 test-site pages hit the same retry cap around the same
    // time — this fires at most once per auto-translate session, which must
    // collapse all of that into one notice.
    await mangaPage.waitForTimeout(1000);
    expect((await getNotifications(worker)).length).toBe(1);
  });

  // The previous version of this throttle was purely time-based (60s) — a
  // persistent misconfiguration would then re-fire this OS-level
  // notification every minute for as long as the reader kept reading. It
  // now fires at most once per auto-translate *session* (reset in
  // startAutoTranslate) — each content-script instance is its own session,
  // so turning to a new page while the same misconfiguration persists still
  // gets its own notification, rather than staying silent forever after the
  // very first one.
  test('a second page with the same persistent failure still gets its own notification', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));
    await captureNotifications(worker);

    await context.route('**/translate', async (route) => {
      await route.fulfill({
        status: 502, contentType: 'application/json',
        body: JSON.stringify({ detail: 'All API keys are currently rate limited, please try again shortly' }),
      });
    });

    // A fresh popup page per toggle — matching real usage (the popup is
    // recreated each time it's opened) and avoiding its own `#btn-auto`
    // active/inactive class being reused across tabs, which would make a
    // second click send STOP instead of START.
    const mangaPage1 = await context.newPage();
    await mangaPage1.goto(TEST_SITE_URL);
    await mangaPage1.bringToFront();
    const popup1 = await context.newPage();
    await popup1.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await mangaPage1.bringToFront();
    await popup1.locator('#btn-auto').click();
    await expect(mangaPage1.locator('.mt-retry-badge').first()).toBeVisible({ timeout: 20_000 });
    expect((await getNotifications(worker)).length).toBe(1);

    const mangaPage2 = await context.newPage();
    await mangaPage2.goto(TEST_SITE_URL);
    await mangaPage2.bringToFront();
    const popup2 = await context.newPage();
    await popup2.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await mangaPage2.bringToFront();
    await popup2.locator('#btn-auto').click();
    await expect(mangaPage2.locator('.mt-retry-badge').first()).toBeVisible({ timeout: 20_000 });
    expect((await getNotifications(worker)).length).toBe(2);
  });

  // The backend fetches ML weights lazily (up to ~2GB); while a request
  // waits on that, the service worker polls /health and already shows an
  // in-page toast (model-download-notice.spec.ts). This checks the OS-level
  // follow-up once /health reports the download has finished.
  test('a model download finishing while a translate is still running fires a system notification', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));
    await captureNotifications(worker);

    let translateStartedAt = 0;
    await context.route('**/health', async (route) => {
      const downloading = translateStartedAt > 0 && Date.now() - translateStartedAt < 5_000;
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ status: 'ok', downloads: downloading ? [{ name: 'PaddleOCR-VL', approx_mb: 1930, elapsed_seconds: 3 }] : [] }),
      });
    });
    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      translateStartedAt = Date.now();
      await new Promise((r) => setTimeout(r, 12_000));
      await route.fulfill({ status: 200, contentType: 'application/json', body: TRANSLATE_OK });
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

    // Fires mid-flight (download "finishes" at the 5s mark, well before the
    // 12s translate response) — not just after the whole request settles.
    await expect.poll(async () => (await getNotifications(worker)).length, { timeout: 11_000 }).toBeGreaterThan(0);
    const [, options] = (await getNotifications(worker))[0];
    expect(options.message).toContain('PaddleOCR-VL');
  });
});
