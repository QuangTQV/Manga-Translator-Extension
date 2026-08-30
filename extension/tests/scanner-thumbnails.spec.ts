import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import { boxCenter, getAttr, hasAttr, hasClass, pierceQuery } from './shadow-dom';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site/index.html')}`;
const SINGLE_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;
const FAKE_TRANSLATED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

function dataUrlByteLength(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return Math.floor((b64.length * 3) / 4);
}

// The scanner grid used to feed each ~160px card's <img> the full-resolution
// page image (the same bytes sent for translation), decoded and composited
// at full size just to be shrunk via CSS — real memory/CPU cost across a
// whole chapter. Cards should now get a genuinely small, resized copy while
// the lightbox (opened to actually inspect a page) keeps showing the real
// full-resolution image.
test('scanner grid thumbnails are resized down; the lightbox still shows the full-resolution image', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  const mangaPage = await context.newPage();
  await mangaPage.goto(TEST_SITE_URL);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  await mangaPage.bringToFront();
  await popup.locator('#btn-scan').click();

  const cdp = await context.newCDPSession(mangaPage);
  await cdp.send('DOM.enable');

  const sourceBytes = fs.statSync(path.join(__dirname, 'fixtures/test-site/page1.jpg')).size;

  // Background thumbnail loading is async — poll until the first card's
  // <img> src actually switches to a resized (data:image/jpeg) copy.
  let thumbSrc: string | undefined;
  for (let i = 0; i < 30; i++) {
    const img = (await pierceQuery(cdp, (n) => hasClass(n, 'mts-thumb')))[0];
    const src = img ? getAttr(img, 'src') : undefined;
    if (src?.startsWith('data:image/jpeg')) { thumbSrc = src; break; }
    await mangaPage.waitForTimeout(200);
  }

  expect(thumbSrc).toBeTruthy();
  expect(thumbSrc!.startsWith('data:image/jpeg')).toBe(true);
  // A resized ~320px-wide JPEG must be a small fraction of the original
  // full-resolution source file, not a re-encoded full-size copy.
  expect(dataUrlByteLength(thumbSrc!)).toBeLessThan(sourceBytes / 2);

  // Open the lightbox for the same (untranslated) page — it must NOT show
  // the small thumbnail; it falls back to the real fetched full image.
  const zoomButtons = await pierceQuery(cdp, (n) => hasClass(n, 'mts-zoom-btn') && hasAttr(n, 'data-zoom-index', '0'));
  const { x, y } = await boxCenter(cdp, zoomButtons[0].nodeId);
  await mangaPage.mouse.click(x, y);
  await mangaPage.waitForTimeout(200);

  const lightboxImg = (await pierceQuery(cdp, (n) => hasAttr(n, 'id', 'mts-lightbox-img')))[0];
  const lightboxSrc = getAttr(lightboxImg, 'src');
  expect(lightboxSrc).toBeTruthy();
  expect(lightboxSrc).not.toBe(thumbSrc);
});

// Real bug caught while building the thumbnail optimization above: once the
// scanner-open rehydrate stopped mirroring translatedCache's full bytes into
// imageCache (to avoid holding two full-size copies of the same page),
// "Suggest Story Notes" — which used to read exclusively from imageCache —
// would silently see zero images for a chapter that was already fully
// translated in an earlier session, even though the real bytes were sitting
// right there in translatedCache.
test('Suggest Story Notes still finds a sample image for an already-translated page', async ({ context, extensionId }) => {
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

  const mangaPage = await context.newPage();
  await mangaPage.goto(SINGLE_SITE_URL);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  // Translate the page via auto-translate first, so it lands in the
  // persisted translatedCache exactly like a page translated in an earlier
  // session — the scenario that broke.
  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();
  await expect(mangaPage.locator('.mt-badge').first()).toBeVisible({ timeout: 15_000 });

  let suggestRequestBody: { images?: string[] } | null = null;
  await context.route('**/suggest-instructions', async (route) => {
    suggestRequestBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ suggestion: 'Cast: ...' }),
    });
  });

  // Open the scanner fresh (separate from the auto-translate tab state) —
  // this is what used to skip rehydrating imageCache for the now-translated
  // page.
  await mangaPage.bringToFront();
  await popup.locator('#btn-scan').click();
  await mangaPage.waitForTimeout(1500);

  const cdp = await context.newCDPSession(mangaPage);
  await cdp.send('DOM.enable');

  const cards = await pierceQuery(cdp, (n) => hasClass(n, 'mts-card') && hasAttr(n, 'data-index', '0'));
  expect(cards.length).toBe(1);
  const { x, y } = await boxCenter(cdp, cards[0].nodeId);
  await mangaPage.mouse.click(x, y); // select the card

  const suggestBtn = (await pierceQuery(cdp, (n) => hasAttr(n, 'data-action', 'suggest-instructions')))[0];
  const btnPos = await boxCenter(cdp, suggestBtn.nodeId);
  await mangaPage.mouse.click(btnPos.x, btnPos.y);
  await mangaPage.waitForTimeout(500);

  expect(suggestRequestBody).not.toBeNull();
  expect(suggestRequestBody!.images?.length).toBeGreaterThan(0);
  expect(suggestRequestBody!.images![0].length).toBeGreaterThan(0);
});
