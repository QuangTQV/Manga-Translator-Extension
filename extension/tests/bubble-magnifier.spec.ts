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

  const bgImage = await magnifier.evaluate((el) => getComputedStyle(el).backgroundImage);
  expect(bgImage).toContain('data:image');

  // The original (source-language) OCR text the backend returned should be
  // shown as a caption, so a reader can cross-check the translation choice.
  await expect(magnifier.locator('.mt-bubble-magnifier-caption')).toHaveText('げんき？');

  // Move off the bubble entirely (not just to another element) so the
  // hit-target's own mouseleave actually fires.
  await mangaPage.mouse.move(5, 5);
  await expect(magnifier).toBeHidden();
});
