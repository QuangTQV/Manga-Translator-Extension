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

// The scanner panel itself used to open/close as an instant cut — the
// single most-triggered show/hide in the extension (every batch-translate
// session) left unanimated while the lightbox/hover-preview right next to
// it already fade+scale. `#mt-scanner-root` (the panel's host element) is
// regular light DOM — only its content is a closed shadow root — so a
// normal Playwright locator can see it without piercing.
test('the scanner panel fades out instead of vanishing on the same tick when closed', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  const mangaPage = await context.newPage();
  await mangaPage.goto(TEST_SITE_URL);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  await mangaPage.bringToFront();
  await popup.locator('#btn-scan').click();

  const root = mangaPage.locator('#mt-scanner-root');
  await expect(root).toHaveCount(1, { timeout: 15_000 });

  const cdp = await context.newCDPSession(mangaPage);
  await cdp.send('DOM.enable');
  await clickScannerAction(mangaPage, cdp, 'close');

  // Still attached right after the click — the fade-out hasn't finished yet.
  await expect(root).toHaveCount(1);
  // ...but actually gone shortly after.
  await expect(root).toHaveCount(0, { timeout: 1_000 });
});
