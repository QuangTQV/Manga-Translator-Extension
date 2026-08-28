import { test as base, chromium, type BrowserContext } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION_PATH = path.resolve(__dirname, '../dist');

if (!fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))) {
  throw new Error(
    `extension/dist has no built extension (missing manifest.json at ${EXTENSION_PATH}). ` +
      'Run `npm run build` before `npm test` — the test script does this for you.',
  );
}

/** A Chrome extension can't be loaded into Playwright's default shared
 * browser — it needs its own persistent context launched with
 * --load-extension, and the extension's id (needed to open its popup via
 * chrome-extension://<id>/...) is only known after its service worker
 * registers. Every spec file should import { test, expect } from this
 * file instead of directly from '@playwright/test'. */
export const test = base.extend<{
  context: BrowserContext;
  extensionId: string;
}>({
  // eslint-disable-next-line no-empty-pattern
  context: async ({}, use) => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-ext-test-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      // MV3 service workers and extension popups don't reliably initialize
      // under Chromium's newer "headless: 'new'" mode in every environment;
      // headed is what this project's own manual test scripts used
      // throughout development and is known to work. On a CI box without a
      // display, wrap the test command in `xvfb-run`.
      headless: false,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
        '--no-first-run',
      ],
    });
    await use(context);
    await context.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  },

  extensionId: async ({ context }, use) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await use(worker.url().split('/')[2]);
  },
});

export const expect = test.expect;

/** A 1x1 transparent PNG, reused wherever a spec needs to mock a
 * `/translate` response body without depending on real backend output. */
export const FAKE_TRANSLATED_IMAGE_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
