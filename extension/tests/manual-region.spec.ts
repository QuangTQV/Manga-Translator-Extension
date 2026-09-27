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

// A manual text area used to be drawn onto the page but not hoverable: the
// hover-to-magnify crop (with the original text as a caption) and click-to-
// fix only existed for bubbles the auto-translation detected, so a spot the
// reader typed or AI-translated by hand couldn't be zoomed or compared with
// its source.
test.describe('a manual text area is hoverable like a detected bubble', () => {
  async function applyRegion(context: any, extensionId: string, original: string, translation: string) {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));
    const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    const renders: any[] = [];
    await context.route('**/region/ocr', async (route) => { await route.fulfill(json({ text: original, warning: null })); });
    await context.route('**/region/translate', async (route) => { await route.fulfill(json({ translation })); });
    await context.route('**/region/render', async (route) => { renders.push(route.request().postDataJSON()); await route.fulfill(json({ image: FAKE_TRANSLATED_IMAGE_B64 })); });

    const page = await context.newPage();
    await page.goto(SINGLE_URL);
    await startAndDrag(context, page, extensionId);
    const editor = page.locator('#mt-region-editor');
    await expect(editor.locator('#orig')).toHaveValue(original, { timeout: 10_000 });
    await editor.locator('#ai').click();
    await expect(editor.locator('#trans')).toHaveValue(translation);
    await editor.locator('#apply').click();
    await expect(editor).toHaveCount(0);
    return { page, editor, renders };
  }

  test('hovering it shows the zoomed crop with the original text; clicking it opens the editor on that region', async ({ context, extensionId }) => {
    const { page, editor, renders } = await applyRegion(context, extensionId, 'こんにちは', 'Xin chào');

    const hit = page.locator('.mt-fix-hit');
    await expect(hit).toHaveCount(1, { timeout: 10_000 });
    await expect(hit).toHaveAttribute('title', 'Click to edit this text area');

    // The hit target covers the box the reader dragged.
    const imgBox = (await page.locator('img').first().boundingBox())!;
    const hitBox = (await hit.boundingBox())!;
    expect(hitBox.x).toBeCloseTo(imgBox.x + imgBox.width * 0.25, -1);
    expect(hitBox.width).toBeCloseTo(imgBox.width * 0.3, -1);

    await hit.hover();
    const magnifier = page.locator('.mt-bubble-magnifier');
    await expect(magnifier).toBeVisible();
    await expect(magnifier.locator('.mt-bubble-magnifier-caption')).toHaveText('こんにちは');
    await page.mouse.move(imgBox.x + 2, imgBox.y + imgBox.height - 2); // leave
    await expect(magnifier).toBeHidden();

    // Clicking edits this very region: its texts are filled in, no new OCR.
    await hit.click();
    await expect(editor.locator('#orig')).toHaveValue('こんにちは', { timeout: 10_000 });
    await expect(editor.locator('#trans')).toHaveValue('Xin chào');
    await expect(editor.locator('#del')).toBeVisible();
    await editor.locator('#trans').fill('Chào bạn');
    await editor.locator('#apply').click();
    await expect(editor).toHaveCount(0);
    expect(renders.at(-1).regions).toHaveLength(1); // edited in place, not duplicated
    expect(renders.at(-1).regions[0].text).toBe('Chào bạn');
    await expect(page.locator('.mt-fix-hit')).toHaveCount(1);
  });

  test('typing the translation by hand works the same, and deleting the region removes its hit target', async ({ context, extensionId }) => {
    const { page, editor } = await applyRegion(context, extensionId, '手打ち', 'Typed by hand');
    const hit = page.locator('.mt-fix-hit');
    await expect(hit).toHaveCount(1, { timeout: 10_000 });
    await hit.hover();
    await expect(page.locator('.mt-bubble-magnifier-caption')).toHaveText('手打ち');

    await hit.click();
    await expect(editor.locator('#del')).toBeVisible({ timeout: 10_000 });
    await editor.locator('#del').click();
    await expect(editor).toHaveCount(0);
    await expect(page.locator('.mt-fix-hit')).toHaveCount(0);
  });

  test('it is hoverable again after a page reload restores the saved region', async ({ context, extensionId }) => {
    const { page } = await applyRegion(context, extensionId, 'こんにちは', 'Xin chào');
    await expect(page.locator('.mt-fix-hit')).toHaveCount(1, { timeout: 10_000 });

    await page.reload();
    const popup2 = await context.newPage();
    await popup2.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await page.bringToFront();
    await popup2.locator('#btn-region').click(); // injects the content script, which re-applies saved regions
    await expect(page.locator('#mt-region-select')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect(page.locator('.mt-fix-hit')).toHaveCount(1, { timeout: 15_000 });
    await page.locator('.mt-fix-hit').hover();
    await expect(page.locator('.mt-bubble-magnifier-caption')).toHaveText('こんにちは');
  });
});

