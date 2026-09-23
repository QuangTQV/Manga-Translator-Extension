// Manual region tool: the user drags a box over a spot on a page image, we read
// the text in it (backend OCR), and they either type a translation or ask the
// AI — then the spot is cleaned and the translation drawn over it.
//
// Regions are always rendered onto the page's *base* image (the auto-translated
// page if there is one, otherwise the untouched source), never onto an earlier
// manual result, so editing/deleting a region is exact and repeatable. They are
// persisted per page URL and re-applied after an (auto-)translation lands.

import type { RegionBoxNorm, StoredRegion } from '../shared/types.js';

export interface RegionToolDeps {
  /** Translate-request fields (provider, languages, story, ...) without the image. */
  requestOptions(): Promise<Record<string, unknown>>;
  /** Raw base64 of the untranslated source image, or null if it can't be read. */
  fetchSource(rawUrl: string): Promise<string | null>;
  /** Raw base64 of the auto-translated page, if this page has one. */
  translatedBase(rawUrl: string): string | null;
  applyImage(rawUrl: string, dataUrl: string): void;
  restoreOriginal(img: HTMLImageElement): void;
  resolveUrl(img: HTMLImageElement): string | null;
  tr(key: string): string;
  toast(message: string, isError?: boolean): void;
}

const STORAGE_KEY = 'mtManualRegions';
const MAX_STORED_PAGES = 200;
const MIN_IMAGE_W = 150;
const MIN_IMAGE_H = 100;
const Z = '2147483647';

let deps: RegionToolDeps;
const sessionRegions = new Map<string, StoredRegion[]>(); // rawUrl -> regions
let selecting = false;
let closeEditor: (() => void) | null = null;

export function initRegionTool(d: RegionToolDeps): void {
  deps = d;
}

// ── persistence ──────────────────────────────────────────────────────────────

type Store = Record<string, { regions: StoredRegion[]; updatedAt: number }>;

/** blob:/data: URLs change every load, so only stable http(s)/file pages persist. */
function pageKey(rawUrl: string): string | null {
  try {
    const u = new URL(rawUrl, location.href);
    if (u.protocol !== 'http:' && u.protocol !== 'https:' && u.protocol !== 'file:') return null;
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return null;
  }
}

async function readStore(): Promise<Store> {
  try {
    const raw = await chrome.storage.local.get(STORAGE_KEY);
    return (raw[STORAGE_KEY] as Store | undefined) ?? {};
  } catch {
    return {};
  }
}

async function regionsFor(rawUrl: string): Promise<StoredRegion[]> {
  const cached = sessionRegions.get(rawUrl);
  if (cached) return cached;
  const key = pageKey(rawUrl);
  const stored = key ? (await readStore())[key]?.regions ?? [] : [];
  sessionRegions.set(rawUrl, stored);
  return stored;
}

async function saveRegions(rawUrl: string, regions: StoredRegion[]): Promise<void> {
  sessionRegions.set(rawUrl, regions);
  const key = pageKey(rawUrl);
  if (!key) return;
  try {
    const store = await readStore();
    if (regions.length) store[key] = { regions, updatedAt: Date.now() };
    else delete store[key];
    const keys = Object.keys(store);
    if (keys.length > MAX_STORED_PAGES) {
      keys.sort((a, b) => store[a].updatedAt - store[b].updatedAt);
      for (const k of keys.slice(0, keys.length - MAX_STORED_PAGES)) delete store[k];
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: store });
  } catch { /* storage is best-effort — the region still applied this session */ }
}

// ── backend calls ────────────────────────────────────────────────────────────

async function api<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const options = await deps.requestOptions();
  const resp = await new Promise<{ ok: boolean; data?: T; error?: string } | undefined>((resolve) => {
    chrome.runtime.sendMessage({ type: 'REGION_API', path, body: { ...options, ...body } }, resolve);
  });
  if (!resp?.ok || resp.data === undefined) throw new Error(resp?.error ?? 'No response from backend');
  return resp.data;
}

