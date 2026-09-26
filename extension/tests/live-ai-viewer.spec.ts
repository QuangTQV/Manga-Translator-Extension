import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

// The Live AI log viewer: an extension page (live-ai/index.html) that shows
// the backend's GET /admin/live-ai-log — every LLM call with prompt,
// response and timing. The backend is mocked here; backend/tests/
// test_live_ai_log.py covers the endpoint itself.

const NOW = Math.floor(Date.now() / 1000);

function entry(i: number, overrides: Record<string, unknown> = {}) {
  return {
    timestamp: NOW - 100 + i,
    provider: 'Google',
    model: 'gemini-test',
    call_type: 'translate',
    system_prompt: `system-${i}`,
    prompt_text: `prompt-${i}\nsecond line`,
    images_count: 0,
    images_kb: 0,
    response_text: `response-${i}`,
    error: null,
    latency_ms: 1200,
    ...overrides,
  };
}

async function openViewer(context: any, extensionId: string, seed: Record<string, unknown> = {}) {
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(seed), firstKeyMatches('seed-key'));
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/live-ai/index.html`);
  return page;
}

test.describe('Live AI log viewer', () => {
  test('lists calls newest first with type, model, latency and an error highlight, and expands a call to its full text', async ({ context, extensionId }) => {
    await context.route('**/admin/live-ai-log*', async (route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          entries: [
            entry(3, { call_type: 'support_chat', response_text: null, error: 'HTTP 429 rate limited', latency_ms: 300, model: null }),
            entry(2, { images_count: 3, images_kb: 210.4, provider: 'Azure OpenAI', model: 'gpt-x' }),
            entry(1, { response_text: '<img src=x onerror="window.__pwned=1"> **hello**' }),
          ],
        }),
      });
    });

    const page = await openViewer(context, extensionId);
    const cards = page.locator('.card');
    await expect(cards).toHaveCount(3);
    // Order and content of the collapsed rows.
    await expect(cards.nth(0).locator('.badge')).toHaveText('support_chat');
    await expect(cards.nth(0)).toHaveClass(/error/);
    await expect(cards.nth(0).locator('.preview')).toContainText('HTTP 429 rate limited');
    await expect(cards.nth(0).locator('.lat')).toHaveText('300 ms');
    await expect(cards.nth(1).locator('.who')).toHaveText('Azure OpenAI · gpt-x');
    await expect(cards.nth(1).locator('.imgs')).toContainText('3 images');
    await expect(cards.nth(1).locator('.lat')).toHaveText('1.2 s');
    await expect(page.locator('#summary')).toContainText('3 of 3 calls');
    await expect(page.locator('#summary')).toContainText('1 errors');
    await expect(page.locator('#status')).toHaveText('Live');

    // Nothing of the body is built until a card is opened.
    await expect(cards.nth(2).locator('pre')).toHaveCount(0);
    await cards.nth(2).locator('.card-head').click();
    await expect(cards.nth(2).locator('pre')).toHaveCount(3);
    await expect(cards.nth(2).locator('pre').nth(0)).toHaveText('system-1');
    await expect(cards.nth(2).locator('pre').nth(1)).toHaveText('prompt-1\nsecond line');
    // Model output is shown as text — never interpreted as markup.
    await expect(cards.nth(2).locator('pre').nth(2)).toHaveText('<img src=x onerror="window.__pwned=1"> **hello**');
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    await expect(cards.nth(2).locator('img')).toHaveCount(0);

    // Collapsing hides the body again.
    await cards.nth(2).locator('.card-head').click();
    await expect(cards.nth(2).locator('.card-body')).toBeHidden();
  });

  test('filters by type, errors only and search text, and the summary follows', async ({ context, extensionId }) => {
    await context.route('**/admin/live-ai-log*', async (route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          entries: [
            entry(4, { call_type: 'translate_region', response_text: 'needle in here' }),
            entry(3, { call_type: 'translate', error: 'boom', response_text: null }),
            entry(2, { call_type: 'translate' }),
            entry(1, { call_type: 'test_key', prompt_text: 'unique-token-xyz' }),
          ],
        }),
      });
    });
    const page = await openViewer(context, extensionId);
    const visible = page.locator('.card:not([hidden])');
    await expect(visible).toHaveCount(4);

    await page.locator('#type-filter').selectOption('translate');
    await expect(visible).toHaveCount(2);
    await expect(page.locator('#summary')).toContainText('2 of 4 calls');

    await page.locator('#status-filter').selectOption('errors');
    await expect(visible).toHaveCount(1);
    await expect(page.locator('#summary')).toContainText('1 errors');

    await page.locator('#type-filter').selectOption('all');
    await page.locator('#status-filter').selectOption('all');
    await page.locator('#search').fill('NEEDLE');
    await expect(visible).toHaveCount(1);
    await expect(visible.locator('.badge')).toHaveText('translate_region');

    // Search also reaches text of calls that are collapsed (never opened).
    await page.locator('#search').fill('unique-token-xyz');
    await expect(visible).toHaveCount(1);
    await expect(visible.locator('.badge')).toHaveText('test_key');

    await page.locator('#search').fill('nothing matches this');
    await expect(visible).toHaveCount(0);
    await expect(page.locator('#empty')).toContainText('No call matches');
  });

  test('auto-refresh asks only for entries newer than the newest one seen, and puts them on top', async ({ context, extensionId }) => {
    const requests: URL[] = [];
    let second = false;
    await context.route('**/admin/live-ai-log*', async (route) => {
      const url = new URL(route.request().url());
      requests.push(url);
      const entries = url.searchParams.has('since')
        ? (second ? [entry(9, { prompt_text: 'brand new call' })] : [])
        : [entry(2), entry(1)];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries }) });
    });
    const page = await openViewer(context, extensionId);
    await expect(page.locator('.card')).toHaveCount(2);
    expect(requests[0].searchParams.get('limit')).toBe('200');
    expect(requests[0].searchParams.has('since')).toBe(false);

    second = true;
    await expect(page.locator('.card')).toHaveCount(3, { timeout: 8_000 });
    await expect(page.locator('.card').first().locator('.preview')).toContainText('response-9');
    await expect(page.locator('.card').first()).toHaveClass(/fresh/);
    const polled = requests.filter((u) => u.searchParams.has('since'));
    expect(polled.length).toBeGreaterThan(0);
    expect(polled[0].searchParams.get('since')).toBe(String(NOW - 100 + 2)); // newest timestamp from the first load

    // Turning auto-refresh off pauses polling and the status pill says so.
    await page.locator('#auto').uncheck();
    await expect(page.locator('#status')).toHaveText('Paused');
    const before = requests.length;
    await page.waitForTimeout(4_500);
    expect(requests.length).toBe(before);
  });

  test('a backend that ignores `since` (older version) does not make entries appear twice', async ({ context, extensionId }) => {
    let polls = 0;
    await context.route('**/admin/live-ai-log*', async (route) => {
      polls += 1;
      // Always the full list, exactly what a backend without `since` does.
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [entry(2), entry(1)] }) });
    });
    const page = await openViewer(context, extensionId);
    await expect(page.locator('.card')).toHaveCount(2);
    await expect.poll(() => polls, { timeout: 8_000 }).toBeGreaterThanOrEqual(3);
    await expect(page.locator('.card')).toHaveCount(2);
    await expect(page.locator('#summary')).toContainText('2 of 2 calls');
  });

  test('Clear view empties the list but keeps polling from where it was', async ({ context, extensionId }) => {
    const sinces: (string | null)[] = [];
    await context.route('**/admin/live-ai-log*', async (route) => {
      const url = new URL(route.request().url());
      sinces.push(url.searchParams.get('since'));
      const entries = url.searchParams.has('since') ? [] : [entry(2), entry(1)];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries }) });
    });
    const page = await openViewer(context, extensionId);
    await expect(page.locator('.card')).toHaveCount(2);
    await page.locator('#btn-clear').click();
    await expect(page.locator('.card')).toHaveCount(0);
    await page.locator('#btn-refresh').click();
    await expect.poll(() => sinces.filter((s) => s !== null).length).toBeGreaterThan(0);
    expect(sinces.filter((s) => s !== null)[0]).toBe(String(NOW - 100 + 2));
    await expect(page.locator('.card')).toHaveCount(0);
  });

  for (const [status, detail, expected] of [
    [404, 'Live AI logging is disabled (set MT_LIVE_AI_LOG_ENABLED=true)', 'MT_LIVE_AI_LOG_ENABLED=true in backend/.env'],
    [401, 'Missing or invalid Authorization header', 'Sign in on the popup'],
    [403, 'This account is not the configured admin', 'not the configured admin'],
    [500, 'something broke', 'something broke'],
  ] as const) {
    test(`a ${status} from the backend is explained instead of showing an empty list`, async ({ context, extensionId }) => {
      await context.route('**/admin/live-ai-log*', async (route) => {
        await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify({ detail }) });
      });
      const page = await openViewer(context, extensionId);
      await expect(page.locator('#banner')).toBeVisible();
      await expect(page.locator('#banner')).toContainText(expected);
      await expect(page.locator('#status')).toHaveText('Error');
      await expect(page.locator('#empty')).toBeHidden();
    });
  }

  test('it sends the account token, uses the UI language and the popup button opens it in a new tab', async ({ context, extensionId }) => {
    let auth: string | undefined;
    await context.route('**/admin/live-ai-log*', async (route) => {
      auth = route.request().headers()['authorization'];
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ entries: [] }) });
    });
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed({ accountToken: 'admin-token-123', accountEmail: 'admin@example.com', uiLanguage: 'vi' }), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    // The popup renders in Vietnamese here, so pick the tab by its data attribute.
    await popup.locator('.tab-btn[data-tab="config"]').click();
    const opened = context.waitForEvent('page');
    await popup.locator('#btn-open-live-ai').click();
    const viewer = await opened;
    await viewer.waitForLoadState();
    expect(viewer.url()).toBe(`chrome-extension://${extensionId}/live-ai/index.html`);

    await expect(viewer.locator('h1')).toHaveText('Nhật ký Live AI');
    await expect(viewer.locator('#empty')).toContainText('Chưa có lệnh gọi nào');
    await expect.poll(() => auth).toBe('Bearer admin-token-123');
  });
});
