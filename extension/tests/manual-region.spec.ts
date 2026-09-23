import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SINGLE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;

// Manual region tool: box a spot on the page, read its text, type or AI-
// translate, and draw it over the cleaned spot. Backend calls are mocked.
test('box a text area, read it, AI-translate, apply — and it comes back after a reload', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  const seen: { ocr: any[]; translate: any[]; render: any[] } = { ocr: [], translate: [], render: [] };
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await context.route('**/region/ocr', async (route) => { seen.ocr.push(route.request().postDataJSON()); await route.fulfill(json({ text: 'こんにちは', warning: null })); });
  await context.route('**/region/translate', async (route) => { seen.translate.push(route.request().postDataJSON()); await route.fulfill(json({ translation: 'Hello there' })); });
  await context.route('**/region/render', async (route) => { seen.render.push(route.request().postDataJSON()); await route.fulfill(json({ image: FAKE_TRANSLATED_IMAGE_B64 })); });

  const page = await context.newPage();
  await page.goto(SINGLE_URL);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  // Start the tool from the popup, exactly like a user.
  await page.bringToFront();
  await popup.locator('#btn-region').click();
  await expect(page.locator('#mt-region-select')).toBeVisible({ timeout: 10_000 });

  const imgBox = (await page.locator('img').first().boundingBox())!;
  const x0 = imgBox.x + imgBox.width * 0.25;
  const y0 = imgBox.y + imgBox.height * 0.25;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + imgBox.width * 0.3, y0 + imgBox.height * 0.2, { steps: 6 });
  await page.mouse.up();

  const editor = page.locator('#mt-region-editor');
  await expect(editor.locator('#orig')).toHaveValue('こんにちは', { timeout: 10_000 });
  expect(seen.ocr).toHaveLength(1);
  expect(typeof seen.ocr[0].image).toBe('string');
  const b = seen.ocr[0].box;
  expect(b.x1).toBeCloseTo(0.25, 1);
  expect(b.x2 - b.x1).toBeCloseTo(0.3, 1);
  expect(b.y2).toBeGreaterThan(b.y1);

  await editor.locator('#ai').click();
  await expect(editor.locator('#trans')).toHaveValue('Hello there');
  expect(seen.translate[0].text).toBe('こんにちは');

  await editor.locator('#trans').fill('Xin chào');
  await editor.locator('#apply').click();
  await expect(page.locator('#mt-region-editor')).toHaveCount(0);
  expect(seen.render).toHaveLength(1);
  expect(seen.render[0].regions).toEqual([{ box: seen.ocr[0].box, text: 'Xin chào', restore_only: false }]);
  await expect(page.locator('img.mt-page-overlay')).toHaveAttribute('src', new RegExp(`^data:image/png;base64,${FAKE_TRANSLATED_IMAGE_B64.slice(0, 20)}`));

  // Persisted: the content script is injected on demand (no manifest
  // content_scripts), so after a reload the saved regions come back as soon as
  // the extension is used on the page again — here, by opening the tool.
  await page.reload();
  const popup2 = await context.newPage(); // the first popup closed itself after starting the tool
  await popup2.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await page.bringToFront();
  await popup2.locator('#btn-region').click();
  await expect(page.locator('#mt-region-select')).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('img.mt-page-overlay')).toHaveAttribute('src', /^data:image\/png/, { timeout: 15_000 });
  expect(seen.render.length).toBeGreaterThanOrEqual(2);
  expect(seen.render.at(-1).regions[0].text).toBe('Xin chào');
});

async function startAndDrag(context: any, page: any, extensionId: string, fx = 0.25, fy = 0.25) {
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await page.bringToFront();
  await popup.locator('#btn-region').click();
  await expect(page.locator('#mt-region-select')).toBeVisible({ timeout: 10_000 });
  const imgBox = (await page.locator('img').first().boundingBox())!;
  const x0 = imgBox.x + imgBox.width * fx;
  const y0 = imgBox.y + imgBox.height * fy;
  await page.mouse.move(x0, y0);
  await page.mouse.down();
  await page.mouse.move(x0 + imgBox.width * 0.3, y0 + imgBox.height * 0.2, { steps: 6 });
  await page.mouse.up();
}

test('an unreadable area lets the user type the text; re-selecting it edits, and Delete removes it', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  let ocrCalls = 0;
  const renders: any[] = [];
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await context.route('**/region/ocr', async (route) => { ocrCalls++; await route.fulfill(json({ text: '', warning: 'ocr_failed' })); });
  await context.route('**/region/render', async (route) => { renders.push(route.request().postDataJSON()); await route.fulfill(json({ image: FAKE_TRANSLATED_IMAGE_B64 })); });

  const page = await context.newPage();
  await page.goto(SINGLE_URL);
  await startAndDrag(context, page, extensionId);

  const editor = page.locator('#mt-region-editor');
  await expect(editor.locator('#status')).toContainText('type it in', { timeout: 10_000 });
  await expect(editor.locator('#orig')).toBeEnabled();
  await expect(editor.locator('#del')).toBeHidden(); // a new region has nothing to delete

  await editor.locator('#orig').fill('手打ち');
  await editor.locator('#trans').fill('Typed by hand');
  await editor.locator('#apply').click();
  await expect(editor).toHaveCount(0);
  expect(renders[0].regions[0].text).toBe('Typed by hand');
  const overlay = page.locator('img.mt-page-overlay');
  await expect(overlay).toBeVisible();

  // Selecting the same spot again edits the saved region (no second OCR) ...
  await startAndDrag(context, page, extensionId, 0.27, 0.27);
  await expect(editor.locator('#orig')).toHaveValue('手打ち', { timeout: 10_000 });
  await expect(editor.locator('#trans')).toHaveValue('Typed by hand');
  expect(ocrCalls).toBe(1);

  // ... and Delete puts the original page back.
  await editor.locator('#del').click();
  await expect(editor).toHaveCount(0);
  await expect(overlay).toBeHidden();
});

test('Escape cancels the selection and a too-small drag shows an error, sending nothing', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));
  let calls = 0;
  await context.route('**/region/**', async (route) => { calls++; await route.abort(); });

  const page = await context.newPage();
  await page.goto(SINGLE_URL);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await page.bringToFront();
  await popup.locator('#btn-region').click();
  await expect(page.locator('#mt-region-select')).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('#mt-region-select')).toHaveCount(0);

  const popup2 = await context.newPage();
  await popup2.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await page.bringToFront();
  await popup2.locator('#btn-region').click();
  await expect(page.locator('#mt-region-select')).toBeVisible({ timeout: 10_000 });
  const imgBox = (await page.locator('img').first().boundingBox())!;
  await page.mouse.move(imgBox.x + 40, imgBox.y + 40);
  await page.mouse.down();
  await page.mouse.move(imgBox.x + 44, imgBox.y + 43);
  await page.mouse.up();
  await expect(page.locator('#mt-toast')).toContainText('too small');
  expect(calls).toBe(0);
});
