import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from './fixtures';
import { boxCenter, clickScannerAction, getAttr, hasAttr, hasClass, pierceQuery } from './shadow-dom';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site/index.html')}`;

test('scanner finds pages and the zoom lightbox opens/closes', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  const mangaPage = await context.newPage();
  await mangaPage.goto(TEST_SITE_URL);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  await mangaPage.bringToFront();
  await popup.locator('#btn-scan').click();
  await mangaPage.waitForTimeout(1500);

  const cdp = await context.newCDPSession(mangaPage);
  await cdp.send('DOM.enable');

  const cards = await pierceQuery(cdp, (n) => hasClass(n, 'mts-card'));
  expect(cards.length).toBeGreaterThanOrEqual(4); // the 4 synthetic test-site pages

  // Open the lightbox via the first card's zoom button.
  const zoomButtons = await pierceQuery(cdp, (n) => hasClass(n, 'mts-zoom-btn') && hasAttr(n, 'data-zoom-index', '0'));
  expect(zoomButtons.length).toBe(1);
  const { x, y } = await boxCenter(cdp, zoomButtons[0].nodeId);
  await mangaPage.mouse.click(x, y);
  await mangaPage.waitForTimeout(200);

  const lightboxAfterOpen = (await pierceQuery(cdp, (n) => hasAttr(n, 'id', 'mts-lightbox')))[0];
  expect(getAttr(lightboxAfterOpen, 'style')).not.toMatch(/display:\s*none/);

  await clickScannerAction(mangaPage, cdp, 'lightbox-close');
  await mangaPage.waitForTimeout(200);

  const lightboxAfterClose = (await pierceQuery(cdp, (n) => hasAttr(n, 'id', 'mts-lightbox')))[0];
  expect(getAttr(lightboxAfterClose, 'style')).toMatch(/display:\s*none/);
});
