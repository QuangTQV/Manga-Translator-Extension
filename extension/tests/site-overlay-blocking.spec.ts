import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site-blocking-overlay/index.html')}`;
const FAKE_TRANSLATED_B64 = fs.readFileSync(path.join(__dirname, 'fixtures/test-site/page1.jpg')).toString('base64');
const BUBBLE_BBOX = [40, 30, 300, 180];

// Real bug report: on some manga sites, hover-to-magnify, click-to-fix, and
// the in-progress badge would all silently stop working — as if something
// were sitting on top of the extension's own layers, even though the
// translated image itself still rendered fine. Root cause: every per-bubble
// decoration (overlay, badges, buttons, the fix-hit-layer) used a tiny
// z-index (9-12) — trivially beaten by a manga site's OWN sibling elements
// in the same local stacking context (lazy-load placeholders, ad slots,
// "click to continue" layers routinely use z-index in the hundreds to low
// thousands). The fixture here reproduces exactly that: a sibling overlay
// div at z-index:999 covering the image area, transparent so the page
// still *looks* fine, but capturing pointer events meant for the
// extension's elements underneath.
test.describe('a site overlay sibling with a real-world z-index does not block extension interaction', () => {
  test('hover-to-magnify and click-to-fix still work through it', async ({ context, extensionId }) => {
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

    // Playwright's hover() waits for the target to actually be capable of
    // receiving the pointer event (not occluded by another element) before
    // acting — with the old small z-index, this would time out because
    // .site-overlay (z-index:999) sits on top and intercepts it.
    const magnifier = mangaPage.locator('.mt-bubble-magnifier');
    await hitTarget.hover();
    await expect(magnifier).toBeVisible();

    // Same story for click-to-fix: the click must actually land on the hit
    // target (not the site overlay above it) to open the popover at all.
    await hitTarget.click();
    const popover = mangaPage.locator('.mt-fix-popover');
    await expect(popover).toBeVisible({ timeout: 5_000 });
  });
});
