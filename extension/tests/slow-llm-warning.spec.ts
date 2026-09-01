import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Worker } from '@playwright/test';
import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SINGLE_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site-single/index.html')}`;

const FAKE_TRANSLATED_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';

// 7 prior "slow" samples for Google — one more slow translation puts it at
// 8-of-8, past the 5-of-8 warn rule.
function seedPerfHistory(worker: Worker, extra: Record<string, unknown> = {}): Promise<void> {
  return worker.evaluate(async (payload) => {
    const now = Date.now();
    await chrome.storage.local.set({
      mt_llm_perf: {
        samples: Array.from({ length: 7 }, (_, i) => ({
          provider: 'Google', sec: 12, slow: true, ts: now - (i + 1) * 1000,
        })),
        warnedAt: {},
        ...(payload as Record<string, unknown>),
      },
    });
  }, extra);
}

function routeSlowTranslate(context: import('@playwright/test').BrowserContext): Promise<void> {
  return context.route('**/translate', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        translated_image: FAKE_TRANSLATED_PNG_B64,
        bubbles: [],
        processing_time_seconds: 6,
        llm_time_seconds: 5, // > 1s threshold => counts as slow
        source_language: 'Japanese',
        target_language: 'English',
        provider: 'Google',
        ocr_texts: [],
      }),
    });
  });
}

test('a provider that stays slow past the threshold pops the in-page warning', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(
    worker,
    baseSeed({ config: { slowLlmWarningEnabled: true, slowLlmThresholdSeconds: 1 } }),
    firstKeyMatches('seed-key'),
  );
  await seedPerfHistory(worker);
  await routeSlowTranslate(context);

  const mangaPage = await context.newPage();
  await mangaPage.goto(SINGLE_SITE_URL);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();

  await expect(mangaPage.locator('.mt-badge').first()).toBeVisible({ timeout: 15_000 });

  const warning = mangaPage.locator('#mt-slow-llm-warning');
  await expect(warning).toBeVisible({ timeout: 10_000 });
  await expect(warning).toContainText('Google');
  await expect(warning.locator('button')).toHaveCount(2); // Dismiss + Open LLM Config
});

test('the warning is suppressed when the toggle is off', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(
    worker,
    baseSeed({ config: { slowLlmWarningEnabled: false, slowLlmThresholdSeconds: 1 } }),
    firstKeyMatches('seed-key'),
  );
  await seedPerfHistory(worker);
  await routeSlowTranslate(context);

  const mangaPage = await context.newPage();
  await mangaPage.goto(SINGLE_SITE_URL);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();

  await expect(mangaPage.locator('.mt-badge').first()).toBeVisible({ timeout: 15_000 });
  await mangaPage.waitForTimeout(1500);
  await expect(mangaPage.locator('#mt-slow-llm-warning')).toHaveCount(0);
});

test('the warning is snoozed for a provider warned about recently', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(
    worker,
    baseSeed({ config: { slowLlmWarningEnabled: true, slowLlmThresholdSeconds: 1 } }),
    firstKeyMatches('seed-key'),
  );
  await seedPerfHistory(worker, { warnedAt: { Google: Date.now() } });
  await routeSlowTranslate(context);

  const mangaPage = await context.newPage();
  await mangaPage.goto(SINGLE_SITE_URL);
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await mangaPage.bringToFront();
  await popup.locator('#btn-auto').click();

  await expect(mangaPage.locator('.mt-badge').first()).toBeVisible({ timeout: 15_000 });
  await mangaPage.waitForTimeout(1500);
  await expect(mangaPage.locator('#mt-slow-llm-warning')).toHaveCount(0);
});
