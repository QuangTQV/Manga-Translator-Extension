import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Locator } from '@playwright/test';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { clickScannerAction } from './shadow-dom';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site/index.html')}`;

// The visible control for a toggle like #f-outside-text is a CSS
// toggle-switch built on a zero-size <input> (opacity:0; width:0; height:0),
// which Playwright's pointer-based click() can't hit even with force — see
// tests/context-memory-sequential.spec.ts for the same issue. Set the DOM
// state directly and fire the same 'change' event the app's own click
// handling would produce.
async function checkToggle(locator: Locator): Promise<void> {
  await locator.evaluate((el: HTMLInputElement) => {
    el.checked = true;
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

// The Inpainting method / Flux remote-worker UI (Translate tab, under
// "Outside text") — see backend/flux_worker.py and
// core/image/inpainting.py:FluxKleinInpainter's remote_base_url support.
test.describe('popup — Flux remote inpainting', () => {
  test('the inpainting method field is hidden until Outside text is on, and the remote URL row only shows for the remote option', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    await expect(popup.locator('#inpainting-method-field')).toBeHidden();

    await checkToggle(popup.locator('#f-outside-text'));
    await expect(popup.locator('#inpainting-method-field')).toBeVisible();
    await expect(popup.locator('#flux-remote-url-row')).toBeHidden();

    await popup.locator('#f-inpainting-method').selectOption('flux_klein_4b_remote');
    await expect(popup.locator('#flux-remote-url-row')).toBeVisible();

    await popup.locator('#f-inpainting-method').selectOption('auto');
    await expect(popup.locator('#flux-remote-url-row')).toBeHidden();
  });

  test('settings persist across a popup reload', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({ config: { outsideTextEnabled: true, inpaintingMethod: 'flux_klein_4b_remote', fluxRemoteBaseUrl: 'https://abcd.trycloudflare.com' } }),
      firstKeyMatches('seed-key'),
    );

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    await expect(popup.locator('#f-outside-text')).toBeChecked();
    await expect(popup.locator('#f-inpainting-method')).toHaveValue('flux_klein_4b_remote');
    await expect(popup.locator('#flux-remote-url-row')).toBeVisible();
    await expect(popup.locator('#f-flux-remote-url')).toHaveValue('https://abcd.trycloudflare.com');
  });

  test('Test Connection reports success and failure against the worker\'s /health endpoint', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    await context.route('**/good-worker.example.com/health', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ status: 'ok', loaded_variants: ['4b'], device: 'cuda' }) });
    });
    await context.route('**/dead-worker.example.com/health', async (route) => {
      await route.abort('connectionrefused');
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await checkToggle(popup.locator('#f-outside-text'));
    await popup.locator('#f-inpainting-method').selectOption('flux_klein_4b_remote');

    await popup.locator('#f-flux-remote-url').fill('https://good-worker.example.com');
    await popup.locator('#btn-test-flux-remote').click();
    await expect(popup.locator('#flux-remote-test-status')).toHaveText('✓', { timeout: 5_000 });

    await popup.locator('#f-flux-remote-url').fill('https://dead-worker.example.com');
    await popup.locator('#btn-test-flux-remote').click();
    await expect(popup.locator('#flux-remote-test-status')).toHaveText('✗', { timeout: 5_000 });
  });

  test('a translate request maps the remote option to inpainting_method + flux_remote_base_url correctly', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({ config: { outsideTextEnabled: true, inpaintingMethod: 'flux_klein_4b_remote', fluxRemoteBaseUrl: 'https://abcd.trycloudflare.com' } }),
      firstKeyMatches('seed-key'),
    );

    let capturedBody: any = null;
    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      capturedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          translated_image: FAKE_TRANSLATED_IMAGE_B64,
          bubbles: [],
          processing_time_seconds: 0.1,
          source_language: 'Japanese',
          target_language: 'English',
          provider: 'Google',
          ocr_texts: [],
          memory_note: null,
        }),
      });
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
    await mangaPage.waitForTimeout(2000);

    expect(capturedBody).toBeTruthy();
    expect(capturedBody.outside_text_enabled).toBe(true);
    expect(capturedBody.inpainting_method).toBe('flux_klein_4b');
    expect(capturedBody.flux_remote_base_url).toBe('https://abcd.trycloudflare.com');
  });

  test('the 9B remote option maps to flux_klein_9b and shows the URL row', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({ config: { outsideTextEnabled: true, inpaintingMethod: 'flux_klein_9b_remote', fluxRemoteBaseUrl: 'https://nine.trycloudflare.com' } }),
      firstKeyMatches('seed-key'),
    );

    let capturedBody: any = null;
    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      capturedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
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
    await expect(popup.locator('#flux-remote-url-row')).toBeVisible();

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
    expect(capturedBody.inpainting_method).toBe('flux_klein_9b');
    expect(capturedBody.flux_remote_base_url).toBe('https://nine.trycloudflare.com');
  });

  test('a translate request with inpainting_method "auto" never sends flux_remote_base_url', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({ config: { outsideTextEnabled: true, inpaintingMethod: 'auto', fluxRemoteBaseUrl: 'https://leftover-from-before.example.com' } }),
      firstKeyMatches('seed-key'),
    );

    let capturedBody: any = null;
    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      capturedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          translated_image: FAKE_TRANSLATED_IMAGE_B64,
          bubbles: [],
          processing_time_seconds: 0.1,
          source_language: 'Japanese',
          target_language: 'English',
          provider: 'Google',
          ocr_texts: [],
          memory_note: null,
        }),
      });
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
    await mangaPage.waitForTimeout(2000);

    expect(capturedBody).toBeTruthy();
    expect(capturedBody.inpainting_method).toBe('auto');
    expect(capturedBody.flux_remote_base_url).toBeUndefined();
  });

  test('the token is sent as flux_remote_token, and a backend warning shows a toast', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(
      worker,
      baseSeed({ config: { outsideTextEnabled: true, inpaintingMethod: 'flux_klein_4b_remote', fluxRemoteBaseUrl: 'https://abcd.trycloudflare.com', fluxRemoteToken: 'sekret' } }),
      firstKeyMatches('seed-key'),
    );

    let capturedBody: any = null;
    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      capturedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          translated_image: FAKE_TRANSLATED_IMAGE_B64, bubbles: [], processing_time_seconds: 0.1,
          source_language: 'Japanese', target_language: 'English', provider: 'Google', ocr_texts: [], memory_note: null,
          warnings: ['flux_remote_unreachable'],
        }),
      });
    });

    const mangaPage = await context.newPage();
    // Later toasts replace earlier ones, so record every toast's text.
    await mangaPage.addInitScript(() => {
      (window as any).__toasts = [];
      new MutationObserver((muts) => {
        for (const m of muts) m.addedNodes.forEach((n) => {
          if ((n as HTMLElement).id === 'mt-toast') (window as any).__toasts.push((n as HTMLElement).textContent);
        });
      }).observe(document, { childList: true, subtree: true });
    });
    await mangaPage.goto(TEST_SITE_URL);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await expect(popup.locator('#f-flux-remote-token')).toHaveValue('sekret');

    await mangaPage.bringToFront();
    await popup.locator('#btn-scan').click();
    await mangaPage.waitForTimeout(1500);
    const cdp = await context.newCDPSession(mangaPage);
    await cdp.send('DOM.enable');
    await clickScannerAction(mangaPage, cdp, 'select-all');
    await mangaPage.waitForTimeout(150);
    await clickScannerAction(mangaPage, cdp, 'translate');
    await mangaPage.waitForTimeout(2000);

    expect(capturedBody.flux_remote_token).toBe('sekret');
    const toasts: string[] = await mangaPage.evaluate(() => (window as any).__toasts);
    expect(toasts.some((t) => /Flux remote worker is unreachable/.test(t))).toBe(true);
  });
});
