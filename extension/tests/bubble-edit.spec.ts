import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;
const FAKE_B64 = FAKE_TRANSLATED_IMAGE_B64;
// page1.jpg (used by the single-image fixture) is 600x850.
const BUBBLE_BBOX = [40, 30, 300, 180];
const NATURAL_W = 600;
const NATURAL_H = 850;

// "Fix a translation" now also offers Move/Delete for a wrongly-detected
// bubble's box itself — both reuse the manual region tool's restore-from-
// source (see region-tool.ts:startMoveBubbleSelect/deleteBubbleRegion).
test.describe('bubble box editing (move / delete a detected bubble)', () => {
  test('Delete restores the original art at the bubble\'s box and removes its hit target', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    await context.route('**/translate', async (route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          translated_image: FAKE_B64,
          bubbles: [{ bbox: BUBBLE_BBOX, confidence: 0.9, original_text: 'げんき？', translated_text: 'You okay?' }],
          processing_time_seconds: 0.1, source_language: 'Japanese', target_language: 'English', provider: 'Google', ocr_texts: ['げんき？'],
        }),
      });
    });

    let renderBody: any = null;
    await context.route('**/region/render', async (route) => {
      renderBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ image: FAKE_B64 }) });
    });

    const mangaPage = await context.newPage();
    await mangaPage.goto(TEST_SITE_URL);
    mangaPage.on('dialog', (dialog) => { void dialog.accept(); });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    await mangaPage.bringToFront();
    await popup.locator('#btn-auto').click();

    const hitTarget = mangaPage.locator('.mt-fix-hit');
    await expect(hitTarget).toHaveCount(1, { timeout: 15_000 });
    await hitTarget.first().click();

    const popover = mangaPage.locator('.mt-fix-popover');
    await expect(popover).toBeVisible({ timeout: 5_000 });
    await popover.getByRole('button', { name: /Delete/ }).click();

    await expect.poll(() => renderBody, { timeout: 5_000 }).not.toBeNull();
    expect(renderBody.source_image).toBeTruthy();
    expect(renderBody.regions).toHaveLength(1);
    expect(renderBody.regions[0].restore_only).toBe(true);
    expect(renderBody.regions[0].box.x1).toBeCloseTo(BUBBLE_BBOX[0] / NATURAL_W, 4);
    expect(renderBody.regions[0].box.y1).toBeCloseTo(BUBBLE_BBOX[1] / NATURAL_H, 4);
    expect(renderBody.regions[0].box.x2).toBeCloseTo(BUBBLE_BBOX[2] / NATURAL_W, 4);
    expect(renderBody.regions[0].box.y2).toBeCloseTo(BUBBLE_BBOX[3] / NATURAL_H, 4);

    // The popover closes and the bubble's own hit target is gone (deleted).
    await expect(popover).toHaveCount(0);
    await expect(hitTarget).toHaveCount(0);
  });

  test('Move opens the editor pre-filled (no OCR call) and commits a restore-old + draw-new pair', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    await context.route('**/translate', async (route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          translated_image: FAKE_B64,
          bubbles: [{ bbox: BUBBLE_BBOX, confidence: 0.9, original_text: 'げんき？', translated_text: 'You okay?' }],
          processing_time_seconds: 0.1, source_language: 'Japanese', target_language: 'English', provider: 'Google', ocr_texts: ['げんき？'],
        }),
      });
    });

    let ocrCalls = 0;
    let renderBody: any = null;
    await context.route('**/region/ocr', async (route) => { ocrCalls++; await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'should not be called', warning: null }) }); });
    await context.route('**/region/render', async (route) => {
      renderBody = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ image: FAKE_B64 }) });
    });

    const mangaPage = await context.newPage();
    await mangaPage.goto(TEST_SITE_URL);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    await mangaPage.bringToFront();
    await popup.locator('#btn-auto').click();

    const hitTarget = mangaPage.locator('.mt-fix-hit');
    await expect(hitTarget).toHaveCount(1, { timeout: 15_000 });
    await hitTarget.first().click();

    const popover = mangaPage.locator('.mt-fix-popover');
    await expect(popover).toBeVisible({ timeout: 5_000 });
    await popover.getByRole('button', { name: /Move/ }).click();
    await expect(popover).toHaveCount(0);
    // Deselecting the old hit target happens immediately when Move is clicked.
    await expect(hitTarget).toHaveCount(0);

    await expect(mangaPage.locator('#mt-region-select')).toBeVisible({ timeout: 5_000 });
    const img = mangaPage.locator('img').first();
    const imgBox = (await img.boundingBox())!;
    const x0 = imgBox.x + imgBox.width * 0.5;
    const y0 = imgBox.y + imgBox.height * 0.6;
    await mangaPage.mouse.move(x0, y0);
    await mangaPage.mouse.down();
    await mangaPage.mouse.move(x0 + imgBox.width * 0.25, y0 + imgBox.height * 0.15, { steps: 6 });
    await mangaPage.mouse.up();

    const editor = mangaPage.locator('#mt-region-editor');
    await expect(editor.locator('#orig')).toHaveValue('げんき？', { timeout: 5_000 });
    await expect(editor.locator('#trans')).toHaveValue('You okay?');
    expect(ocrCalls).toBe(0); // the bubble's text was already known — no re-OCR

    await editor.locator('#trans').fill('You good?');
    await editor.locator('#apply').click();
    await expect(editor).toHaveCount(0);

    await expect.poll(() => renderBody, { timeout: 5_000 }).not.toBeNull();
    expect(renderBody.source_image).toBeTruthy();
    expect(renderBody.regions).toHaveLength(2);
    const restoreRegion = renderBody.regions.find((r: any) => r.restore_only);
    const drawRegion = renderBody.regions.find((r: any) => !r.restore_only);
    expect(restoreRegion.box.x1).toBeCloseTo(BUBBLE_BBOX[0] / NATURAL_W, 4);
    expect(drawRegion.text).toBe('You good?');
    expect(drawRegion.box.x1).toBeGreaterThan(restoreRegion.box.x2 - 0.01); // dragged to a visibly different spot

    // The moved bubble is hoverable again — at its NEW spot, with its original text.
    await expect(hitTarget).toHaveCount(1);
    const hitBox = (await hitTarget.boundingBox())!;
    expect(hitBox.x).toBeCloseTo(imgBox.x + imgBox.width * 0.5, -1);
    await hitTarget.hover();
    await expect(mangaPage.locator('.mt-bubble-magnifier-caption')).toHaveText('げんき？');
  });

  test('detected bubbles and a manual text area coexist: each keeps its own click behaviour', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    await context.route('**/translate', async (route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          translated_image: FAKE_B64,
          bubbles: [{ bbox: BUBBLE_BBOX, confidence: 0.9, original_text: 'げんき？', translated_text: 'You okay?' }],
          processing_time_seconds: 0.1, source_language: 'Japanese', target_language: 'English', provider: 'Google', ocr_texts: ['げんき？'],
        }),
      });
    });
    const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    await context.route('**/region/ocr', async (route) => { await route.fulfill(json({ text: '手動', warning: null })); });
    await context.route('**/region/render', async (route) => { await route.fulfill(json({ image: FAKE_B64 })); });

    const mangaPage = await context.newPage();
    await mangaPage.goto(TEST_SITE_URL);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await mangaPage.bringToFront();
    await popup.locator('#btn-auto').click();
    const hits = mangaPage.locator('.mt-fix-hit');
    await expect(hits).toHaveCount(1, { timeout: 15_000 });

    // Add a manual text area somewhere else on the page.
    const popup2 = await context.newPage();
    await popup2.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await mangaPage.bringToFront();
    await popup2.locator('#btn-region').click();
    await expect(mangaPage.locator('#mt-region-select')).toBeVisible({ timeout: 10_000 });
    const imgBox = (await mangaPage.locator('img').first().boundingBox())!;
    const x0 = imgBox.x + imgBox.width * 0.5;
    const y0 = imgBox.y + imgBox.height * 0.6;
    await mangaPage.mouse.move(x0, y0);
    await mangaPage.mouse.down();
    await mangaPage.mouse.move(x0 + imgBox.width * 0.3, y0 + imgBox.height * 0.15, { steps: 6 });
    await mangaPage.mouse.up();
    const editor = mangaPage.locator('#mt-region-editor');
    await expect(editor.locator('#orig')).toHaveValue('手動', { timeout: 10_000 });
    await editor.locator('#trans').fill('By hand');
    await editor.locator('#apply').click();
    await expect(editor).toHaveCount(0);

    await expect(hits).toHaveCount(2, { timeout: 10_000 });
    // The detected bubble is still first (its index is what a fix-hint sends back) and still
    // opens the fix popover; the manual one hovers with its own original text and opens the editor.
    await expect(hits.nth(0)).toHaveAttribute('title', /fix|Fix|correct/i);
    await hits.nth(0).hover();
    await expect(mangaPage.locator('.mt-bubble-magnifier-caption')).toHaveText('げんき？');
    await hits.nth(0).click();
    const popover = mangaPage.locator('.mt-fix-popover');
    await expect(popover).toBeVisible({ timeout: 5_000 });
    await mangaPage.keyboard.press('Escape');

    await expect(hits.nth(1)).toHaveAttribute('title', 'Click to edit this text area');
    await hits.nth(1).hover();
    await expect(mangaPage.locator('.mt-bubble-magnifier-caption')).toHaveText('手動');
    await hits.nth(1).click();
    await expect(editor.locator('#trans')).toHaveValue('By hand', { timeout: 10_000 });
  });
});
