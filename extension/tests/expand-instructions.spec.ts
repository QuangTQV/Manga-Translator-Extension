import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

// The Story Notes textarea is tiny by default (2-3 lines) — cramped for the
// longer character/relationship notes the Suggest button can generate. The
// expand button toggles a taller, resizable layout for reading/editing,
// entirely client-side UI state (not persisted, not sent to the backend).
test.describe('popup — Translate tab Story Notes expand button', () => {
  test('toggles the textarea between compact and expanded, and back', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedSettings(worker, baseSeed({}), firstKeyMatches('seed-key'));

    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);

    const textarea = popup.locator('#f-instructions');
    const expandBtn = popup.locator('#btn-expand-instructions');

    await expect(textarea).not.toHaveClass(/textarea-expanded/);
    await expect(expandBtn).not.toHaveClass(/active/);

    await expandBtn.click();
    await expect(textarea).toHaveClass(/textarea-expanded/);
    await expect(expandBtn).toHaveClass(/active/);

    await expandBtn.click();
    await expect(textarea).not.toHaveClass(/textarea-expanded/);
    await expect(expandBtn).not.toHaveClass(/active/);
  });
});