/** Draws `regions` onto the page's base image and shows the result. */
async function renderPage(img: HTMLImageElement, rawUrl: string, regions: StoredRegion[]): Promise<void> {
  const translated = deps.translatedBase(rawUrl);
  if (!regions.length) {
    if (translated) deps.applyImage(rawUrl, `data:image/png;base64,${translated}`);
    else deps.restoreOriginal(img);
    return;
  }
  const base = translated ?? (await deps.fetchSource(rawUrl));
  if (!base) throw new Error(deps.tr('regionNoImage'));
  // A restoreOnly region (deleting/moving a detected bubble) needs the real
  // pre-translation pixels for its box, which `base` alone doesn't have once
  // it's the already-translated page — fetch the untouched source too, only
  // when something actually needs it.
  let sourceImage: string | undefined;
  if (regions.some((r) => r.restoreOnly)) {
    sourceImage = translated ? (await deps.fetchSource(rawUrl)) ?? undefined : base;
    if (!sourceImage) throw new Error(deps.tr('regionNoImage'));
  }
  const out = await api<{ image: string }>('/region/render', {
    image: base,
    source_image: sourceImage,
    regions: regions.map((r) => ({ box: r.box, text: r.translation, restore_only: !!r.restoreOnly })),
  });
  deps.applyImage(rawUrl, `data:image/png;base64,${out.image}`);
}

/** Re-applies a page's saved regions (after an auto-translation replaced the overlay, or on load). */
export async function reapplyManualRegions(img: HTMLImageElement, rawUrl: string): Promise<void> {
  try {
    const regions = await regionsFor(rawUrl);
    if (regions.length) await renderPage(img, rawUrl, regions);
  } catch (e) {
    console.log('[MT] reapplyManualRegions failed:', e);
  }
}

/** On page load: draw saved regions on images that aren't being auto-translated. */
export async function restoreManualRegionsOnLoad(): Promise<void> {
  const store = await readStore();
  if (!Object.keys(store).length) return;
  for (const img of Array.from(document.querySelectorAll<HTMLImageElement>('img'))) {
    if (img.hasAttribute('data-mt-translated')) continue;
    const rawUrl = deps.resolveUrl(img);
    const key = rawUrl ? pageKey(rawUrl) : null;
    if (!rawUrl || !key || !store[key]) continue;
    sessionRegions.set(rawUrl, store[key].regions);
    await reapplyManualRegions(img, rawUrl);
  }
}

// ── selection ────────────────────────────────────────────────────────────────

interface Rect { left: number; top: number; right: number; bottom: number; }

function intersection(a: Rect, b: Rect): number {
  const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
  const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
  return w > 0 && h > 0 ? w * h : 0;
}

function findTargetImage(sel: Rect): HTMLImageElement | null {
  const selArea = (sel.right - sel.left) * (sel.bottom - sel.top);
  let best: HTMLImageElement | null = null;
  let bestArea = 0;
  for (const img of Array.from(document.querySelectorAll<HTMLImageElement>('img:not(.mt-page-overlay)'))) {
    const r = img.getBoundingClientRect();
    if (r.width < MIN_IMAGE_W || r.height < MIN_IMAGE_H) continue;
    const area = intersection(sel, r);
    if (area > bestArea) { best = img; bestArea = area; }
  }
  return best && bestArea >= selArea * 0.6 ? best : null;
}

function toNormBox(sel: Rect, img: HTMLImageElement): RegionBoxNorm {
  const r = img.getBoundingClientRect();
  const clamp = (v: number): number => Math.min(1, Math.max(0, v));
  return {
    x1: clamp((sel.left - r.left) / r.width),
    y1: clamp((sel.top - r.top) / r.height),
    x2: clamp((sel.right - r.left) / r.width),
    y2: clamp((sel.bottom - r.top) / r.height),
  };
}

function overlapsExisting(box: RegionBoxNorm, regions: StoredRegion[]): StoredRegion | null {
  const area = (b: RegionBoxNorm): number => (b.x2 - b.x1) * (b.y2 - b.y1);
  for (const r of regions) {
    const w = Math.min(box.x2, r.box.x2) - Math.max(box.x1, r.box.x1);
    const h = Math.min(box.y2, r.box.y2) - Math.max(box.y1, r.box.y1);
    if (w > 0 && h > 0 && (w * h) / Math.min(area(box), area(r.box)) > 0.5) return r;
  }
  return null;
}

