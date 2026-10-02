import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site/index.html')}`;

// The floating "Auto MT" indicator used to pop in/out instantly — the one
// persistent on-page UI piece left without the fade/pop treatment already
// given to the toast, badges, magnifier, lightbox and hover-preview.
test('the auto-translate floating indicator pops in on start and fades out on stop', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  await context.route('**/translate', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        translated_image: FAKE_TRANSLATED_IMAGE_B64, bubbles: [], processing_time_seconds: 0.1,
        source_language: 'Japanese', target_language: 'English', provider: 'Google', ocr_texts: [], memory_note: null,
      }),
    });
  });

  const mangaPage = await context.newPage();
  await mangaPage.goto(TEST_SITE_URL);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();

  await expect(mangaPage.locator('.mt-auto-indicator')).toBeVisible({ timeout: 15_000 });

  await mangaPage.locator('#mt-auto-stop').click();

  // Still attached right after the click — the indicator shows a "stopped"
  // state for a beat (the pre-existing 600ms autoTranslateRemoveUiTimer)
  // before removeAutoTranslateUI() even starts the fade.
  await expect(mangaPage.locator('#mt-auto-root')).toHaveCount(1);
  // Gone (fade finished) well within the 600ms delay + ~220ms fade.
  await expect(mangaPage.locator('#mt-auto-root')).toHaveCount(0, { timeout: 2_000 });
});
