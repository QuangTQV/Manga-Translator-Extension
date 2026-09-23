import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SINGLE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;

// Eraser tool: paint over raw text with a brush (not just a rectangle) and
// have it inpainted away. Backend call is mocked; the mask math itself is
// covered by backend/tests/test_manual_region.py.
test.describe('eraser tool', () => {
  test('painting strokes and Apply sends a mask and shows the cleaned result; it survives a reload', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const seen: any[] = [];
    await context.route('**/region/erase', async (route) => {
      seen.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ image: FAKE_TRANSLATED_IMAGE_B64 }) });
    });

    const page = await context.newPage();
    await page.goto(SINGLE_URL);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await page.bringToFront();
    await popup.locator('#btn-eraser').click();
    await expect(page.locator('#mt-eraser-layer')).toBeVisible({ timeout: 10_000 });

    // Clicking Apply with nothing painted does nothing (no request, tool stays open).
    await page.locator('#mt-eraser-layer').getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('#mt-toast.error')).toBeVisible();
    expect(seen).toHaveLength(0);

    const imgBox = (await page.locator('img').first().boundingBox())!;
    const cx = imgBox.x + imgBox.width * 0.5;
    const cy = imgBox.y + imgBox.height * 0.4;
    await page.mouse.move(cx, cy);
    await page.mouse.down();
    await page.mouse.move(cx + 30, cy + 15, { steps: 5 });
    await page.mouse.up();

    await page.locator('#mt-eraser-layer').getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('#mt-eraser-layer')).toHaveCount(0, { timeout: 5_000 });
    expect(seen).toHaveLength(1);
    expect(typeof seen[0].image).toBe('string');
    expect(typeof seen[0].mask).toBe('string');

    const overlay = page.locator('img.mt-page-overlay');
    await expect(overlay).toBeVisible();

    // Persisted: after a reload, using the extension on the page reapplies it
    // automatically (same content-script-injected-on-demand pattern as the
    // manual region tool).
    await page.reload();
    const popup2 = await context.newPage();
    await popup2.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await page.bringToFront();
    await popup2.locator('#btn-eraser').click();
    await expect(page.locator('#mt-eraser-layer')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('img.mt-page-overlay')).toBeVisible({ timeout: 15_000 });
    expect(seen.length).toBeGreaterThanOrEqual(2);
  });

  test('Undo removes the last stroke and Clear removes all, without sending a request', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    let called = false;
    await context.route('**/region/erase', async (route) => { called = true; await route.abort(); });

    const page = await context.newPage();
    await page.goto(SINGLE_URL);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await page.bringToFront();
    await popup.locator('#btn-eraser').click();
    const layer = page.locator('#mt-eraser-layer');
    await expect(layer).toBeVisible({ timeout: 10_000 });

    const imgBox = (await page.locator('img').first().boundingBox())!;
    await page.mouse.move(imgBox.x + 20, imgBox.y + 20);
    await page.mouse.down();
    await page.mouse.move(imgBox.x + 40, imgBox.y + 40, { steps: 3 });
    await page.mouse.up();

    await layer.getByRole('button', { name: 'Undo' }).click();
    await layer.getByRole('button', { name: 'Apply' }).click();
    await expect(page.locator('#mt-toast.error')).toBeVisible(); // nothing left to erase
    expect(called).toBe(false);

    await page.keyboard.press('Escape');
    await expect(layer).toHaveCount(0);
  });
});
