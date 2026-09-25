import { chromium } from '@playwright/test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Regenerates the popup/tool screenshots in docs/assets/ used by the READMEs.
// Run from extension/ after `npm run build`:
//   node scripts/readme-screenshots.mjs            # all
//   node scripts/readme-screenshots.mjs storydb    # one of: translate | actions | storydb | help | region | auto
// The backend is fully mocked (healthy, logged in, an invented sample story),
// so no backend, account or API key is needed.
const EXT = path.resolve('dist');
const OUT = path.resolve('../docs/assets');
const only = process.argv[2];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mt-shots-'));
const ctx = await chromium.launchPersistentContext(dir, {
  headless: false, deviceScaleFactor: 2, viewport: { width: 390, height: 900 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
});
let [worker] = ctx.serviceWorkers();
if (!worker) worker = await ctx.waitForEvent('serviceworker');
const extId = worker.url().split('/')[2];

// ── A healthy, logged-in backend ─────────────────────────────────────────
const json = (body) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
await ctx.route('**/health', (r) => r.fulfill(json({ status: 'ok' })));
await ctx.route('**/fonts', (r) => r.fulfill(json({ fonts: ['komika', 'wildwords'] })));
await ctx.route('**/account/me', (r) => r.fulfill(json({ email: 'reader@example.com', plan: 'free', usage_count: 42, quota: 500, period_start: 0, is_admin: false })));

// An invented sample story (not a real series). Positions as if the user
// had arranged the map, so no edges cross.
const POS = { c1: { x: 180, y: 42 }, c2: { x: 312, y: 112 }, c4: { x: 262, y: 218 }, c3: { x: 98, y: 218 }, c5: { x: 48, y: 112 } };
const chars = [
  ['c1', 'Kaito', 'male', 'Protagonist, apprentice swordsman', 'Hot-headed, blunt with friends, polite to elders'],
  ['c2', 'Yuna', 'female', 'Kaito\'s childhood friend, healer', 'Gentle, teasing with Kaito'],
  ['c3', 'Master Genji', 'male', 'Kaito\'s swordsmanship teacher', 'Old-fashioned, speaks formally'],
  ['c4', 'Rei', 'female', 'Rival from the northern school', 'Cold, sarcastic'],
  ['c5', 'Lord Asamura', 'male', 'Antagonist', 'Arrogant, condescending'],
].map(([id, name, gender, role, voice_notes]) => ({ id, name, gender, role, voice_notes, ...POS[id], avatar: null, reference_images: [] }));
const story = {
  id: 'story-1', name: 'Moonlit Blade (sample)', updated_at: 0, characters: chars,
  relationships: [
    { id: 'r1', character_a_id: 'c1', character_b_id: 'c2', surface_relation: 'Childhood friends', address_notes: 'Casual; she calls him by his first name' },
    { id: 'r2', character_a_id: 'c1', character_b_id: 'c3', surface_relation: 'Master & student', address_notes: 'Kaito addresses him formally as "Master"' },
    { id: 'r3', character_a_id: 'c1', character_b_id: 'c4', surface_relation: 'Rivals', address_notes: 'Hostile, mocking' },
    { id: 'r4', character_a_id: 'c3', character_b_id: 'c5', surface_relation: 'Former comrades', address_notes: null },
    { id: 'r5', character_a_id: 'c2', character_b_id: 'c4', surface_relation: 'Wary allies', address_notes: null },
  ],
  glossary: [
    { id: 'g1', term: '月影流', translation: 'Moonshadow Style', notes: 'Kaito\'s sword school' },
    { id: 'g2', term: '北辰会', translation: 'Northern Star Guild', notes: null },
  ],
  continuity_notes: [{ id: 'n1', text: 'Master Genji reveals he once served Lord Asamura.', source_label: 'Chapter 12' }],
  continuity_notes_enabled: true,
};
await ctx.route('**/stories', (r) => r.fulfill(json([{ id: 'story-1', name: story.name, updated_at: 0 }])));
await ctx.route('**/stories/story-1', (r) => r.fulfill(json(story)));

const helpReply = [
  'A few things make the biggest difference:',
  '',
  '- **Use a stronger model** in **LLM Config** — quality depends on it most.',
  '- **Give it more context** (Translate tab):',
  '  - **Previous-page context** keeps names and pronouns consistent.',
  '  - **Context Memory** carries a short summary from page to page.',
  '- **Set up a Story DB** for recurring characters, then turn on `Use Story DB`.',
  '',
  'Wrong pronouns on one bubble? Click it and use **Fix a translation**.',
].join('\n');
await ctx.route('**/support-chat', (r) => r.fulfill(json({ reply: helpReply })));

const SEED = {
  backendUrl: 'http://localhost:7677', autoDetect: false, showBubbleBboxes: false, extensionEnabled: true, uiLanguage: 'en',
  accountToken: 'tok', accountEmail: 'reader@example.com', activeStoryId: 'story-1',
  config: {
    inputLanguage: 'Japanese', outputLanguage: 'English',
    providerGroups: [{ provider: 'Google', modelName: 'gemini-3.1-flash', apiKeys: [{ key: 'demo-key', enabled: true }], enabled: true }],
    temperature: 0.1, topP: 0.95, topK: 1, translationMode: 'one-step', ocrMethod: 'LLM',
    maxFontSize: 16, minFontSize: 8, supersamplingFactor: 4, sendFullPageContext: true, imageDetail: 'auto',
    outsideTextEnabled: true, useStoryDb: true, contextMemoryEnabled: true, rotationStrategy: 'round_robin', cooldownSeconds: 15,
  },
};
// On a fresh profile the extension's onInstalled handler can overwrite a
// seed written too early (see tests/storage.ts) — write, verify, retry.
for (let i = 0; ; i++) {
  await worker.evaluate(async (s) => { await chrome.storage.local.set({ manga_translator_settings: s }); }, SEED);
  await new Promise((r) => setTimeout(r, 300));
  const ok = await worker.evaluate(async () => (await chrome.storage.local.get('manga_translator_settings')).manga_translator_settings?.accountToken === 'tok');
  if (ok) break;
  if (i > 20) throw new Error('seed never settled');
}

async function openPopup() {
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/popup/index.html`);
  // Let body grow to its full content (the real popup caps its height and
  // scrolls) so element screenshots capture whole sections.
  await p.addStyleTag({ content: 'body{max-height:none!important;height:auto!important;overflow:visible!important;resize:none!important} #popup-status{display:none!important}' });
  await p.locator('#health-badge.ok').waitFor();
  await p.waitForTimeout(400);
  return p;
}
const clip = async (p, fromSel, toSel, file, pad = 0, bottomPad = pad) => {
  const a = await p.locator(fromSel).boundingBox();
  const b = await p.locator(toSel).boundingBox();
  const y = Math.max(0, a.y - pad);
  await p.screenshot({ path: file, clip: { x: 0, y, width: 390, height: b.y + b.height - y + bottomPad }, fullPage: true });
};

if (!only || only === 'translate') {
  const p = await openPopup();
  await clip(p, '.popup-header', '#inpainting-method-field', `${OUT}/popup-preview.png`, 16, 4);
  await p.close();
}
if (!only || only === 'actions') {
  // The Translate tab's action buttons (Scan, Auto-translate, ...) sit below
  // all its settings, so they get their own small shot.
  const p = await openPopup();
  await clip(p, '#btn-scan', '#btn-clear-cache', `${OUT}/popup-actions-preview.png`, 8, 8);
  await p.close();
}
if (!only || only === 'storydb') {
  const p = await openPopup();
  await p.getByRole('button', { name: 'Story DB' }).click();
  await p.locator('.story-rel-row').first().waitFor();
  await p.waitForTimeout(500);
  await clip(p, 'label[data-i18n="labelStoryGraph"]', '.story-char-row:nth-child(1)', `${OUT}/story-db-preview.png`, 8, 4);
  await p.close();
}
if (!only || only === 'help') {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: 390, height: 620 });
  await p.goto(`chrome-extension://${extId}/popup/index.html`);
  await p.locator('#health-badge.ok').waitFor();
  await p.addStyleTag({ content: '#popup-status{display:none!important}' });
  await p.locator('#btn-help-chat').click();
  await p.locator('#support-chat-input').fill('How do I get better translations?');
  await p.locator('#btn-send-support-chat').click();
  await p.locator('.support-chat-msg.assistant.md').waitFor();
  await p.waitForTimeout(300);
  await p.screenshot({ path: `${OUT}/help-chat-preview.png` });
  await p.close();
}
if (!only || only === 'region') {
  await ctx.route('**/region/ocr', (r) => r.fulfill(json({ text: 'ピンポーン', warning: null })));
  await ctx.route('**/region/translate', (r) => r.fulfill(json({ translation: 'Ding-dong!' })));
  // docs/assets/manga-after.png already leaves the "ピンポーン" SFX untranslated —
  // exactly the case the manual text-area tool exists for.
  const html = path.join(dir, 'manga-page.html');
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#1b1b1f;display:flex;justify-content:center;padding:24px 0}img{width:598px;height:859px;display:block}</style><img id="page" src="file://${path.join(OUT, 'manga-after.png')}" alt="">`);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 660, height: 907 });
  await page.goto('file://' + html);
  await page.locator('#page').evaluate((img) => img.decode());
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/index.html`);
  await page.bringToFront();
  await popup.locator('#btn-region').click();
  await page.locator('#mt-region-select').waitFor({ timeout: 10_000 });
  const img = await page.locator('#page').boundingBox();
  // The untranslated "ピンポーン" sound effect on the left of the page.
  await page.mouse.move(img.x + 38, img.y + 468);
  await page.mouse.down();
  await page.mouse.move(img.x + 128, img.y + 582, { steps: 8 });
  await page.mouse.up();
  const editor = page.locator('#mt-region-editor');
  await editor.locator('#orig').waitFor();
  await page.waitForTimeout(800);
  await editor.locator('#ai').click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}/manual-region-preview.png` });
  await page.close(); await popup.close();
}
if (!only || only === 'auto') {
  // A vertical reader mid-way through auto-translate: page 1 finished (with
  // the hover magnifier open on a bubble, original text as its caption),
  // page 2 still translating. Page 2 is the same art re-encoded as JPEG so
  // its request can be told apart (and so it isn't served from page 1's
  // content-hash cache); its request is left pending for the capture.
  const beforePng = path.join(OUT, 'manga-before.png');
  const page2 = path.join(dir, 'page2.jpg');
  // Re-encode in the browser (canvas) rather than with an OS tool, so this
  // runs the same on Windows/macOS/Linux.
  const encoder = await ctx.newPage();
  const jpegB64 = await encoder.evaluate(async (pngB64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${pngB64}`;
    await img.decode();
    const canvas = Object.assign(document.createElement('canvas'), { width: img.naturalWidth, height: img.naturalHeight });
    canvas.getContext('2d').drawImage(img, 0, 0);
    return canvas.toDataURL('image/jpeg', 0.92).split(',')[1];
  }, fs.readFileSync(beforePng).toString('base64'));
  await encoder.close();
  fs.writeFileSync(page2, Buffer.from(jpegB64, 'base64'));
  const afterB64 = fs.readFileSync(path.join(OUT, 'manga-after.png')).toString('base64');
  await ctx.route('**/translate', async (r) => {
    const image = r.request().postDataJSON()?.image ?? '';
    if (image.startsWith('/9j/')) return; // page 2 (JPEG): leave it translating
    await r.fulfill(json({
      translated_image: afterB64,
      bubbles: [
        { bbox: [462, 268, 596, 432], confidence: 0.95, original_text: '次は四十九日？ 多分大丈夫', translated_text: "The next one is the 49th day memorial? I think I'll be fine." },
        { bbox: [128, 272, 242, 440], confidence: 0.95, original_text: 'あ 今度 おばあちゃん家 行ってくるよ', translated_text: "Oh, I'm going to visit Grandma's place soon." },
        { bbox: [226, 478, 392, 712], confidence: 0.95, original_text: '最終面接… なくなっちゃったから', translated_text: 'The final interview... got cancelled.' },
        { bbox: [104, 492, 176, 580], confidence: 0.95, original_text: '来た', translated_text: "It's here." },
        { bbox: [34, 676, 120, 812], confidence: 0.95, original_text: 'じゃあね お母さん', translated_text: 'See you later, Mom' },
      ],
      processing_time_seconds: 4.2, source_language: 'Japanese', target_language: 'English', provider: 'Google', ocr_texts: [],
    }));
  });
  const html = path.join(dir, 'reader.html');
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><title>Chapter 3</title><style>body{margin:0;background:#1b1b1f}main{width:598px;margin:0 auto;padding:24px 0}img{width:598px;height:859px;display:block;margin:0 0 16px}</style><main><img id="p1" src="file://${beforePng}" alt=""><img id="p2" src="file://${page2}" alt=""></main>`);
  const page = await ctx.newPage();
  await page.setViewportSize({ width: 760, height: 1000 });
  await page.goto('file://' + html);
  await page.evaluate(() => Promise.all([...document.images].map((i) => i.decode())));
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/index.html`);
  await page.bringToFront();
  await popup.locator('#btn-auto').click();
  await page.locator('.mt-badge').first().waitFor({ timeout: 20_000 });
  await page.locator('.mt-progress-badge').first().waitFor({ timeout: 20_000 });
  await page.evaluate(() => window.scrollTo(0, 190));
  await page.waitForTimeout(600);
  // Hover the "visit Grandma's place" bubble (left side of page 1): its
  // magnifier opens on the left, clear of page 2's in-progress badge, which
  // sits at that page's top-right corner.
  const img1 = await page.locator('#p1').boundingBox();
  const want = { x: img1.x + 185, y: img1.y + 356 };
  const hits = page.locator('.mt-fix-hit');
  let target = null;
  for (let i = 0; i < await hits.count(); i++) {
    const b = await hits.nth(i).boundingBox();
    if (b && want.x > b.x && want.x < b.x + b.width && want.y > b.y && want.y < b.y + b.height) target = hits.nth(i);
  }
  await target.hover();
  await page.locator('.mt-bubble-magnifier').waitFor();
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}/auto-translate-preview.png` });
  await page.close(); await popup.close();
}
await ctx.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('done');
