import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site/index.html')}`;

// A 1x1 transparent PNG, base64, no data: prefix — a minimal but valid
// translated_image payload.
const FAKE_TRANSLATED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// With several pages queued during auto-translate, the only page-level
// signal a reader had that anything was happening was the small floating
// "Auto MT N" counter — nothing on the pages themselves distinguished
// "currently being translated" from "still waiting in the queue". A small
// pulsing badge at the same corner as the eventual "MT" badge now marks
// whichever page(s) are actually in flight.
test('a page shows an in-progress badge while its translate request is pending, then swaps to the MT badge', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  // Auto-translate processes several pages concurrently, so several
  // /translate requests can be in flight (and route-intercepted) at once —
  // collect every resolver instead of a single variable, and release them
  // all together.
  const pendingResolvers: Array<() => void> = [];
  let started = 0;
  const translateStarted = new Promise<void>((resolveStarted) => {
    context.route('**/translate', async (route) => {
      started++;
      resolveStarted();
      await new Promise<void>((r) => { pendingResolvers.push(r); });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          translated_image: FAKE_TRANSLATED_PNG_B64,
          bubbles: [],
          processing_time_seconds: 0.1,
          source_language: 'Japanese',
          target_language: 'English',
          provider: 'Google',
          ocr_texts: [],
        }),
      });
    });
  });

  const mangaPage = await context.newPage();
  await mangaPage.goto(TEST_SITE_URL);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();

  await translateStarted;
  await expect(mangaPage.locator('.mt-progress-badge').first()).toBeVisible();
  await expect(mangaPage.locator('.mt-badge')).toHaveCount(0);

  // Drain whatever's pending, wait for the queue to pick up the rest and
  // issue their own requests, repeat — until every page has been translated.
  for (let i = 0; i < 20 && (await mangaPage.locator('.mt-badge').count()) < 4; i++) {
    while (pendingResolvers.length > 0) pendingResolvers.shift()?.();
    await mangaPage.waitForTimeout(150);
  }

  expect(started).toBeGreaterThan(1); // actually exercised concurrent in-flight requests
  await expect(mangaPage.locator('.mt-badge')).toHaveCount(4);
  await expect(mangaPage.locator('.mt-progress-badge')).toHaveCount(0);
});

// A real production report: the badge appeared to "flicker" — floating
// smoothly for a moment, then blinking off and restarting from scratch,
// repeatedly. Root cause: every failed attempt (even one about to be
// silently retried by the next periodic scan a few seconds later) removed
// the badge element in translateAndApply()'s `finally`, so the next
// attempt's addInProgressBadge() found nothing and created a brand new
// element — restarting its animation and reading as the indicator turning
// off and on. It must now stay up (the same DOM element, animation
// uninterrupted) across the gap between an intermediate failure and its
// automatic retry, only actually disappearing once the page either
// succeeds or exhausts AUTO_RETRY_MAX and hands off to the retry badge.
test('the in-progress badge is not torn down and recreated between automatic retries', async ({ context, extensionId }) => {
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

  const singleSiteUrl = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;
  const mangaPage = await context.newPage();
  await mangaPage.goto(singleSiteUrl);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();

  const badge = mangaPage.locator('.mt-progress-badge').first();
  await expect(badge).toBeVisible({ timeout: 15_000 });
  await badge.evaluate((el) => el.setAttribute('data-test-mark', 'original'));

  // Poll across the retry window (AUTO_RETRY_MAX=3 attempts, periodic scan
  // every 4s) until the terminal retry badge appears — at every poll before
  // that, the marked element must still be the one present. If it were ever
  // torn down and recreated between attempts, the mark would be gone and
  // this assertion fails immediately instead of waiting for a timeout.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (await mangaPage.locator('.mt-retry-badge').count()) break;
    await expect(mangaPage.locator('.mt-progress-badge[data-test-mark="original"]')).toHaveCount(1);
    await mangaPage.waitForTimeout(300);
  }

  await expect(mangaPage.locator('.mt-retry-badge').first()).toBeVisible({ timeout: 10_000 });
  await expect(mangaPage.locator('.mt-progress-badge')).toHaveCount(0);
});
