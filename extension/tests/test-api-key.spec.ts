import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

// The popup's "Test API Key" feature: a per-key Test button pings the
// backend's /test-key endpoint with exactly that (provider, model,
// base URL, key) combo, and a per-provider "Test all keys" button runs it
// for every enabled key in that group.
test.describe('popup — LLM Config tab Test API Key', () => {
  test('a per-key Test button reports success and failure against the right (provider, model, key)', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

    await seedSettings(
      worker,
      baseSeed({
        config: {
          providerGroups: [{
            provider: 'Google', modelName: 'gemini-3.1-flash-lite-preview', enabled: true,
            apiKeys: [{ key: 'good-key', enabled: true }, { key: 'bad-key', enabled: true }],
          }],
        },
      }),
      firstKeyMatches('good-key'),
    );

    const capturedBodies: any[] = [];
    await context.route('**/test-key', async (route) => {
      const body = route.request().postDataJSON();
      capturedBodies.push(body);
      const ok = body.api_key === 'good-key';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify(ok ? { ok: true, latency_ms: 123 } : { ok: false, error: 'Status 401: invalid key' }),
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'LLM Config' }).click();

    const keyRows = popup.locator('#provider-groups-list .backup-key-row');
    await expect(keyRows).toHaveCount(2);

    await keyRows.nth(0).locator('.btn-test-key').click();
    await expect(keyRows.nth(0).locator('.bk-test-status')).toHaveText('✓', { timeout: 5_000 });
    await expect(keyRows.nth(0).locator('.bk-test-status')).toHaveClass(/ok/);

    await keyRows.nth(1).locator('.btn-test-key').click();
    await expect(keyRows.nth(1).locator('.bk-test-status')).toHaveText('✗', { timeout: 5_000 });
    await expect(keyRows.nth(1).locator('.bk-test-status')).toHaveClass(/fail/);
    await expect(keyRows.nth(1).locator('.bk-test-status')).toHaveAttribute('title', /401/);

    expect(capturedBodies).toHaveLength(2);
    expect(capturedBodies[0].provider).toBe('Google');
    expect(capturedBodies[0].model_name).toBe('gemini-3.1-flash-lite-preview');
    expect(capturedBodies[0].api_key).toBe('good-key');
    expect(capturedBodies[1].api_key).toBe('bad-key');
  });

  test('"Test all keys" tests every enabled key in the group, skipping a disabled one', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

    await seedSettings(
      worker,
      baseSeed({
        config: {
          providerGroups: [{
            provider: 'Google', enabled: true,
            apiKeys: [
              { key: 'key-1', enabled: true },
              { key: 'key-2', enabled: true },
              { key: 'key-3', enabled: false },
            ],
          }],
        },
      }),
      firstKeyMatches('key-1'),
    );

    const testedKeys: string[] = [];
    await context.route('**/test-key', async (route) => {
      const body = route.request().postDataJSON();
      testedKeys.push(body.api_key);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: true, latency_ms: 50 }),
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'LLM Config' }).click();

    await popup.locator('#provider-groups-list .btn-test-all').click();

    const keyRows = popup.locator('#provider-groups-list .backup-key-row');
    await expect(keyRows.nth(0).locator('.bk-test-status')).toHaveClass(/ok/, { timeout: 5_000 });
    await expect(keyRows.nth(1).locator('.bk-test-status')).toHaveClass(/ok/, { timeout: 5_000 });

    // The disabled key's status never leaves its initial empty state.
    await expect(keyRows.nth(2).locator('.bk-test-status')).toHaveText('');

    expect(testedKeys.sort()).toEqual(['key-1', 'key-2']);
  });

  test('a failed test shows a "view error" button that expands the full error text', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

    await seedSettings(
      worker,
      baseSeed({
        config: {
          providerGroups: [{
            provider: 'OpenAI-Compatible', modelName: 'glm-5.3-flash', baseUrl: 'https://api.b.ai/v1', enabled: true,
            apiKeys: [{ key: 'some-key', enabled: true }],
          }],
        },
      }),
      firstKeyMatches('some-key'),
    );

    const longError = 'OpenAI-Compatible API HTTP Error: Status 400: {"error":{"message":"该模型始终思考，不支持关闭思考；请使用 low、high 或 max。","type":"upstream_error","param":"","code":"1210"}} (Check payload)';
    await context.route('**/test-key', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ ok: false, error: longError }),
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'LLM Config' }).click();

    const keyRow = popup.locator('#provider-groups-list .backup-key-row').first();
    const errorBtn = keyRow.locator('.btn-view-error');
    const errorBox = keyRow.locator('.bk-error-detail');

    await expect(errorBtn).toBeHidden();
    await keyRow.locator('.btn-test-key').click();
    await expect(keyRow.locator('.bk-test-status')).toHaveText('✗', { timeout: 5_000 });

    await expect(errorBtn).toBeVisible();
    await expect(errorBox).toBeHidden();
    await errorBtn.click();
    await expect(errorBox).toBeVisible();
    await expect(errorBox).toHaveText(longError);

    await errorBtn.click();
    await expect(errorBox).toBeHidden();
  });

  test('the test request uses the row\'s own reasoning effort override, falling back to the general setting', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });

    await seedSettings(
      worker,
      baseSeed({
        config: {
          reasoningEffort: 'high',
          providerGroups: [
            {
              provider: 'OpenAI-Compatible', modelName: 'glm-5.3-flash', baseUrl: 'https://api.b.ai/v1', enabled: true, reasoningEffort: 'low',
              apiKeys: [{ key: 'key-with-override', enabled: true }],
            },
            {
              provider: 'Google', enabled: true,
              apiKeys: [{ key: 'key-without-override', enabled: true }],
            },
          ],
        },
      }),
      firstKeyMatches('key-with-override'),
    );

    const capturedBodies: any[] = [];
    await context.route('**/test-key', async (route) => {
      capturedBodies.push(route.request().postDataJSON());
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, latency_ms: 10 }) });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'LLM Config' }).click();

    const keyRows = popup.locator('#provider-groups-list .backup-key-row');
    await keyRows.nth(0).locator('.btn-test-key').click();
    await expect(keyRows.nth(0).locator('.bk-test-status')).toHaveClass(/ok/, { timeout: 5_000 });
    await keyRows.nth(1).locator('.btn-test-key').click();
    await expect(keyRows.nth(1).locator('.bk-test-status')).toHaveClass(/ok/, { timeout: 5_000 });

    expect(capturedBodies).toHaveLength(2);
    // Own row override wins over the general setting.
    expect(capturedBodies.find((b) => b.api_key === 'key-with-override').reasoning_effort).toBe('low');
    // No row override -> falls back to the general Reasoning Effort setting.
    expect(capturedBodies.find((b) => b.api_key === 'key-without-override').reasoning_effort).toBe('high');
  });
});