/**
 * Shows the crosshair drag-a-box overlay and resolves with the screen Rect
 * the user dragged, or null if they cancelled (Esc) or dragged too small (a
 * toast is shown for that case, same as a real cancel from the caller's
 * point of view). Shared by `startRegionSelect` (pick anywhere, find the
 * image under it) and `startMoveBubbleSelect` (the image is already known —
 * only the new spot needs picking).
 */
function pickBoxOnScreen(hintKey: string): Promise<Rect | null> {
  return new Promise((resolve) => {
    if (selecting) { resolve(null); return; }
    closeEditor?.();
    selecting = true;

    const layer = document.createElement('div');
    layer.id = 'mt-region-select';
    layer.style.cssText = `position:fixed;inset:0;z-index:${Z};cursor:crosshair;background:rgba(8,12,24,0.25);`;
    const hint = document.createElement('div');
    hint.textContent = deps.tr(hintKey);
    hint.style.cssText = 'position:fixed;top:14px;left:50%;transform:translateX(-50%);padding:8px 14px;border-radius:999px;background:#0b1120;color:#dde6f5;font:13px system-ui,sans-serif;border:1px solid #7aa2ff;pointer-events:none;';
    const box = document.createElement('div');
    box.style.cssText = 'position:fixed;border:2px solid #7aa2ff;background:rgba(122,162,255,0.18);display:none;pointer-events:none;';
    layer.append(hint, box);
    document.body.appendChild(layer);

    let start: { x: number; y: number } | null = null;
    const finish = (result: Rect | null): void => {
      selecting = false;
      layer.remove();
      document.removeEventListener('keydown', onKey, true);
      resolve(result);
    };
    const onKey = (ev: KeyboardEvent): void => {
      if (ev.key === 'Escape') { ev.preventDefault(); finish(null); }
    };
    document.addEventListener('keydown', onKey, true);

    layer.addEventListener('pointerdown', (ev) => {
      start = { x: ev.clientX, y: ev.clientY };
      layer.setPointerCapture(ev.pointerId);
      box.style.display = 'block';
    });
    layer.addEventListener('pointermove', (ev) => {
      if (!start) return;
      const left = Math.min(start.x, ev.clientX);
      const top = Math.min(start.y, ev.clientY);
      box.style.left = `${left}px`;
      box.style.top = `${top}px`;
      box.style.width = `${Math.abs(ev.clientX - start.x)}px`;
      box.style.height = `${Math.abs(ev.clientY - start.y)}px`;
    });
    layer.addEventListener('pointerup', (ev) => {
      if (!start) return;
      const sel: Rect = {
        left: Math.min(start.x, ev.clientX), top: Math.min(start.y, ev.clientY),
        right: Math.max(start.x, ev.clientX), bottom: Math.max(start.y, ev.clientY),
      };
      if (sel.right - sel.left < 12 || sel.bottom - sel.top < 12) {
        finish(null);
        deps.toast(deps.tr('regionTooSmall'), true);
        return;
      }
      finish(sel);
    });
  });
}

export function startRegionSelect(): void {
  void pickBoxOnScreen('regionPickHint').then((sel) => {
    if (!sel) return;
    const img = findTargetImage(sel);
    const rawUrl = img ? deps.resolveUrl(img) : null;
    if (!img || !rawUrl) { deps.toast(deps.tr('regionNoImage'), true); return; }
    void openEditor(img, rawUrl, sel);
  });
}

/**
 * Moving/resizing an already-detected bubble: the caller (content-script's
 * fix popover) already knows the image, the bubble's current box, and its
 * text — the user only needs to drag where it should go. Applying commits
 * two regions: the new one (drawn) and a restoreOnly one at `oldBox` that
 * erases the wrong drawing left at the bubble's old spot.
 */
