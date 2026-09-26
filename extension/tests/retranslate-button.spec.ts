import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// One page only: a specific, predictable overlay/button (see CLAUDE.md on the 4-page fixture).
const SINGLE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;

// A different, valid 1x1 PNG (red) so a second translation is distinguishable from the first.
const SECOND_TRANSLATION_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';

function translateResponse(image: string) {
  return JSON.stringify({
    translated_image: image, bubbles: [], processing_time_seconds: 0.1,
    source_language: 'Japanese', target_language: 'English', provider: 'Google', ocr_texts: [], memory_note: null,
  });
}

// The per-page "re-translate" button, stacked under the MT badge / download /
// view-original buttons: translate this page again with the current settings.
async function autoTranslateOnePage(context: any, extensionId: string) {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));
}

async function startAuto(context: any, extensionId: string) {
  const mangaPage = await context.newPage();
  await mangaPage.goto(SINGLE_URL);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();
  return mangaPage;
}

test.describe('re-translate button', () => {
  test('sits under the other page buttons and re-translates the page, bypassing the backend cache', async ({ context, extensionId }) => {
    await autoTranslateOnePage(context, extensionId);
    const bodies: any[] = [];
    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      bodies.push(route.request().postDataJSON());
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: translateResponse(bodies.length === 1 ? FAKE_TRANSLATED_IMAGE_B64 : SECOND_TRANSLATION_B64),
      });
    });

    const page = await startAuto(context, extensionId);
    const retranslate = page.locator('.mt-retranslate-btn');
    await expect(retranslate).toBeVisible({ timeout: 15_000 });
    await expect(retranslate).toHaveText('↻');
    await expect(retranslate).toHaveAttribute('title', 'Re-translate this page');

    // Same right-aligned column as the others, directly below the eye button.
    const eye = await page.locator('.mt-original-toggle-btn').boundingBox();
    const again = await retranslate.boundingBox();
    const badge = await page.locator('.mt-badge').boundingBox();
    const download = await page.locator('.mt-export-btn').boundingBox();
    expect(badge!.y).toBeLessThan(download!.y);
    expect(download!.y).toBeLessThan(eye!.y);
    expect(eye!.y).toBeLessThan(again!.y);
    expect(Math.abs((again!.x + again!.width) - (eye!.x + eye!.width))).toBeLessThan(6);
    expect(again!.y).toBeGreaterThanOrEqual(eye!.y + eye!.height - 1); // no overlap with the eye button

    // The first, ordinary translation does not ask to skip the cache.
    expect(bodies).toHaveLength(1);
    expect(bodies[0].bypass_translation_cache).toBeUndefined();
    const overlay = page.locator('.mt-page-overlay');
    await expect(overlay).toHaveAttribute('src', `data:image/png;base64,${FAKE_TRANSLATED_IMAGE_B64}`);

    await retranslate.click();
    await expect(overlay).toHaveAttribute('src', `data:image/png;base64,${SECOND_TRANSLATION_B64}`, { timeout: 10_000 });
    expect(bodies).toHaveLength(2);
    expect(bodies[1].bypass_translation_cache).toBe(true);
    expect(bodies[1].image).toBe(bodies[0].image); // the same source page, re-sent
    await expect(retranslate).toHaveText('↻'); // back to idle
    await expect(overlay).toBeVisible();
  });

  test('shows a busy state and ignores a second click while the request is running', async ({ context, extensionId }) => {
    await autoTranslateOnePage(context, extensionId);
    let posts = 0;
    let releaseSecond!: () => void;
    const gate = new Promise<void>((resolve) => { releaseSecond = resolve; });
    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      if (posts > 1) await gate; // the re-translation hangs until released
      await route.fulfill({ status: 200, contentType: 'application/json', body: translateResponse(posts === 1 ? FAKE_TRANSLATED_IMAGE_B64 : SECOND_TRANSLATION_B64) });
    });

    const page = await startAuto(context, extensionId);
    const retranslate = page.locator('.mt-retranslate-btn');
    await expect(retranslate).toBeVisible({ timeout: 15_000 });
    await retranslate.click();
    await expect(retranslate).toHaveText('…');
    await expect(retranslate).toHaveAttribute('title', 'Re-translating…');
    await retranslate.click();
    await retranslate.click();
    await page.waitForTimeout(500);
    expect(posts).toBe(2); // the original + exactly one re-translation

    releaseSecond();
    await expect(retranslate).toHaveText('↻', { timeout: 10_000 });
    await expect(page.locator('.mt-page-overlay')).toHaveAttribute('src', `data:image/png;base64,${SECOND_TRANSLATION_B64}`);
    expect(posts).toBe(2);
  });

  test('a failed re-translation keeps the current translation, says so, and can be retried', async ({ context, extensionId }) => {
    await autoTranslateOnePage(context, extensionId);
    let posts = 0;
    await context.route('**/translate', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      posts += 1;
      if (posts === 2) {
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'boom' }) });
        return;
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: translateResponse(posts === 1 ? FAKE_TRANSLATED_IMAGE_B64 : SECOND_TRANSLATION_B64) });
    });

    const page = await startAuto(context, extensionId);
    const retranslate = page.locator('.mt-retranslate-btn');
    const overlay = page.locator('.mt-page-overlay');
    await expect(retranslate).toBeVisible({ timeout: 15_000 });

    await retranslate.click();
    await expect(page.locator('#mt-toast')).toContainText('Could not re-translate this page');
    await expect(retranslate).toHaveText('↻');
    await expect(overlay).toHaveAttribute('src', `data:image/png;base64,${FAKE_TRANSLATED_IMAGE_B64}`); // untouched
    await expect(overlay).toBeVisible();

    await retranslate.click(); // third request succeeds
    await expect(overlay).toHaveAttribute('src', `data:image/png;base64,${SECOND_TRANSLATION_B64}`, { timeout: 10_000 });
  });
});
