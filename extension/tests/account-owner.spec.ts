import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

// The Account tab's "Owner" section — only shown when /account/me (or
// /account/register) reports is_admin: true (backend/auth.py:require_admin,
// core/server_config.py). Lets the deployment operator configure the
// shared LLM provider/model/key from the popup instead of setting
// GOOGLE_API_KEY/etc. env vars by hand.
test.describe('popup — Account tab Owner section', () => {
  test('shown for an admin account, hidden for a regular one', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    await context.route('**/account/register', async (route) => {
      const body = route.request().postDataJSON();
      const isAdmin = body.email === 'owner@example.com';
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          email: body.email, token: 'tok-' + body.email, plan: 'free',
          usage_count: 0, quota: 50, period_start: 0, is_admin: isAdmin,
        }),
      });
    });
    await context.route('**/admin/llm-config', async (route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ provider: 'Google', model_name: null, api_key_set: false, base_url: null }),
      });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Account' }).click();

    // Regular (non-admin) account first.
    await popup.locator('#f-account-email').fill('regular@example.com');
    await popup.locator('#btn-account-register').click();
    await expect(popup.locator('#account-logged-in')).toBeVisible({ timeout: 5_000 });
    await expect(popup.locator('#account-owner-section')).toBeHidden();

    await popup.locator('#btn-account-logout').click();
    await expect(popup.locator('#account-logged-out')).toBeVisible();

    // Admin account.
    await popup.locator('#f-account-email').fill('owner@example.com');
    await popup.locator('#btn-account-register').click();
    await expect(popup.locator('#account-logged-in')).toBeVisible({ timeout: 5_000 });
    await expect(popup.locator('#account-owner-section')).toBeVisible();
  });

  test('loads the existing shared config, and saving without retyping the key preserves it server-side', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    await context.route('**/account/register', async (route) => {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          email: 'owner@example.com', token: 'tok-owner', plan: 'free',
          usage_count: 0, quota: 50, period_start: 0, is_admin: true,
        }),
      });
    });

    let currentConfig = { provider: 'Google', model_name: 'gemini-3.1-flash-lite-preview', api_key_set: true, base_url: null as string | null };
    const capturedPosts: any[] = [];
    await context.route('**/admin/llm-config', async (route) => {
      if (route.request().method() === 'POST') {
        const body = route.request().postDataJSON();
        capturedPosts.push(body);
        // Mirrors the real backend: empty/omitted api_key doesn't clear api_key_set.
        currentConfig = {
          provider: body.provider,
          model_name: body.model_name ?? null,
          api_key_set: body.api_key ? true : currentConfig.api_key_set,
          base_url: body.base_url ?? null,
        };
      }
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(currentConfig) });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.getByRole('button', { name: 'Account' }).click();
    await popup.locator('#f-account-email').fill('owner@example.com');
    await popup.locator('#btn-account-register').click();
    await expect(popup.locator('#account-owner-section')).toBeVisible({ timeout: 5_000 });

    // Pre-filled from the existing config, key field stays blank.
    await expect(popup.locator('#f-owner-provider')).toHaveValue('Google');
    await expect(popup.locator('#f-owner-model')).toHaveValue('gemini-3.1-flash-lite-preview');
    await expect(popup.locator('#f-owner-api-key')).toHaveValue('');

    // Change only the model, leave the key field blank.
    await popup.locator('#f-owner-model').fill('gemini-3.1-pro');
    await popup.locator('#btn-owner-save').click();
    await expect(popup.locator('#owner-key-status')).toHaveText(/configured/i, { timeout: 5_000 });

    expect(capturedPosts).toHaveLength(1);
    expect(capturedPosts[0].api_key).toBeUndefined();
    expect(capturedPosts[0].model_name).toBe('gemini-3.1-pro');
  });
});
