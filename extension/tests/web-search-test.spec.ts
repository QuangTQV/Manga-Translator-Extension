import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

test.describe('popup — local SearXNG test', () => {
  test('shows result count and returned snippets without an LLM request', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));
    await context.route('**/web-search/test', async (route) => {
      expect(route.request().postDataJSON()).toEqual({ query: 'Frieren' });
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          query: 'Frieren',
          result_count: 1,
          results: '1. Official site\nURL: https://example.org/frieren\nSnippet: Official character guide',
        }),
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.locator('.tab-btn[data-tab="config"]').click();
    await popup.locator('#f-web-search-test-query').fill('Frieren');
    await popup.locator('#btn-test-web-search').click();

    await expect(popup.locator('#web-search-test-status')).toContainText('1 result');
    await expect(popup.locator('#web-search-test-results')).toContainText('Official site');
    await expect(popup.locator('#web-search-test-results')).toContainText('https://example.org/frieren');
    await expect(popup.locator('#web-search-test-results')).toContainText('Official character guide');
  });

  test('shows the actual connection/configuration error in the popup', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));
    await context.route('**/web-search/test', async (route) => {
      await route.fulfill({
        status: 502,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'SearXNG search failed: [Errno 61] Connection refused' }),
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.locator('.tab-btn[data-tab="config"]').click();
    await popup.locator('#f-web-search-test-query').fill('Frieren');
    await popup.locator('#btn-test-web-search').click();

    await expect(popup.locator('#web-search-test-status')).toHaveText('✗');
    await expect(popup.locator('#web-search-test-results')).toContainText('Connection refused');
  });
});
