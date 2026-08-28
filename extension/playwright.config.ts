import { defineConfig } from '@playwright/test';

// Chrome-extension tests each launch their own persistent context (a real,
// disposable user-data-dir loading extension/dist as an unpacked
// extension) — see tests/fixtures.ts. Keep everything serial/single-worker:
// these aren't testing arbitrary web pages that parallelize safely, they're
// driving actual browser windows with extension state, and running several
// at once on a dev machine is more likely to flake than to save real time.
export default defineConfig({
  testDir: './tests',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
});
