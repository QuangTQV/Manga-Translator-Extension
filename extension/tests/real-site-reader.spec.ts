import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const READER_URL = `file://${path.resolve(__dirname, 'fixtures/test-site-lazy/index.html')}`;

// A reader-like page swaps a placeholder for a lazy-loaded chapter image after
// intersection, as production manga readers commonly do.
test('manual editing works on a reader page after its lazy image source swaps', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  const renders: Array<Record<string, any>> = [];
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await context.route('**/region/ocr', async (route) => { await route.fulfill(json({ text: '手紙', warning: null })); });
  await context.route('**/region/render', async (route) => {
    renders.push(route.request().postDataJSON());
    await route.fulfill(json({ image: FAKE_TRANSLATED_IMAGE_B64 }));
  });

  const page = await context.newPage();
  await page.goto(READER_URL);
  const image = page.locator('#reader-page');
  await expect.poll(() => image.evaluate((element: HTMLImageElement) => element.naturalWidth)).toBe(600);
  await expect(image).not.toHaveAttribute('data-src');

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await page.bringToFront();
  await popup.locator('#btn-region').click();
  await expect(page.locator('#mt-region-select')).toBeVisible({ timeout: 10_000 });

  const bounds = (await image.boundingBox())!;
  const x = bounds.x + bounds.width * 0.2;
  const y = bounds.y + bounds.height * 0.2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + bounds.width * 0.35, y + bounds.height * 0.18, { steps: 5 });
  await page.mouse.up();

  const editor = page.locator('#mt-region-editor');
  await expect(editor.locator('#orig')).toHaveValue('手紙', { timeout: 10_000 });
  await editor.locator('#trans').fill('A letter');
  await editor.locator('#apply').click();
  await expect(editor).toHaveCount(0);

  expect(renders).toHaveLength(1);
  expect(renders[0].image).toBeTruthy();
  expect(renders[0].regions[0].text).toBe('A letter');
  expect(renders[0].regions[0].box.x1).toBeCloseTo(0.2, 1);
  expect(renders[0].regions[0].box.x2 - renders[0].regions[0].box.x1).toBeCloseTo(0.35, 1);
  await expect(page.locator('.mt-fix-hit')).toHaveCount(1);
});