export function startMoveBubbleSelect(
  img: HTMLImageElement,
  rawUrl: string,
  oldBox: RegionBoxNorm,
  text: string,
  translation: string,
): void {
  void pickBoxOnScreen('regionMovePickHint').then((sel) => {
    if (!sel) return;
    void openEditor(img, rawUrl, sel, {
      text,
      translation,
      extraCommit: [{ id: crypto.randomUUID(), box: oldBox, text: '', translation: '', restoreOnly: true }],
    });
  });
}

/** Deleting an already-detected bubble: restore its box to the original,
 * pre-translation pixels — no editor needed. */
export async function deleteBubbleRegion(img: HTMLImageElement, rawUrl: string, box: RegionBoxNorm): Promise<void> {
  const regions = await regionsFor(rawUrl);
  const next = [...regions, { id: crypto.randomUUID(), box, text: '', translation: '', restoreOnly: true }];
  await renderPage(img, rawUrl, next);
  await saveRegions(rawUrl, next);
}

// ── editor ───────────────────────────────────────────────────────────────────

interface EditorSeed {
  /** Known text/translation to prefill (skips the OCR read) — used when
   * moving an already-detected bubble, whose text is already known. */
  text: string;
  translation: string;
  /** Extra regions to save alongside this one on Apply — the restoreOnly
   * region that erases the bubble's old spot, for a move. */
  extraCommit: StoredRegion[];
}

