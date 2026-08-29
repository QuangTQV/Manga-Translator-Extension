import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site/index.html')}`;

// A page whose every translate attempt fails with a "rate limited"-style
// error used to never surface anything — markAutoTranslateFailure exempted
// these from counting toward the retry badge at all, on the assumption the
// backend's own rotation/cooldown would always resolve it. If every
// configured key/provider is exhausted at once, that assumption doesn't
// hold and the page just sits blank forever with zero visible sign anything
// is wrong. Now every failure counts the same way, so the retry badge
// (click it to force one more attempt) always eventually appears.
test('a page whose translate requests keep failing with a rate-limit-style error still gets the retry badge', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  await context.route('**/translate', async (route) => {
    await route.fulfill({
      status: 502,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'All API keys are currently rate limited, please try again shortly' }),
    });
  });

  const mangaPage = await context.newPage();
  await mangaPage.goto(TEST_SITE_URL);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();

  // 3 failed attempts (AUTO_RETRY_MAX) trigger the badge; the periodic scan
  // that drives retries runs every 4s, so give it enough real time.
  await expect(mangaPage.locator('.mt-retry-badge').first()).toBeVisible({ timeout: 20_000 });
  await expect(mangaPage.locator('.mt-badge')).toHaveCount(0);
});
