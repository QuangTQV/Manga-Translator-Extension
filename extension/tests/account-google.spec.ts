import { expect, test } from './fixtures';
import { baseSeed, firstKeyMatches, seedSettings } from './storage';

// chrome.identity.getAuthToken() needs a real Google Cloud OAuth client
// registered for this extension's (published) ID — this repo ships with a
// placeholder client_id in manifest.json, so a real end-to-end Google
// sign-in can't be exercised here. What IS worth verifying: clicking
// "Sign in with Google" with that placeholder fails cleanly (a status
// message) instead of hanging or throwing unhandled — i.e. the button is
// wired correctly and the failure path is handled, which is the actual
// state this feature ships in until a deployment operator configures a
// real client_id.
test('Sign in with Google fails cleanly with the placeholder OAuth client_id, instead of hanging', async ({ context, extensionId }) => {
  // The background's own GOOGLE_SIGN_IN_TIMEOUT_MS (30s) leaves no margin
  // under the suite's default 30s per-test timeout — this test needs to
  // actually observe that timeout firing, so give it real headroom.
  test.setTimeout(60_000);

  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await seedSettings(worker, baseSeed(), firstKeyMatches('seed-key'));

  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${extensionId}/popup/index.html`);
  await popup.getByRole('button', { name: 'Account' }).click();

  await popup.locator('#btn-account-google').click();

  // Whatever Chrome's exact rejection message is for an invalid/placeholder
  // client_id, the popup must land on an error status, not stay stuck on
  // "Signing in..." forever, and must not leave the account logged in.
  await expect(popup.locator('#popup-status')).toHaveClass(/err/, { timeout: 45_000 });
  await expect(popup.locator('#account-logged-out')).toBeVisible();
});