// Per-region text style: font, size, colours, alignment, rotation, ... set in
// the region editor's "Text style" section, sent with that region only, saved
// with it, and shown again when the region is reopened.
test.describe('per-region text style', () => {
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

  async function setup(context: any, extensionId: string, renderResponse: unknown = { image: FAKE_TRANSLATED_IMAGE_B64 }, dragFy = 0.25) {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));
    const renders: any[] = [];
    await context.route('**/fonts', async (route) => { await route.fulfill(json({ fonts: ['Roboto', 'Comicka', 'Komika Hand'] })); });
    await context.route('**/region/ocr', async (route) => { await route.fulfill(json({ text: 'こんにちは', warning: null })); });
    await context.route('**/region/render', async (route) => { renders.push(route.request().postDataJSON()); await route.fulfill(json(renderResponse)); });
    const page = await context.newPage();
    await page.goto(SINGLE_URL);
    await startAndDrag(context, page, extensionId, 0.25, dragFy);
    const editor = page.locator('#mt-region-editor');
    await expect(editor.locator('#orig')).toHaveValue('こんにちは', { timeout: 10_000 });
    return { page, editor, renders };
  }

  test('a plain region sends no style; the section starts closed and every control starts on Auto', async ({ context, extensionId }) => {
    const { editor, renders } = await setup(context, extensionId);
    await expect(editor.locator('#style-box')).not.toHaveAttribute('open', '');
    await editor.locator('#style-box summary').click();
    await expect(editor.locator('#st-size')).toHaveValue('');
    await expect(editor.locator('#st-font')).toHaveValue('');
    await expect(editor.locator('#st-color-mode')).toHaveValue('');
    await expect(editor.locator('#st-color')).toBeHidden();
    await expect(editor.locator('#st-rot')).toHaveValue('0');
    await expect(editor.locator('#st-area')).toHaveValue('100');
    // The font list comes from the backend, after "Default".
    await expect(editor.locator('#st-font option')).toHaveText(['Default', 'Roboto', 'Comicka', 'Komika Hand']);

    await editor.locator('#trans').fill('Hello');
    await editor.locator('#apply').click();
    await expect(editor).toHaveCount(0);
    expect(renders[0].regions[0].style).toBeUndefined();
  });

  test('every setting reaches the render request for that region, is saved, and is back when the region is reopened', async ({ context, extensionId }) => {
    const { page, editor, renders } = await setup(context, extensionId);
    await editor.locator('#style-box summary').click();
    await editor.locator('#st-font').selectOption('Comicka');
    await editor.locator('#st-size').fill('28');
    await editor.locator('#st-spacing').fill('1.4');
    await editor.locator('#st-align').selectOption('right');
    await editor.locator('#st-upper').selectOption('1');
    await editor.locator('#st-color-mode').selectOption('custom');
    await editor.locator('#st-color').fill('#c8102e');
    await editor.locator('#st-outline').fill('2.5');
    await editor.locator('#st-outline-color-mode').selectOption('custom');
    await editor.locator('#st-outline-color').fill('#ffffff');
    await editor.locator('#st-bg-mode').selectOption('custom');
    await editor.locator('#st-bg').fill('#fff27a');
    await editor.locator('#st-rot').fill('-25');
    await expect(editor.locator('#st-rot-out')).toHaveText('-25°');
    await editor.locator('#st-offx').fill('10');
    await editor.locator('#st-offy').fill('-15');
    await editor.locator('#st-area').fill('70');
    await editor.locator('#st-vertical').check();
    await editor.locator('#trans').fill('Xin chao');
    await editor.locator('#apply').click();
    await expect(editor).toHaveCount(0);

    expect(renders[0].regions[0].style).toEqual({
      font: 'Comicka', font_size: 28, line_spacing: 1.4, align: 'right', uppercase: true, text_color: '#c8102e',
      outline_width: 2.5, outline_color: '#ffffff', background_color: '#fff27a', rotation: -25, vertical: true,
      offset_x: 10, offset_y: -15, text_area: 70,
    });

    // Reopen through the region's hit target: everything is back, section open.
    await page.locator('.mt-fix-hit').click();
    await expect(editor.locator('#trans')).toHaveValue('Xin chao', { timeout: 10_000 });
    await expect(editor.locator('#style-box')).toHaveAttribute('open', '');
    await expect(editor.locator('#st-font')).toHaveValue('Comicka');
    await expect(editor.locator('#st-size')).toHaveValue('28');
    await expect(editor.locator('#st-align')).toHaveValue('right');
    await expect(editor.locator('#st-upper')).toHaveValue('1');
    await expect(editor.locator('#st-color-mode')).toHaveValue('custom');
    await expect(editor.locator('#st-color')).toHaveValue('#c8102e');
    await expect(editor.locator('#st-rot')).toHaveValue('-25');
    await expect(editor.locator('#st-area')).toHaveValue('70');
    await expect(editor.locator('#st-vertical')).toBeChecked();

    // Reset returns to plain; applying then sends no style at all.
    await editor.locator('#st-reset').click();
    await expect(editor.locator('#st-size')).toHaveValue('');
    await expect(editor.locator('#st-color')).toBeHidden();
    await editor.locator('#apply').click();
    await expect(editor).toHaveCount(0);
    expect(renders.at(-1).regions[0].style).toBeUndefined();
  });

  test('a style survives a page reload with the saved region', async ({ context, extensionId }) => {
    const { page, editor, renders } = await setup(context, extensionId);
    await editor.locator('#style-box summary').click();
    await editor.locator('#st-rot').fill('30');
    await editor.locator('#st-color-mode').selectOption('custom');
    await editor.locator('#st-color').fill('#112233');
    await editor.locator('#trans').fill('Persisted');
    await editor.locator('#apply').click();
    await expect(editor).toHaveCount(0);

    await page.reload();
    const popup2 = await context.newPage();
    await popup2.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await page.bringToFront();
    await popup2.locator('#btn-region').click(); // injects the content script, which re-applies saved regions
    await expect(page.locator('#mt-region-select')).toBeVisible({ timeout: 10_000 });
    await page.keyboard.press('Escape');
    await expect.poll(() => renders.length, { timeout: 15_000 }).toBeGreaterThanOrEqual(2);
    expect(renders.at(-1).regions[0].style).toEqual(expect.objectContaining({ rotation: 30, text_color: '#112233' }));
  });

  test('a saved font that the backend no longer lists is kept in the picker, not lost', async ({ context, extensionId }) => {
    const { page, editor } = await setup(context, extensionId);
    await editor.locator('#style-box summary').click();
    await editor.locator('#st-font').selectOption('Comicka');
    await editor.locator('#trans').fill('x');
    await editor.locator('#apply').click();
    await expect(editor).toHaveCount(0);

    await context.unroute('**/fonts');
    await context.route('**/fonts', async (route) => { await route.fulfill(json({ fonts: ['Roboto'] })); });
    await page.locator('.mt-fix-hit').click();
    await expect(editor.locator('#st-font')).toHaveValue('Comicka', { timeout: 10_000 });
    await expect(editor.locator('#st-font option')).toContainText(['Default', 'Roboto', 'Comicka']);
  });

  test('when the font lacks glyphs the reader is told which characters were left out', async ({ context, extensionId }) => {
    const { page, editor } = await setup(context, extensionId, {
      image: FAKE_TRANSLATED_IMAGE_B64,
      warnings: [{ region: 0, code: 'font_missing_glyphs', font: 'Comicka', chars: 'àạẻ' }],
    });
    await editor.locator('#style-box summary').click();
    await editor.locator('#st-font').selectOption('Comicka');
    await editor.locator('#trans').fill('Xin chào');
    await editor.locator('#apply').click();
    await expect(page.locator('#mt-toast')).toContainText('Comicka');
    await expect(page.locator('#mt-toast')).toContainText('àạẻ');
  });

  test('opening the style section on a short window keeps the whole card on screen, so Apply stays reachable', async ({ context, extensionId }) => {
    // Selected near the top of the page, so the card sits BELOW it and has to
    // move up once it grows past the bottom of the window.
    const { page, editor, renders } = await setup(context, extensionId, undefined, 0.02);
    await page.setViewportSize({ width: 1000, height: 560 });
    await editor.locator('#style-box summary').click(); // the card gets much taller than the window
    await expect(editor.locator('#st-rot')).toBeVisible();

    await expect.poll(async () => {
      const host = await page.locator('#mt-region-editor').boundingBox();
      return host && host.y >= 0 && host.y + host.height <= 560;
    }).toBe(true);
    const apply = await editor.locator('#apply').boundingBox();
    // The card scrolls inside itself when it is taller than the window; Apply is
    // reached by scrolling it, never by leaving the screen.
    await editor.locator('#apply').scrollIntoViewIfNeeded();
    const applyAfter = await editor.locator('#apply').boundingBox();
    expect(applyAfter!.y).toBeGreaterThanOrEqual(0);
    expect(applyAfter!.y + applyAfter!.height).toBeLessThanOrEqual(560);
    void apply;
    await editor.locator('#trans').fill('Reachable');
    await editor.locator('#apply').click();
    await expect(editor).toHaveCount(0);
    expect(renders).toHaveLength(1);
  });

  test('style presets save locally, reapply exact attributes, survive editor reopen, and can be deleted', async ({ context, extensionId }) => {
    const { page, editor, renders } = await setup(context, extensionId);
    await editor.locator('#style-box summary').click();
    await editor.locator('#st-size').fill('32');
    await editor.locator('#st-color-mode').selectOption('custom');
    await editor.locator('#st-color').fill('#c8102e');
    await editor.locator('#st-rot').fill('15');
    await editor.locator('#st-preset-name').fill('Sound effect');
    await expect(editor.locator('#st-preset-save')).toBeEnabled();
    await editor.locator('#st-preset-save').click();
    await expect(editor.locator('#st-preset-status')).toHaveText('Preset saved');
    await expect(editor.locator('#st-presets option')).toContainText(['Choose a preset...', 'Sound effect']);

    await editor.locator('#st-size').fill('12');
    await editor.locator('#st-color-mode').selectOption('');
    await editor.locator('#st-rot').fill('0');
    await editor.locator('#st-presets').selectOption('');
    await editor.locator('#st-presets').selectOption('Sound effect');
    await expect(editor.locator('#st-size')).toHaveValue('32');
    await expect(editor.locator('#st-color')).toHaveValue('#c8102e');
    await expect(editor.locator('#st-rot')).toHaveValue('15');

    await editor.locator('#trans').fill('Pow!');
    await editor.locator('#apply').click();
    await expect(editor).toHaveCount(0);
    expect(renders.at(-1).regions[0].style).toEqual(expect.objectContaining({ font_size: 32, text_color: '#c8102e', rotation: 15 }));

    await page.locator('.mt-fix-hit').click();
    await expect(editor.locator('#st-presets option')).toContainText(['Sound effect']);
    await editor.locator('#st-presets').selectOption('Sound effect');
    await editor.locator('#st-preset-delete').click();
    await expect(editor.locator('#st-presets option')).toHaveText(['Choose a preset...']);
    await editor.locator('#cancel').click();
  });

  test('saved-region list switches regions and corner resizing persists the new box', async ({ context, extensionId }) => {
    const { page, editor, renders } = await setup(context, extensionId);
    await editor.locator('#orig').fill('First original');
    await editor.locator('#trans').fill('First translation');
    await editor.locator('#apply').click();
    await expect(editor).toHaveCount(0);

    await startAndDrag(context, page, extensionId, 0.6, 0.25);
    await editor.locator('#orig').fill('Second original');
    await editor.locator('#trans').fill('Second translation');
    await editor.locator('#apply').click();
    await expect(editor).toHaveCount(0);

    await page.locator('.mt-fix-hit').first().click();
    await editor.locator('#region-list-box summary').click();
    const savedRegions = editor.locator('#region-list-items button');
    await expect(savedRegions).toHaveCount(2);
    await savedRegions.nth(1).click();
    await expect(editor.locator('#orig')).toHaveValue('Second original');
    await expect(editor.locator('#trans')).toHaveValue('Second translation');

    const before = renders.at(-1).regions.find((item: any) => item.text === 'Second translation').box;
    await editor.locator('#resize-box').click();
    const southeast = page.locator('.mt-region-resize-handle[data-corner="se"]');
    await southeast.scrollIntoViewIfNeeded();
    const handle = await southeast.boundingBox();
    expect(handle).not.toBeNull();
    await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle!.x + handle!.width / 2 + 24, handle!.y + handle!.height / 2 + 18, { steps: 4 });
    await page.mouse.up();

    await editor.locator('#apply').click();
    await expect(editor).toHaveCount(0);
    const resized = renders.at(-1).regions.find((item: any) => item.text === 'Second translation');
    expect(resized.box.x2).toBeGreaterThan(before.x2);
    expect(resized.box.y2).toBeGreaterThan(before.y2);
  });
});
