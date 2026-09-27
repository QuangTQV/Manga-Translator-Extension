import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';
import { boxCenter, clickScannerAction, getAttr, hasAttr, hasClass, pierceQuery } from './shadow-dom';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SINGLE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;

// Scanner QA view is based on actual translation response metadata, not OCR
// guesses reconstructed from the flattened output image.
test('proofreads returned bubble text, flags suspicious rows, and opens the selected bubble for editing', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  await context.route('**/translate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        translated_image: FAKE_TRANSLATED_IMAGE_B64,
        bubbles: [
          { bbox: [40, 30, 300, 180], confidence: 0.9, original_text: 'げんき？', translated_text: 'You okay?' },
          { bbox: [320, 300, 500, 430], confidence: 0.8, original_text: 'draft', translated_text: 'draft' },
          { bbox: [40, 500, 260, 650], confidence: 0.7, original_text: 'empty', translated_text: '' },
        ],
        processing_time_seconds: 0.1,
        source_language: 'Japanese',
        target_language: 'English',
        provider: 'Google',
        ocr_texts: [],
      }),
    });
  });
  await context.route('**/region/render', async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ image: FAKE_TRANSLATED_IMAGE_B64 }) });
  });

  const page = await context.newPage();
  await page.goto(SINGLE_URL);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await page.bringToFront();
  await popup.locator('#btn-scan').click();
  await page.waitForTimeout(1500);

  const cdp = await context.newCDPSession(page);
  await cdp.send('DOM.enable');
  await clickScannerAction(page, cdp, 'select-all');
  await clickScannerAction(page, cdp, 'translate');
  await expect(page.locator('#mt-toast')).toBeVisible({ timeout: 10_000 });
  await clickScannerAction(page, cdp, 'proofread');

  const rows = await pierceQuery(cdp, (node) => hasClass(node, 'mts-review-row'));
  expect(rows).toHaveLength(3);
  expect(rows.filter((row) => hasClass(row, 'flagged'))).toHaveLength(2);

  const search = (await pierceQuery(cdp, (node) => hasAttr(node, 'id', 'mts-review-search')))[0];
  const searchBox = await boxCenter(cdp, search.nodeId);
  await page.mouse.click(searchBox.x, searchBox.y);
  await page.keyboard.type('draft');
  const filteredRows = await pierceQuery(cdp, (node) => hasClass(node, 'mts-review-row'));
  expect(filteredRows.filter((row) => hasAttr(row, 'hidden'))).toHaveLength(2);

  const editDraft = (await pierceQuery(cdp, (node) => hasAttr(node, 'data-action', 'proofread-edit') && hasAttr(node, 'data-bubble-index', '1')))[0];
  const editBox = await boxCenter(cdp, editDraft.nodeId);
  await page.mouse.click(editBox.x, editBox.y);
  const editor = page.locator('#mt-region-editor');
  await expect(editor.locator('#orig')).toHaveValue('draft', { timeout: 5_000 });
  await expect(editor.locator('#trans')).toHaveValue('draft');
  await editor.locator('#trans').fill('Draft text');
  await editor.locator('#apply').click();
  await expect(editor).toHaveCount(0);
  const reviewRows = await pierceQuery(cdp, (node) => hasClass(node, 'mts-review-row'));
  expect(reviewRows.map((row) => getAttr(row, 'data-search'))).toContain('draft\ndraft text');
});
