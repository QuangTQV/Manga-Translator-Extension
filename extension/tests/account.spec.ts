import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { clickScannerAction } from './shadow-dom';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site/index.html')}`;

// The Account tab is only relevant against a centrally-hosted backend
// (MT_REQUIRE_AUTH=true server-side, see backend/auth.py) — for the normal
// local backend it's simply never used, and accountToken stays unset.
test.describe('popup — Account tab', () => {
  test('registering creates an account, shows plan/usage, and persists across a popup reload', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    await context.route('**/account/register', async (route) => {
      const body = route.request().postDataJSON();
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ email: body.email, token: 'tok-abc123', plan: 'free', usage_count: 0, quota: 50, period_start: 0 }),
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Account' }).click();

    await expect(popup.locator('#account-logged-out')).toBeVisible();
    await expect(popup.locator('#account-logged-in')).toBeHidden();

    await popup.locator('#f-account-email').fill('new-user@example.com');
    await popup.locator('#btn-account-register').click();

    await expect(popup.locator('#account-logged-in')).toBeVisible({ timeout: 5_000 });
    await expect(popup.locator('#account-logged-out')).toBeHidden();
    await expect(popup.locator('#account-email-display')).toHaveText('new-user@example.com');
    await expect(popup.locator('#account-plan-display')).toHaveText('Free');
    await expect(popup.locator('#account-usage-display')).toContainText('0 / 50');

    await popup.waitForTimeout(300); // autoSave() beat

    const reloaded = await context.newPage();
    await reloaded.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await reloaded.getByRole('button', { name: 'Account' }).click();
    await expect(reloaded.locator('#account-logged-in')).toBeVisible();
    await expect(reloaded.locator('#account-email-display')).toHaveText('new-user@example.com');
  });

  test('logging in with an existing token verifies it against /account/me before saving', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    let receivedAuth: string | null = null;
    await context.route('**/account/me', async (route) => {
      receivedAuth = route.request().headers()['authorization'] ?? null;
      if (receivedAuth === 'Bearer good-token') {
        await route.fulfill({
          status: 200, contentType: 'application/json',
          body: JSON.stringify({ email: 'existing@example.com', plan: 'paid', usage_count: 5, quota: 100000, period_start: 0 }),
        });
      } else {
        await route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ detail: 'Invalid account token' }) });
      }
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Account' }).click();

    // A bad token is rejected and nothing is saved.
    await popup.locator('#f-account-token-import').fill('bad-token');
    await popup.locator('#btn-account-token-import').click();
    await expect(popup.locator('#account-logged-out')).toBeVisible({ timeout: 5_000 });

    // A good token logs in.
    await popup.locator('#f-account-token-import').fill('good-token');
    await popup.locator('#btn-account-token-import').click();
    await expect(popup.locator('#account-logged-in')).toBeVisible({ timeout: 5_000 });
    await expect(popup.locator('#account-email-display')).toHaveText('existing@example.com');
    await expect(popup.locator('#account-plan-display')).toHaveText('Paid');
  });

  test('logging out clears the account and translate requests stop sending an Authorization header', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed({ accountToken: 'tok-xyz', accountEmail: 'a@example.com' }), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Account' }).click();
    await expect(popup.locator('#account-logged-in')).toBeVisible();

    await popup.locator('#btn-account-logout').click();
    await expect(popup.locator('#account-logged-out')).toBeVisible();
    await popup.waitForTimeout(300);
    await popup.getByRole('button', { name: 'Translate', exact: true }).click();

    let capturedAuth: string | undefined;
    await context.route('**/translate', async (route) => {
      capturedAuth = route.request().headers()['authorization'];
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ translated_image: FAKE_TRANSLATED_IMAGE_B64, bubbles: [], processing_time_seconds: 0.1, source_language: 'ja', target_language: 'en', provider: 'Google', ocr_texts: [] }),
      });
    });

    const mangaPage = await context.newPage();
    await mangaPage.goto(TEST_SITE_URL);
    await mangaPage.bringToFront();
    await popup.locator('#btn-scan').click();
    await mangaPage.waitForTimeout(1500);
    const cdp = await context.newCDPSession(mangaPage);
    await cdp.send('DOM.enable');
    await clickScannerAction(mangaPage, cdp, 'select-all');
    await mangaPage.waitForTimeout(150);
    await clickScannerAction(mangaPage, cdp, 'translate');
    await mangaPage.waitForTimeout(2000);

    expect(capturedAuth).toBeUndefined();
  });

  test('a logged-in account attaches the Authorization header to /translate requests', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed({ accountToken: 'tok-xyz', accountEmail: 'a@example.com' }), firstKeyMatches('seed-key'));

    let capturedAuth: string | undefined;
    await context.route('**/translate', async (route) => {
      capturedAuth = route.request().headers()['authorization'];
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ translated_image: FAKE_TRANSLATED_IMAGE_B64, bubbles: [], processing_time_seconds: 0.1, source_language: 'ja', target_language: 'en', provider: 'Google', ocr_texts: [] }),
      });
    });

    const mangaPage = await context.newPage();
    await mangaPage.goto(TEST_SITE_URL);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    await mangaPage.bringToFront();
    await popup.locator('#btn-scan').click();
    const cdp = await context.newCDPSession(mangaPage);
    await cdp.send('DOM.enable');
    await clickScannerAction(mangaPage, cdp, 'select-all');
    await mangaPage.waitForTimeout(150);
    await clickScannerAction(mangaPage, cdp, 'translate');
    await mangaPage.waitForTimeout(2000);

    expect(capturedAuth).toBe('Bearer tok-xyz');
  });
});
