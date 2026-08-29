import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A single-image fixture, not the 4-page test-site — auto-translate
// processes every page on the site concurrently, and racing to hover
// "whichever page's bubble finished first" (possibly far down the page,
// needing a large scroll-into-view) made this test flaky. One page removes
// the race entirely.
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;
const FAKE_TRANSLATED_B64 = fs.readFileSync(path.join(__dirname, 'fixtures/test-site/page1.jpg')).toString('base64');
// page1.jpg is 600x850.
const BUBBLE_BBOX = [40, 30, 300, 180];

// The overlay image is the only "reading surface" the user actually has —
// bubble text is baked into it server-side, so "enlarge on hover" can't
// re-render at a bigger font. Instead it shows a zoomed CSS crop of the
// hovered bubble's region, positioned near it.
test('hovering a translated bubble shows a magnified crop; leaving hides it', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  await context.route('**/translate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        translated_image: FAKE_TRANSLATED_B64,
        bubbles: [{ bbox: BUBBLE_BBOX, confidence: 0.9, original_text: 'げんき？', translated_text: 'You okay?' }],
        processing_time_seconds: 0.1,
        source_language: 'Japanese',
        target_language: 'English',
        provider: 'Google',
        ocr_texts: ['げんき？'],
      }),
    });
  });

  const mangaPage = await context.newPage();
  await mangaPage.goto(TEST_SITE_URL);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();

  const hitTarget = mangaPage.locator('.mt-fix-hit').first();
  await expect(hitTarget).toBeVisible({ timeout: 15_000 });

  const magnifier = mangaPage.locator('.mt-bubble-magnifier');
  await expect(magnifier).toHaveCount(0);

  await hitTarget.hover();
  await expect(magnifier).toBeVisible();

  const box = await magnifier.boundingBox();
  expect(box).not.toBeNull();
  expect(box!.width).toBeGreaterThan(100);
  expect(box!.height).toBeGreaterThan(100);

  const magnifierImage = magnifier.locator('.mt-bubble-magnifier-image');
  const bgImage = await magnifierImage.evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(bgImage).toContain('data:image');

  // The original (source-language) OCR text the backend returned should be
  // shown as a caption, so a reader can cross-check the translation choice.
  const caption = magnifier.locator('.mt-bubble-magnifier-caption');
  await expect(caption).toHaveText('げんき？');

  // The caption must sit BELOW the zoomed crop, never on top of it — an
  // earlier version absolutely-positioned it over the image's bottom edge,
  // which covered up whatever translated text happened to be there.
  const imageBox = await magnifierImage.boundingBox();
  const captionBox = await caption.boundingBox();
  expect(imageBox).not.toBeNull();
  expect(captionBox).not.toBeNull();
  expect(captionBox!.y).toBeGreaterThanOrEqual(imageBox!.y + imageBox!.height - 1);

  // Move off the bubble entirely (not just to another element) so the
  // hit-target's own mouseleave actually fires.
  await mangaPage.mouse.move(5, 5);
  await expect(magnifier).toBeHidden();
});

// A real production bug: only the inner .mt-bubble-magnifier-image div had
// an explicit width set, not the outer flex container — so a long caption
// (a caption box's original text, as one naturally long sentence) forced
// the unconstrained container to grow wide enough to fit it as a single
// unwrapped line, leaving the actual crop sitting in a mostly-empty
// oversized box instead of the caption wrapping to the crop's width.
test('a long caption wraps within the crop width instead of stretching the box', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  const longOriginal = 'While we were on a three-day, two-night summer vacation field trip, this amazing scene played out right in front of me and I could not believe what I was seeing at all.';

  await context.route('**/translate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        translated_image: FAKE_TRANSLATED_B64,
        bubbles: [{ bbox: BUBBLE_BBOX, confidence: 0.9, original_text: longOriginal, translated_text: 'Ngắn gọn thôi.' }],
        processing_time_seconds: 0.1,
        source_language: 'Japanese',
        target_language: 'Vietnamese',
        provider: 'Google',
        ocr_texts: [longOriginal],
      }),
    });
  });

  const mangaPage = await context.newPage();
  await mangaPage.goto(TEST_SITE_URL);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();

  const hitTarget = mangaPage.locator('.mt-fix-hit').first();
  await expect(hitTarget).toBeVisible({ timeout: 15_000 });

  const magnifier = mangaPage.locator('.mt-bubble-magnifier');
  await hitTarget.hover();
  await expect(magnifier).toBeVisible();

  const magnifierImage = magnifier.locator('.mt-bubble-magnifier-image');
  const caption = magnifier.locator('.mt-bubble-magnifier-caption');
  const outerBox = await magnifier.boundingBox();
  const imageBox = await magnifierImage.boundingBox();
  const captionBox = await caption.boundingBox();
  expect(outerBox).not.toBeNull();
  expect(imageBox).not.toBeNull();
  expect(captionBox).not.toBeNull();

  // The outer box (and the caption inside it) must match the crop's width,
  // not balloon out to fit the long sentence as one line. Allow a couple
  // px of slack for the outer container's own border (border-box sizing).
  expect(Math.abs(outerBox!.width - imageBox!.width)).toBeLessThanOrEqual(3);
  expect(Math.abs(captionBox!.width - imageBox!.width)).toBeLessThanOrEqual(3);

  // Confirms the text actually wrapped: at ~12px font / 1.35 line-height,
  // one line is ~24px tall including padding — a caption this long at a
  // width this narrow must wrap into several lines, not stay on one.
  expect(captionBox!.height).toBeGreaterThan(40);
});

// A 1x1 transparent PNG, distinct from FAKE_TRANSLATED_B64 (page1.jpg's
// bytes) — used to confirm the magnifier actually switches source images,
// not just that *some* background-image is set.
const HIGH_RES_CROP_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// The backend renders each bubble at several times the final resolution
// before downscaling it back down for the page — that sharper intermediate
// is optionally returned per-bubble. When present, the magnifier should use
// it directly (stretched to exactly fill the box) instead of cropping the
// blurrier, already-downscaled page image.
test('when the backend returns a high-res crop, the magnifier uses it instead of the page crop', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  await context.route('**/translate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        translated_image: FAKE_TRANSLATED_B64,
        bubbles: [{
          bbox: BUBBLE_BBOX,
          confidence: 0.9,
          original_text: 'げんき？',
          translated_text: 'You okay?',
          high_res_crop: HIGH_RES_CROP_B64,
        }],
        processing_time_seconds: 0.1,
        source_language: 'Japanese',
        target_language: 'English',
        provider: 'Google',
        ocr_texts: ['げんき？'],
      }),
    });
  });

  const mangaPage = await context.newPage();
  await mangaPage.goto(TEST_SITE_URL);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();

  const hitTarget = mangaPage.locator('.mt-fix-hit').first();
  await expect(hitTarget).toBeVisible({ timeout: 15_000 });

  const magnifier = mangaPage.locator('.mt-bubble-magnifier');
  await hitTarget.hover();
  await expect(magnifier).toBeVisible();

  const magnifierImage = magnifier.locator('.mt-bubble-magnifier-image');
  const style = await magnifierImage.evaluate((el) => {
    const s = getComputedStyle(el);
    return { backgroundImage: s.backgroundImage, backgroundSize: s.backgroundSize };
  });
  expect(style.backgroundImage).toContain(HIGH_RES_CROP_B64);
  expect(style.backgroundSize).toBe('100% 100%');
});
