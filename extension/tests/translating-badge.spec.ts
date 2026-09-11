import fs from 'node:fs';
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

// A production report: on some readers (virtualized/long-strip layouts
// especially), the same <img> DOM node gets reused for a different page as
// the reader scrolls — the site repoints its src in place instead of
// creating a new element (the MutationObserver only watches for
// added/removed nodes, not attribute changes, so this needed the periodic
// rescan to notice at all). Without detecting the src no longer matches
// what was translated, the old page's translated overlay/"MT" badge kept
// sitting on top of the new page's pixels indefinitely, and the new page
// was never actually queued for translation.
test('an <img> recycled for a different page (src changed in place, same element) gets re-translated instead of keeping the stale overlay', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  let translateCount = 0;
  await context.route('**/translate', async (route) => {
    translateCount++;
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

  const singleSiteUrl = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;
  const mangaPage = await context.newPage();
  await mangaPage.goto(singleSiteUrl);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();

  await expect(mangaPage.locator('.mt-badge').first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => translateCount).toBe(1);
  await mangaPage.locator('.mt-page-overlay').first().evaluate((el) => el.setAttribute('data-test-mark', 'original'));

  // Simulate the recycle: same element, new src, no DOM replacement.
  await mangaPage.locator('img:not(.mt-page-overlay)').first().evaluate((img) => {
    (img as HTMLImageElement).src = '../test-site/page2.jpg';
  });

  // Nudge the scroll/resize-driven rescan rather than waiting out the full
  // periodic timer.
  await mangaPage.evaluate(() => window.dispatchEvent(new Event('resize')));

  await expect.poll(() => translateCount, { timeout: 15_000 }).toBe(2);
  await expect(mangaPage.locator('.mt-badge')).toHaveCount(1); // the stale one was cleaned up, not duplicated
  // The overlay element itself is hidden-then-reused, not torn down and
  // recreated — matters most for sites that recycle the <img> on every
  // single page turn (e.g. MangaDex's blob: URLs), where remove+recreate
  // would mean a fresh full-image decode on every page turn.
  await expect(mangaPage.locator('.mt-page-overlay[data-test-mark="original"]')).toHaveCount(1);
});

// A production report: the in-progress badge appeared to "flicker" — the
// MT badge repeatedly turning back into the in-progress dots and back
// again with no user action. Root cause: the recycled-image check above
// (comparing the element's live src against what was translated) used an
// exact URL match, so a lazy-load library appending a fresh cache-busting
// query param (?t=<timestamp>) to the same attribute on every re-render —
// no actual content change — was misread as a recycle every single time,
// tearing the overlay/badges down and rebuilding them from scratch. It
// must compare path only, ignoring the query string, so this keeps
// reading as "same image, just resync position" instead.
//
// Asserting on the overlay ELEMENT's identity (not translateCount): a
// separate, unrelated cache (the content-hash cache — see
// translateAndApply's contentCacheKey) happens to hide the wasted-request
// side effect here anyway, since re-querying byte-identical image data
// hits that cache regardless of whether this bug is present. What the bug
// actually causes — visible on screen regardless of that cache — is the
// overlay/badge DOM elements themselves being torn down and recreated on
// every false-positive "recycle".
test('an <img> whose lazy-load attribute gets a fresh cache-busting query param on every re-render is NOT treated as recycled', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  await context.route('**/translate', async (route) => {
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

  const singleSiteUrl = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;
  const mangaPage = await context.newPage();
  await mangaPage.goto(singleSiteUrl);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();

  await expect(mangaPage.locator('.mt-badge').first()).toBeVisible({ timeout: 15_000 });
  await mangaPage.locator('.mt-page-overlay').first().evaluate((el) => el.setAttribute('data-test-mark', 'original'));

  // Same file, cache-busting query param only — same element, no recycle.
  for (let i = 0; i < 3; i++) {
    await mangaPage.locator('img:not(.mt-page-overlay)').first().evaluate((img, n) => {
      (img as HTMLImageElement).src = `../test-site/page1.jpg?t=${n}`;
    }, Date.now() + i);
    await mangaPage.evaluate(() => window.dispatchEvent(new Event('resize')));
    await mangaPage.waitForTimeout(500);
  }

  // If the overlay were ever torn down and recreated, the mark would be
  // gone (a fresh element never carries it) — this fails immediately
  // instead of waiting out a timeout if the bug is present.
  await expect(mangaPage.locator('.mt-page-overlay[data-test-mark="original"]')).toHaveCount(1);
  await expect(mangaPage.locator('.mt-progress-badge')).toHaveCount(0); // never flashed into "translating"
});

// A production report: switching back and forth between pages on a reader
// that mints a fresh blob: URL per page turn (MangaDex is the documented
// motivating case for the existing content-hash cache) felt laggy — every
// such turn re-triggers the recycled-image reset above (a genuinely
// different blob: URL each time), and tryThumbnailFastPath() exists so a
// revisit whose thumbnail is already known can skip straight to applying
// it instead of paying for a full-resolution capture + PNG encode first.
//
// This test can't exercise that cache-HIT path end to end: canvas capture
// of a file:// (opaque-origin) test fixture image taints the canvas here,
// so both captureImgThumbnail() and the full captureImgElement() it
// mirrors fail every time in this harness — captureImgElement() already
// has network-fetch fallbacks for exactly that reason (see
// fetchImageData), but the thumbnail check deliberately doesn't duplicate
// that fallback chain (the whole point is being cheap; it just no-ops on
// failure). What it verifies instead is a real bug this file's earlier
// version had on the MISS path: continueHandlingUntranslatedImage() only
// enqueues the item, and nothing else re-triggers
// processAutoTranslateQueue() after this async detour resolves — the
// SCAN tick's own call already ran and returned before then, so without
// an explicit call here the item just sat enqueued until the next
// periodic scan (AUTO_PERIODIC_SCAN_INTERVAL_MS, 4s) happened to drain
// it, adding up to 4 extra seconds of visible delay on top of whatever
// this fast-path optimization was trying to avoid in the first place —
// checked with a deadline comfortably under that 4s so the periodic
// timer can't mask a regression here by eventually bailing it out.
test('revisiting a page whose <img> gets a freshly-minted blob: URL (e.g. MangaDex page turns) re-translates promptly when the thumbnail fast path misses, not stuck until the next periodic scan', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  let translateCount = 0;
  await context.route('**/translate', async (route) => {
    translateCount++;
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

  const singleSiteUrl = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;
  const mangaPage = await context.newPage();
  await mangaPage.goto(singleSiteUrl);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();

  await expect(mangaPage.locator('.mt-badge').first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => translateCount).toBe(1);

  // Real browser Object URL (not just a different query string) wrapping
  // the SAME underlying pixel data — the same shape as a reader minting a
  // fresh blob: URL for a page the reader already visited. Read the file's
  // bytes from Node (page.evaluate's context is an ordinary page script,
  // not the extension's isolated-world content script, so fetch()/canvas
  // capture against a file:// image are blocked here even though the
  // extension's own equivalent code works fine from its isolated world)
  // and hand them into the page to construct the Blob directly, avoiding
  // any network/canvas call in-page entirely.
  const pageBytesBase64 = fs.readFileSync(path.resolve(__dirname, 'fixtures/test-site/page1.jpg')).toString('base64');
  const blobUrl = await mangaPage.evaluate(async (base64) => {
    const img = document.querySelector('img:not(.mt-page-overlay)') as HTMLImageElement;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    const blob = new Blob([bytes], { type: 'image/jpeg' });
    const url = URL.createObjectURL(blob);
    // Wait for the decode to actually finish before the scan can see it —
    // otherwise the capture step this test cares about would race against
    // an in-progress decode, an unrelated source of nondeterminism.
    await new Promise<void>((resolve) => { img.onload = () => resolve(); img.src = url; });
    return url;
  }, pageBytesBase64);
  expect(blobUrl).toMatch(/^blob:/);

  await mangaPage.evaluate(() => window.dispatchEvent(new Event('resize')));

  // Under 4s (AUTO_PERIODIC_SCAN_INTERVAL_MS) — without the
  // processAutoTranslateQueue() call added alongside tryThumbnailFastPath,
  // this still eventually happens (the periodic timer bails it out), just
  // up to 4s late, which this deadline is short enough to catch.
  await expect.poll(() => translateCount, { timeout: 2_500 }).toBe(2);
  await expect(mangaPage.locator('.mt-badge')).toHaveCount(1);
});
