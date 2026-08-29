import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Single-image fixture — a multi-page one would race auto-translate's
// concurrent processing (".mt-fix-hit".first() could resolve to whichever
// page's bubble finishes translating first, not necessarily the one this
// test scrolls away from and back to).
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;
const FAKE_TRANSLATED_B64 = fs.readFileSync(path.join(__dirname, 'fixtures/test-site/page1.jpg')).toString('base64');
const BUBBLE_BBOX = [40, 30, 300, 180];

// Long chapters keep every translated page's full-resolution overlay image
// in the DOM for the rest of the session, even ones scrolled many screens
// out of view — the more pages read, the more the browser has to keep
// laying out/painting/compositing. content-visibility:auto tells the
// browser to skip that work for off-screen overlays and resume it
// automatically once scrolled near again — a pure rendering hint, so this
// mainly needs confirming it doesn't quietly break interactivity once a
// page scrolls back into view.
test.describe('content-visibility on translated overlays', () => {
  test('is applied to translated overlays, and hover-to-magnify still works after scrolling far away and back', async ({ context, extensionId }) => {
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
    await mangaPage.setViewportSize({ width: 900, height: 900 });
    await mangaPage.goto(TEST_SITE_URL);

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    await mangaPage.bringToFront();
    await popup.locator('#btn-auto').click();

    const overlay = mangaPage.locator('.mt-page-overlay').first();
    await expect(overlay).toBeVisible({ timeout: 15_000 });
    const contentVisibility = await overlay.evaluate((el) => getComputedStyle(el).contentVisibility);
    expect(contentVisibility).toBe('auto');

    // A tall spacer to actually scroll the page's single image far
    // off-screen and back — the fixture alone (~870px) mostly fits in a
    // 900px viewport with nothing worth scrolling past.
    await mangaPage.evaluate(() => {
      const spacer = document.createElement('div');
      spacer.style.height = '4000px';
      document.body.appendChild(spacer);
    });
    await mangaPage.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    await mangaPage.waitForTimeout(300);
    await mangaPage.evaluate(() => window.scrollTo(0, 0));
    await mangaPage.waitForTimeout(300);

    const hitTarget = mangaPage.locator('.mt-fix-hit').first();
    await expect(hitTarget).toBeVisible();
    const magnifier = mangaPage.locator('.mt-bubble-magnifier');
    await hitTarget.hover();
    await expect(magnifier).toBeVisible();
  });
});
