import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, FAKE_TRANSLATED_IMAGE_B64, test } from './fixtures';
import { clickScannerAction } from './shadow-dom';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_SITE_URL = `file://${path.resolve(__dirname, 'fixtures/test-site/index.html')}`;

test('reordering a provider group above the default changes which one is sent as primary, with weights intact', async ({ context, extensionId }) => {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

  // Azure OpenAI listed FIRST, Google second — the exact "move Azure above
  // Google" scenario this rotation UI exists for. Each group carries a
  // distinct-weight key so the wire request's weight fields are checked too.
  await seedSettings(
    worker,
    baseSeed({
      config: {
        providerGroups: [
          {
            provider: 'Azure OpenAI', modelName: 'gpt-5-nano', enabled: true,
            baseUrl: 'https://res.openai.azure.com/openai/deployments/gpt-5-nano/chat/completions?api-version=2024-10-01',
            apiKeys: [{ key: 'azure-key-1', enabled: true, weight: 4 }],
          },
          {
            provider: 'Google', enabled: true,
            apiKeys: [{ key: 'google-key-1', enabled: true, weight: 2 }],
          },
        ],
      },
    }),
    firstKeyMatches('azure-key-1'),
  );

  let capturedBody: any = null;
  await context.route('**/translate', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    capturedBody = route.request().postDataJSON();
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        translated_image: FAKE_TRANSLATED_IMAGE_B64,
        bubbles: [],
        processing_time_seconds: 0.1,
        source_language: 'Japanese',
        target_language: 'English',
        provider: capturedBody?.provider,
        ocr_texts: [],
        memory_note: null,
      }),
    });
  });

  const mangaPage = await context.newPage();
  await mangaPage.goto(TEST_SITE_URL);

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

  // Deliberately don't bring the popup to the front after this: the
  // extension resolves "the active tab" via chrome.tabs.query({active:
  // true}), which must still resolve to mangaPage for scanning to work.
  await mangaPage.bringToFront();
  await popup.locator('#btn-scan').click();
  await mangaPage.waitForTimeout(1500);

  const cdp = await context.newCDPSession(mangaPage);
  await cdp.send('DOM.enable');
  await clickScannerAction(mangaPage, cdp, 'select-all');
  await mangaPage.waitForTimeout(150);
  await clickScannerAction(mangaPage, cdp, 'translate');
  await mangaPage.waitForTimeout(2000);

  expect(capturedBody).toBeTruthy();
  expect(capturedBody.provider).toBe('Azure OpenAI');
  expect(capturedBody.api_key).toBe('azure-key-1');
  expect(capturedBody.api_key_weight).toBe(4);
  expect(capturedBody.base_url).toContain('azure');
  expect(capturedBody.model_name).toBe('gpt-5-nano');

  const fallback = capturedBody.fallback_providers?.[0];
  expect(fallback?.provider).toBe('Google');
  expect(fallback?.api_keys).toEqual(['google-key-1']);
  expect(fallback?.api_key_weights).toEqual([2]);
});