async function openEditor(img: HTMLImageElement, rawUrl: string, sel: Rect, seed?: EditorSeed): Promise<void> {
  closeEditor?.();
  const box = toNormBox(sel, img);
  const all = await regionsFor(rawUrl);
  // A seeded open (moving a bubble) always creates a fresh region at the new
  // spot — it's never "editing" whatever manual region happens to already
  // overlap the drop point.
  const existing = seed ? null : overlapsExisting(box, all);
  const region: StoredRegion = existing ?? { id: crypto.randomUUID(), box, text: seed?.text ?? '', translation: seed?.translation ?? '' };

  const outline = document.createElement('div');
  outline.style.cssText = `position:fixed;z-index:${Z};left:${sel.left}px;top:${sel.top}px;width:${sel.right - sel.left}px;height:${sel.bottom - sel.top}px;border:2px solid #7aa2ff;border-radius:4px;pointer-events:none;`;

  const host = document.createElement('div');
  host.id = 'mt-region-editor';
  host.style.cssText = `position:fixed;z-index:${Z};width:330px;`;
  const shadow = host.attachShadow({ mode: 'open' });
  const tr = deps.tr;
  shadow.innerHTML = `
    <style>
      .card{background:#0b1120;color:#dde6f5;border:1px solid #7aa2ff;border-radius:12px;padding:12px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:8px}
      .title{font-weight:600}
      label{font-size:11px;color:#9fb0cf;text-transform:uppercase;letter-spacing:.04em}
      textarea{width:100%;min-height:54px;resize:vertical;box-sizing:border-box;background:#080c18;color:#dde6f5;border:1px solid rgba(122,162,255,.35);border-radius:8px;padding:6px 8px;font:13px system-ui,sans-serif}
      textarea:focus{outline:none;border-color:#7aa2ff}
      .row{display:flex;gap:6px;flex-wrap:wrap}
      button{border:1px solid rgba(122,162,255,.5);background:transparent;color:#dde6f5;border-radius:8px;padding:6px 10px;font:12px system-ui,sans-serif;cursor:pointer}
      button:hover:not(:disabled){background:rgba(122,162,255,.15)}
      button:disabled{opacity:.5;cursor:default}
      button.primary{background:#7aa2ff;color:#080c18;border-color:#7aa2ff;font-weight:600}
      button.danger{color:#f87171;border-color:rgba(248,113,113,.5)}
      .spacer{flex:1}
      .status{font-size:11px;color:#9fb0cf;min-height:14px}
      .status.err{color:#f87171}
    </style>
    <div class="card">
      <div class="title">${tr('regionTitle')}</div>
      <label>${tr('regionOriginalLabel')}</label>
      <textarea id="orig"></textarea>
      <div class="row"><button id="ai" type="button">${tr('regionTranslateAi')}</button></div>
      <label>${tr('regionTranslationLabel')}</label>
      <textarea id="trans"></textarea>
      <div class="status" id="status"></div>
      <div class="row">
        <button id="apply" class="primary" type="button">${tr('regionApply')}</button>
        <button id="cancel" type="button">${tr('regionCancel')}</button>
        <span class="spacer"></span>
        <button id="del" class="danger" type="button">${tr('regionDelete')}</button>
      </div>
    </div>`;
  const $ = <T extends HTMLElement>(id: string): T => shadow.getElementById(id) as T;
  const orig = $<HTMLTextAreaElement>('orig');
  const trans = $<HTMLTextAreaElement>('trans');
  const status = $<HTMLDivElement>('status');
  const aiBtn = $<HTMLButtonElement>('ai');
  const applyBtn = $<HTMLButtonElement>('apply');
  const delBtn = $<HTMLButtonElement>('del');
  delBtn.style.display = existing ? '' : 'none';
  orig.value = region.text;
  trans.value = region.translation;

  const setStatus = (msg: string, err = false): void => { status.textContent = msg; status.classList.toggle('err', err); };
  const setBusy = (busy: boolean): void => { aiBtn.disabled = busy; applyBtn.disabled = busy; delBtn.disabled = busy; };

  // Place the card just below the selection, or above it if there's no room.
  const place = (): void => {
    const h = host.getBoundingClientRect().height || 260;
    let top = sel.bottom + 8;
    if (top + h > window.innerHeight - 8) top = Math.max(8, sel.top - h - 8);
    host.style.top = `${top}px`;
    host.style.left = `${Math.min(Math.max(8, sel.left), window.innerWidth - 338)}px`;
  };
  document.body.append(outline, host);
  place();

  const close = (): void => {
    outline.remove();
    host.remove();
    document.removeEventListener('keydown', onKey, true);
    if (closeEditor === close) closeEditor = null;
  };
  const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey, true);
  closeEditor = close;
  $<HTMLButtonElement>('cancel').addEventListener('click', close);

  const others = all.filter((r) => r.id !== region.id);
  const commit = async (next: StoredRegion[]): Promise<void> => {
    await renderPage(img, rawUrl, next);
    await saveRegions(rawUrl, next);
  };

  aiBtn.addEventListener('click', async () => {
    const text = orig.value.trim();
    if (!text) { setStatus(tr('regionNeedText'), true); return; }
    setBusy(true);
    setStatus(tr('regionTranslating'));
    try {
      const out = await api<{ translation: string }>('/region/translate', { text });
      trans.value = out.translation;
      setStatus('');
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), true);
    } finally {
      setBusy(false);
    }
  });

  applyBtn.addEventListener('click', async () => {
    setBusy(true);
    setStatus(tr('regionApplying'));
    try {
      await commit([...others, { ...region, text: orig.value.trim(), translation: trans.value.trim() }, ...(seed?.extraCommit ?? [])]);
      close();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), true);
      setBusy(false);
    }
  });

  delBtn.addEventListener('click', async () => {
    setBusy(true);
    try {
      await commit(others);
      close();
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), true);
      setBusy(false);
    }
  });

  // A brand-new region with no seed text supplied: read its text right away.
  // A seeded open (moving a bubble) already knows the text — skip OCR.
  if (seed) {
    trans.focus();
  } else if (!existing) {
    setBusy(true);
    orig.disabled = true;
    setStatus(tr('regionReading'));
    try {
      const source = await deps.fetchSource(rawUrl);
      if (!source) throw new Error(tr('regionNoImage'));
      const out = await api<{ text: string; warning?: string | null }>('/region/ocr', { image: source, box });
      orig.value = out.text;
      setStatus(out.warning ? tr('regionOcrFailed') : '', !!out.warning);
    } catch (e) {
      setStatus(e instanceof Error ? e.message : String(e), true);
    } finally {
      orig.disabled = false;
      setBusy(false);
      (orig.value ? trans : orig).focus();
      place();
    }
  } else {
    trans.focus();
  }
}
