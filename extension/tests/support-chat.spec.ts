import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

// The "?" help chat (popup header) — a one-off LLM helper answering "how do
// I use this" questions, grounded in the project's own docs
// (backend/endpoints/translate.py:support_chat), using the user's own
// configured provider/key. History is persisted to chrome.storage.local so
// a conversation survives the popup being destroyed on blur (see
// popup/index.ts:initSupportChat).
test.describe('popup — Help chat', () => {
  test('asking a question sends the conversation and renders the reply, and the conversation persists across reopening the popup', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    let capturedBody: any = null;
    await context.route('**/support-chat', async (route) => {
      capturedBody = route.request().postDataJSON();
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ reply: 'Go to the LLM Config tab and paste your key.' }),
      });
    });

    const popup1 = await context.newPage();
    await popup1.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup1.locator('#btn-help-chat').click();
    await expect(popup1.locator('#support-chat-overlay')).toHaveClass(/open/);
    await expect(popup1.locator('.support-chat-empty')).toBeVisible();

    await popup1.locator('#support-chat-input').fill('How do I add an API key?');
    await popup1.locator('#btn-send-support-chat').click();

    await expect(popup1.locator('.support-chat-msg.user')).toHaveText('How do I add an API key?');
    await expect(popup1.locator('.support-chat-msg.assistant').last()).toHaveText('Go to the LLM Config tab and paste your key.');
    await expect(popup1.locator('#support-chat-input')).toHaveValue('');

    expect(capturedBody).toBeTruthy();
    expect(capturedBody.messages).toEqual([{ role: 'user', content: 'How do I add an API key?' }]);
    expect(capturedBody.provider).toBe('Google');
    expect(capturedBody.api_key).toBe('seed-key');

    // A Chrome action popup is destroyed, not hidden, the moment it loses
    // focus — closing and reopening exercises real teardown, not just
    // re-rendering an already-open page.
    await popup1.close();
    const popup2 = await context.newPage();
    await popup2.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup2.locator('#btn-help-chat').click();
    await expect(popup2.locator('.support-chat-msg.user')).toHaveText('How do I add an API key?');
    await expect(popup2.locator('.support-chat-msg.assistant').last()).toHaveText('Go to the LLM Config tab and paste your key.');
  });

  test('shows an error and sends nothing when no provider/key is configured', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed({ config: { providerGroups: [] } }), (s) => Array.isArray(s?.config?.providerGroups) && s.config.providerGroups.length === 0);

    let called = false;
    await context.route('**/support-chat', async (route) => {
      called = true;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: 'should not be reached' }) });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.locator('#btn-help-chat').click();
    await popup.locator('#support-chat-input').fill('hi');
    await popup.locator('#btn-send-support-chat').click();

    await expect(popup.locator('#support-chat-error')).toBeVisible();
    await expect(popup.locator('.support-chat-msg.user')).toHaveCount(0);
    expect(called).toBe(false);
  });

  test('Clear removes the conversation after confirming', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    await context.route('**/support-chat', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply: 'ok' }) });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.locator('#btn-help-chat').click();
    await popup.locator('#support-chat-input').fill('hi');
    await popup.locator('#btn-send-support-chat').click();
    await expect(popup.locator('.support-chat-msg.user')).toHaveCount(1);

    popup.on('dialog', (dialog) => { void dialog.accept(); });
    await popup.locator('#btn-clear-support-chat').click();
    await expect(popup.locator('.support-chat-msg.user')).toHaveCount(0);
    await expect(popup.locator('.support-chat-empty')).toBeVisible();

    // Cleared for real, not just visually — a fresh popup stays empty too.
    const popup2 = await context.newPage();
    await popup2.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup2.locator('#btn-help-chat').click();
    await expect(popup2.locator('.support-chat-empty')).toBeVisible();
  });

  test('the close button hides the overlay', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.locator('#btn-help-chat').click();
    await expect(popup.locator('#support-chat-overlay')).toHaveClass(/open/);
    await popup.locator('#btn-close-support-chat').click();
    await expect(popup.locator('#support-chat-overlay')).not.toHaveClass(/open/);
  });

  test('assistant replies render Markdown (bold, nested lists) and never interpret HTML', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    // The shape a real model reply came back in (repo owner's screenshot),
    // plus an HTML payload that must stay inert text.
    const reply = [
      'Để bản dịch hay hơn, thử trong **LLM Config** và **Translate**:',
      '',
      '- **Đổi sang model tốt hơn**: chất lượng phụ thuộc model.',
      '- **Bật / tăng ngữ cảnh**:',
      '  - **Previous-page context**: gửi chữ trang trước.',
      '  - **Context Memory**: tóm tắt các trang trước.',
      '- Dùng `Story DB` nếu có đăng nhập.',
      '',
      '<img src=x onerror="document.body.dataset.pwned=1">',
    ].join('\n');
    await context.route('**/support-chat', async (route) => {
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ reply }) });
    });

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.locator('#btn-help-chat').click();
    await popup.locator('#support-chat-input').fill('làm sao để bản dịch hay hơn');
    await popup.locator('#btn-send-support-chat').click();

    const answer = popup.locator('.support-chat-msg.assistant').last();
    await expect(answer.locator('strong').first()).toHaveText('LLM Config');
    await expect(answer.locator('ul > li')).toHaveCount(5); // 3 top-level + 2 nested
    await expect(answer.locator('ul ul > li')).toHaveCount(2);
    await expect(answer.locator('ul ul > li').first()).toContainText('Previous-page context');
    await expect(answer.locator('code')).toHaveText('Story DB');
    await expect(answer).not.toContainText('**');

    await expect(answer.locator('img')).toHaveCount(0);
    await expect(answer).toContainText('<img src=x');
    expect(await popup.evaluate(() => document.body.dataset.pwned)).toBeUndefined();
  });

  test('the input textarea takes up most of the row, not squeezed by the Send button', async ({ context, extensionId }) => {
    // Regression check: #btn-send-support-chat reuses .btn-add-fallback
    // (defaults to width:100%) — an earlier version only set flex:0 0 auto
    // on it, which doesn't cancel a separately-specified width, so the
    // button claimed the whole row and squeezed the textarea down to its
    // min-content width (a narrow column, each word wrapping onto its own
    // line — the exact same bug class already fixed once for the Story DB
    // draft-discard button; see MEMORY.md's flex/width lesson).
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await popup.locator('#btn-help-chat').click();

    const textareaBox = await popup.locator('#support-chat-input').boundingBox();
    const sendBtnBox = await popup.locator('#btn-send-support-chat').boundingBox();
    expect(textareaBox).toBeTruthy();
    expect(sendBtnBox).toBeTruthy();
    expect(textareaBox!.width).toBeGreaterThan(sendBtnBox!.width);
  });
});
