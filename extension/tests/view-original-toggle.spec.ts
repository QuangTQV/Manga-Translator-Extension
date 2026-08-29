import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site/index.html')}`;

// A 1x1 transparent PNG, base64, no data: prefix.
const FAKE_TRANSLATED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// The translated result is a separate <img> stacked on top of the original
// (whose own src is never rewritten) — the "view original" button just
// toggles that overlay's visibility so the reader can compare against the
// untranslated art without losing their place or re-fetching anything.
test('the view-original button hides/shows the translated overlay over the untouched original image', async ({ context, extensionId }) => {
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
  await mangaPage.goto(TEST_SITE_URL);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();

  const toggleBtn = mangaPage.locator('.mt-original-toggle-btn').first();
  await expect(toggleBtn).toBeVisible({ timeout: 15_000 });

  const overlay = mangaPage.locator('.mt-page-overlay').first();
  await expect(overlay).toBeVisible();

  await toggleBtn.click();
  await expect(overlay).toBeHidden();
  await expect(toggleBtn).toHaveClass(/active/);

  await toggleBtn.click();
  await expect(overlay).toBeVisible();
  await expect(toggleBtn).not.toHaveClass(/active/);
});
