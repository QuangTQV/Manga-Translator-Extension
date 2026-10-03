import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

// story-context.spec.ts already covers the popup-side version of this
// warning (checkStoryDomainMismatch, shown in the Story DB tab). This covers
// the on-page version added alongside it — a reader translating a page
// under the wrong Story DB had no sign anything was off unless they
// happened to open the popup's Story DB tab; this surfaces it right on the
// page the moment auto-translate starts, with two one-click fixes.
test.describe('content-script — Story DB domain mismatch banner', () => {
  async function seedMismatch(context: any, worker: any) {
    await seedSettings(
      worker,
      baseSeed({ accountToken: 'tok-abc', accountEmail: 'a@example.com', activeStoryId: 'story-2', config: { useStoryDb: true } }),
      firstKeyMatches('seed-key'),
    );
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ mtStoryDomainMap: { 'example-manga-site.test': 'story-1' } });
    });
    await context.route('https://example-manga-site.test/**', async (route: any) => {
      await route.fulfill({ status: 200, contentType: 'text/html', body: '<html><body><img src="/page1.jpg" width="800" height="1200"></body></html>' });
    });
    // checkStoryDomainMismatchOnPage names the previous story in the
    // banner (bgFetchStoryName -> background's STORY_LIST), same as the
    // popup's own version of this warning does.
    await context.route('**/stories', async (route: any) => {
      if (route.request().method() !== 'GET') { await route.fallback(); return; }
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify([{ id: 'story-1', name: 'Seirei Gensouki', updated_at: 0 }, { id: 'story-2', name: 'One Piece', updated_at: 0 }]),
      });
    });
  }

  test('shows on auto-translate start, and "Select no story" clears the active story', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedMismatch(context, worker);

    const mangaPage = await context.newPage();
    await mangaPage.goto('https://example-manga-site.test/chapter-1');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await mangaPage.bringToFront();
    await popup.locator('#btn-auto').click();

    const banner = mangaPage.locator('#mt-story-mismatch-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await expect(banner).toContainText('example-manga-site.test');
    await expect(banner).toContainText('Seirei Gensouki');

    await banner.getByRole('button', { name: 'Select no story' }).click();
    await expect(banner).toHaveCount(0, { timeout: 1_000 });

    const stored = await worker.evaluate(async () => {
      const result = await chrome.storage.local.get('manga_translator_settings');
      return (result.manga_translator_settings as any)?.activeStoryId;
    });
    expect(stored).toBeUndefined();
  });

  test('"Don\'t ask again for this site" suppresses the banner on a later page load', async ({ context, extensionId }) => {
    let [worker] = context.serviceWorkers();
    if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
    await seedMismatch(context, worker);

    const mangaPage = await context.newPage();
    await mangaPage.goto('https://example-manga-site.test/chapter-1');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
    await mangaPage.bringToFront();
    await popup.locator('#btn-auto').click();

    const banner = mangaPage.locator('#mt-story-mismatch-banner');
    await expect(banner).toBeVisible({ timeout: 10_000 });
    await banner.getByRole('button', { name: "Don't ask again for this site" }).click();
    await expect(banner).toHaveCount(0, { timeout: 1_000 });

    const dismissed = await worker.evaluate(async () => {
      const result = await chrome.storage.local.get('mtStoryDomainMismatchDismissed');
      return result.mtStoryDomainMismatchDismissed;
    });
    expect(dismissed).toEqual({ 'example-manga-site.test': 'story-1::story-2' });

    // A fresh page load (new content-script instance) no longer shows it.
    const mangaPage2 = await context.newPage();
    await mangaPage2.goto('https://example-manga-site.test/chapter-2');
    await mangaPage2.bringToFront();
    await popup.locator('#btn-auto').click();
    await mangaPage2.waitForTimeout(2_000);
    await expect(mangaPage2.locator('#mt-story-mismatch-banner')).toHaveCount(0);
  });
});
