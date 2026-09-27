// Manual region tool: the user drags a box over a spot on a page image, we read
// the text in it (backend OCR), and they either type a translation or ask the
// AI — then the spot is cleaned and the translation drawn over it.
//
// Regions are always rendered onto the page's *base* image (the auto-translated
// page if there is one, otherwise the untouched source), never onto an earlier
// manual result, so editing/deleting a region is exact and repeatable. They are
// persisted per page URL and re-applied after an (auto-)translation lands.

import { toggleStyleMarker } from '../shared/text-style.js';
import type { RegionBoxNorm, StoredRegion } from '../shared/types.js';
import { STYLE_CSS, StyleControls, styleHtml, styleToApi } from './region-style.js';

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
  /** Called every time a page's manual regions have been (re)drawn, with the regions now on it —
   * so the page can make each one hoverable/clickable like a detected bubble. */
  onRegionsChanged(img: HTMLImageElement, rawUrl: string, regions: StoredRegion[]): void;
  tr(key: string, vars?: Record<string, string | number>): string;
  toast(message: string, isError?: boolean): void;
  /** Font packs the backend can draw with (for the per-region font picker); empty if it can't be reached. */
  listFonts(): Promise<string[]>;
}

/** A drawn region the backend had something to say about (see RegionWarning in backend/schemas.py). */
interface RegionWarning { region: number; code: string; font: string; chars: string }

const STORAGE_KEY = 'mtManualRegions';
const MAX_STORED_PAGES = 200;
const MIN_IMAGE_W = 150;
const MIN_IMAGE_H = 100;
const Z = '2147483647';

let deps: RegionToolDeps;
const sessionRegions = new Map<string, StoredRegion[]>(); // rawUrl -> regions
const sessionEraseMasks = new Map<string, string | undefined>(); // rawUrl -> cumulative eraser mask (base64 PNG)
let selecting = false;
let closeEditor: (() => void) | null = null;
export function initRegionTool(d: RegionToolDeps): void {
  deps = d;
}

// ── persistence ──────────────────────────────────────────────────────────────

// eraseMask is one cumulative mask per page (every stroke ever applied,
// merged) rather than a list — re-rendering always starts from the
// untouched base and applies the whole mask in one inpaint pass, so strokes
// from different sessions never compound into repeated inpainting over
// already-inpainted pixels.
type Store = Record<string, { regions: StoredRegion[]; eraseMask?: string; updatedAt: number }>;

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

async function eraseMaskFor(rawUrl: string): Promise<string | undefined> {
  if (sessionEraseMasks.has(rawUrl)) return sessionEraseMasks.get(rawUrl);
  const key = pageKey(rawUrl);
  const stored = key ? (await readStore())[key]?.eraseMask : undefined;
  sessionEraseMasks.set(rawUrl, stored);
  return stored;
}

async function persistPage(rawUrl: string, regions: StoredRegion[], eraseMask: string | undefined): Promise<void> {
  sessionRegions.set(rawUrl, regions);
  sessionEraseMasks.set(rawUrl, eraseMask);
  const key = pageKey(rawUrl);
  if (!key) return;
  try {
    const store = await readStore();
    if (regions.length || eraseMask) store[key] = { regions, eraseMask, updatedAt: Date.now() };
    else delete store[key];
    const keys = Object.keys(store);
    if (keys.length > MAX_STORED_PAGES) {
      keys.sort((a, b) => store[a].updatedAt - store[b].updatedAt);
      for (const k of keys.slice(0, keys.length - MAX_STORED_PAGES)) delete store[k];
    }
    await chrome.storage.local.set({ [STORAGE_KEY]: store });
  } catch { /* storage is best-effort — the edit still applied this session */ }
}

async function saveRegions(rawUrl: string, regions: StoredRegion[]): Promise<void> {
  await persistPage(rawUrl, regions, await eraseMaskFor(rawUrl));
}

async function saveEraseMask(rawUrl: string, eraseMask: string | undefined): Promise<void> {
  await persistPage(rawUrl, await regionsFor(rawUrl), eraseMask);
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

/** Draws the page's saved eraser mask (if any) and `regions` onto the page's
 * base image and shows the result. The eraser mask is always applied first —
 * it's the "clean the raw" layer everything else sits on top of. */
async function renderPage(img: HTMLImageElement, rawUrl: string, regions: StoredRegion[]): Promise<RegionWarning[]> {
  const translated = deps.translatedBase(rawUrl);
  const eraseMask = await eraseMaskFor(rawUrl);
  if (!regions.length && !eraseMask) {
    if (translated) deps.applyImage(rawUrl, `data:image/png;base64,${translated}`);
    else deps.restoreOriginal(img);
    deps.onRegionsChanged(img, rawUrl, []);
    return [];
  }
  let warnings: RegionWarning[] = [];
  let base = translated ?? (await deps.fetchSource(rawUrl));
  if (!base) throw new Error(deps.tr('regionNoImage'));
  if (eraseMask) {
    base = (await api<{ image: string }>('/region/erase', { image: base, mask: eraseMask })).image;
  }
  if (regions.length) {
    // A restoreOnly region (deleting/moving a detected bubble) needs the real
    // pre-translation pixels for its box, which `base` alone doesn't have once
    // it's the already-translated page — fetch the untouched source too, only
    // when something actually needs it.
    let sourceImage: string | undefined;
    if (regions.some((r) => r.restoreOnly)) {
      sourceImage = translated ? (await deps.fetchSource(rawUrl)) ?? undefined : base;
      if (!sourceImage) throw new Error(deps.tr('regionNoImage'));
    }
    const rendered = await api<{ image: string; warnings?: RegionWarning[] }>('/region/render', {
      image: base,
      source_image: sourceImage,
      regions: regions.map((r) => ({ box: r.box, text: r.translation, restore_only: !!r.restoreOnly, style: styleToApi(r.style) })),
    });
    base = rendered.image;
    warnings = rendered.warnings ?? [];
  }
  deps.applyImage(rawUrl, `data:image/png;base64,${base}`);
  deps.onRegionsChanged(img, rawUrl, regions);
  return warnings;
}

/** Opens the editor on an existing manual region (from clicking its hit target on the page). */
export async function editManualRegion(img: HTMLImageElement, rawUrl: string, regionId: string): Promise<void> {
  const region = (await regionsFor(rawUrl)).find((r) => r.id === regionId);
  if (!region) return;
  const rect = img.getBoundingClientRect();
  const sel: Rect = {
    left: rect.left + region.box.x1 * rect.width,
    top: rect.top + region.box.y1 * rect.height,
    right: rect.left + region.box.x2 * rect.width,
    bottom: rect.top + region.box.y2 * rect.height,
  };
  await openEditor(img, rawUrl, sel, undefined, regionId);
}

/** Re-applies a page's saved regions/eraser mask (after an auto-translation replaced the overlay, or on load). */
export async function reapplyManualRegions(img: HTMLImageElement, rawUrl: string): Promise<void> {
  try {
    const regions = await regionsFor(rawUrl);
    const eraseMask = await eraseMaskFor(rawUrl);
    if (regions.length || eraseMask) await renderPage(img, rawUrl, regions);
  } catch (e) {
    console.log('[MT] reapplyManualRegions failed:', e);
  }
}

/** On page load: draw saved regions/eraser mask on images that aren't being auto-translated. */
export async function restoreManualRegionsOnLoad(): Promise<void> {
  const store = await readStore();
  if (!Object.keys(store).length) return;
  for (const img of Array.from(document.querySelectorAll<HTMLImageElement>('img'))) {
    if (img.hasAttribute('data-mt-translated')) continue;
    const rawUrl = deps.resolveUrl(img);
    const key = rawUrl ? pageKey(rawUrl) : null;
    if (!rawUrl || !key || !store[key]) continue;
    sessionRegions.set(rawUrl, store[key].regions);
    sessionEraseMasks.set(rawUrl, store[key].eraseMask);
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

export function findTargetImageForRect(sel: Rect): HTMLImageElement | null {
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
    const img = findTargetImageForRect(sel);
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
/** "Style" on a detected bubble: opens the editor on the bubble's own box with
 * its text filled in and the Text style section open. Applying it replaces the
 * bubble's drawing with a manual region (same box) carrying that style, and
 * puts the untouched art back first (a restoreOnly region) so the old text
 * can't show through. */
export function startStyleBubble(
  img: HTMLImageElement,
  rawUrl: string,
  box: RegionBoxNorm,
  text: string,
  translation: string,
  onCommitted: (text: string, translation: string) => void,
): void {
  const rect = img.getBoundingClientRect();
  const sel: Rect = {
    left: rect.left + box.x1 * rect.width,
    top: rect.top + box.y1 * rect.height,
    right: rect.left + box.x2 * rect.width,
    bottom: rect.top + box.y2 * rect.height,
  };
  void openEditor(img, rawUrl, sel, {
    text,
    translation,
    extraCommit: [{ id: crypto.randomUUID(), box, text: '', translation: '', restoreOnly: true }],
    openStyle: true,
    onCommitted,
  });
}

export async function deleteBubbleRegion(img: HTMLImageElement, rawUrl: string, box: RegionBoxNorm): Promise<void> {
  const regions = await regionsFor(rawUrl);
  const next = [...regions, { id: crypto.randomUUID(), box, text: '', translation: '', restoreOnly: true }];
  await renderPage(img, rawUrl, next);
  await saveRegions(rawUrl, next);
}

async function loadImageBitmap(base64Png: string): Promise<ImageBitmap> {
  const bytes = Uint8Array.from(atob(base64Png), (c) => c.charCodeAt(0));
  return createImageBitmap(new Blob([bytes], { type: 'image/png' }));
}

/** OR-composites two black/white masks (white = erase here) into one, at the
 * first mask's resolution. Used to fold a new eraser stroke into a page's
 * existing cumulative mask, so re-rendering only ever needs one inpaint pass
 * over one merged mask (see the `Store` type's eraseMask comment above). */
async function mergeMasks(a: string, b: string): Promise<string> {
  const [bitmapA, bitmapB] = await Promise.all([loadImageBitmap(a), loadImageBitmap(b)]);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmapA.width;
    canvas.height = bitmapA.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas unavailable');
    ctx.drawImage(bitmapA, 0, 0);
    ctx.globalCompositeOperation = 'lighter'; // additive blend == OR for a black/white mask
    ctx.drawImage(bitmapB, 0, 0, bitmapA.width, bitmapA.height);
    return canvas.toDataURL('image/png').replace(/^data:image\/png;base64,/, '');
  } finally {
    bitmapA.close();
    bitmapB.close();
  }
}

/**
 * The eraser tool: folds one freehand-brush stroke mask (a black/white PNG,
 * white = erase, at the target image's natural resolution — see
 * eraser-tool.ts) into the page's cumulative eraser mask and re-renders.
 * Idempotent-safe to retry with the same `strokeMask` if it throws (the
 * caller keeps the pending canvas until this resolves), since OR-merging the
 * same stroke twice into an already-saved mask is still correct.
 */
export async function applyEraseStroke(img: HTMLImageElement, rawUrl: string, strokeMask: string): Promise<void> {
  const existing = await eraseMaskFor(rawUrl);
  const merged = existing ? await mergeMasks(existing, strokeMask) : strokeMask;
  await saveEraseMask(rawUrl, merged);
  await renderPage(img, rawUrl, await regionsFor(rawUrl));
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
  /** Open the "Text style" section straight away (the reader came here to style this text). */
  openStyle?: boolean;
  /** Runs once Apply has succeeded — e.g. to drop the detected bubble this region replaces. */
  onCommitted?: (text: string, translation: string) => void;
}

async function openEditor(img: HTMLImageElement, rawUrl: string, sel: Rect, seed?: EditorSeed, editRegionId?: string): Promise<void> {
  closeEditor?.();
  const box = toNormBox(sel, img);
  const all = await regionsFor(rawUrl);
  // A seeded open (moving a bubble) always creates a fresh region at the new
  // spot — it's never "editing" whatever manual region happens to already
  // overlap the drop point.
  // Opened from a region's own hit target: that exact region, even where several overlap.
  const existing = seed ? null : (editRegionId ? all.find((r) => r.id === editRegionId) ?? null : overlapsExisting(box, all));
  const region: StoredRegion = existing ?? { id: crypto.randomUUID(), box, text: seed?.text ?? '', translation: seed?.translation ?? '' };
  const editingBox: RegionBoxNorm = { ...region.box };

  const outline = document.createElement('div');
  outline.setAttribute('popover', 'manual');
  outline.style.cssText = `position:fixed;z-index:${Z};border:2px solid #7aa2ff;border-radius:4px;pointer-events:none;box-sizing:border-box;`;

  const host = document.createElement('div');
  host.id = 'mt-region-editor';
  host.setAttribute('popover', 'manual');
  host.style.cssText = `position:fixed;z-index:${Z};width:330px;margin:0;border:0;padding:0;background:transparent;color:inherit;overflow:visible;inset:auto;max-width:none;`;
  const shadow = host.attachShadow({ mode: 'open' });
  const tr = deps.tr;
  shadow.innerHTML = `
    <style>
      .card{background:#0b1120;color:#dde6f5;border:1px solid #7aa2ff;border-radius:12px;padding:12px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5);display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 16px);overflow-y:auto;box-sizing:border-box}
      ${STYLE_CSS}
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
      button.style-btn{padding:4px 10px;font-weight:700}
      button.style-btn.bold{font-weight:900}
      button.style-btn.italic{font-style:italic}
      .spacer{flex:1}
      .status{font-size:11px;color:#9fb0cf;min-height:14px}
      .status.err{color:#f87171}
      .title-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
      details.region-list{border-top:1px solid rgba(122,162,255,.2);padding-top:6px}
      details.region-list summary{cursor:pointer;font-size:11px;color:#9fb0cf}
      .region-list-items{display:grid;gap:4px;max-height:120px;overflow:auto;margin-top:6px}
      .region-list-item{text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
      .region-list-item[aria-current=true]{border-color:#7aa2ff;background:rgba(122,162,255,.14)}
    </style>
    <div class="card">
      <div class="title-row"><div class="title">${tr('regionTitle')}</div><button id="resize-box" type="button" aria-pressed="false">${tr('regionResizeBox')}</button></div>
      <details class="region-list" id="region-list-box">
        <summary>${tr('regionListTitle')} (${all.filter((item) => !item.restoreOnly).length})</summary>
        <div class="region-list-items" id="region-list-items"></div>
      </details>
      <label>${tr('regionOriginalLabel')}</label>
      <textarea id="orig"></textarea>
      <div class="row"><button id="ai" type="button">${tr('regionTranslateAi')}</button></div>
      <div class="row" style="justify-content:space-between;align-items:center">
        <label style="margin:0">${tr('regionTranslationLabel')}</label>
        <div class="row" style="gap:4px">
          <button id="style-bold" class="style-btn bold" type="button" title="${tr('regionBoldTitle')}">B</button>
          <button id="style-italic" class="style-btn italic" type="button" title="${tr('regionItalicTitle')}">I</button>
        </div>
      </div>
      <textarea id="trans"></textarea>
      ${styleHtml(tr)}
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
  const boldBtn = $<HTMLButtonElement>('style-bold');
  const italicBtn = $<HTMLButtonElement>('style-italic');
  const applyBtn = $<HTMLButtonElement>('apply');
  const delBtn = $<HTMLButtonElement>('del');
  boldBtn.addEventListener('click', () => toggleStyleMarker(trans, '**'));
  italicBtn.addEventListener('click', () => toggleStyleMarker(trans, '*'));
  delBtn.style.display = existing ? '' : 'none';
  orig.value = region.text;
  trans.value = region.translation;

  // Per-region text style: prefilled from what was saved, open when there is
  // one (or the reader came from a bubble's Style button), fonts filled in as
  // soon as the backend answers.
  const styleControls = new StyleControls(shadow, tr);
  styleControls.set(region.style);
  if (styleControls.isCustomised() || seed?.openStyle) styleControls.open();
  void deps.listFonts().then((fonts) => { styleControls.setFonts(fonts, region.style?.font); place(); });

  const setStatus = (msg: string, err = false): void => { status.textContent = msg; status.classList.toggle('err', err); };
  const setBusy = (busy: boolean): void => { aiBtn.disabled = busy; applyBtn.disabled = busy; delBtn.disabled = busy; };

  const screenRect = (): Rect => {
    const bounds = img.getBoundingClientRect();
    return {
      left: bounds.left + editingBox.x1 * bounds.width,
      top: bounds.top + editingBox.y1 * bounds.height,
      right: bounds.left + editingBox.x2 * bounds.width,
      bottom: bounds.top + editingBox.y2 * bounds.height,
    };
  };
  const corners = ['nw', 'ne', 'sw', 'se'] as const;
  const handles = corners.map((corner) => {
    const handle = document.createElement('button');
    handle.type = 'button';
    handle.setAttribute('popover', 'manual');
    handle.className = 'mt-region-resize-handle';
    handle.dataset.corner = corner;
    handle.setAttribute('aria-label', tr('regionResizeHandle'));
    handle.style.cssText = `position:fixed;z-index:${Z};width:14px;height:14px;padding:0;border:2px solid #f8fafc;border-radius:3px;background:#2563eb;box-shadow:0 1px 5px #000;cursor:${corner === 'nw' || corner === 'se' ? 'nwse-resize' : 'nesw-resize'};transform:translate(-50%,-50%);`;
    handle.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      event.stopPropagation();
      handle.setPointerCapture(event.pointerId);
      const bounds = img.getBoundingClientRect();
      const initial = { ...editingBox };
      const minX = Math.min(0.02, 12 / Math.max(1, bounds.width));
      const minY = Math.min(0.02, 12 / Math.max(1, bounds.height));
      const onMove = (move: PointerEvent): void => {
        const x = Math.max(0, Math.min(1, (move.clientX - bounds.left) / bounds.width));
        const y = Math.max(0, Math.min(1, (move.clientY - bounds.top) / bounds.height));
        if (corner.includes('w')) editingBox.x1 = Math.min(x, initial.x2 - minX);
        else editingBox.x2 = Math.max(x, initial.x1 + minX);
        if (corner.includes('n')) editingBox.y1 = Math.min(y, initial.y2 - minY);
        else editingBox.y2 = Math.max(y, initial.y1 + minY);
        place();
      };
      const onUp = (): void => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onUp);
        handle.removeEventListener('pointercancel', onUp);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onUp);
      handle.addEventListener('pointercancel', onUp);
    });
    return handle;
  });

  // Place the editor beside the current box and keep the outline/handles
  // attached to its image-relative geometry as corners move.
  const place = (): void => {
    const rect = screenRect();
    outline.style.left = `${rect.left}px`;
    outline.style.top = `${rect.top}px`;
    outline.style.width = `${rect.right - rect.left}px`;
    outline.style.height = `${rect.bottom - rect.top}px`;
    const h = host.getBoundingClientRect().height || 260;
    let top = rect.bottom + 8;
    if (top + h > window.innerHeight - 8) top = rect.top - h - 8;
    top = Math.max(8, Math.min(top, window.innerHeight - h - 8));
    host.style.top = `${top}px`;
    host.style.left = `${Math.min(Math.max(8, rect.left), window.innerWidth - 338)}px`;
    const points: Record<(typeof corners)[number], [number, number]> = {
      nw: [rect.left, rect.top], ne: [rect.right, rect.top],
      sw: [rect.left, rect.bottom], se: [rect.right, rect.bottom],
    };
    handles.forEach((handle, index) => {
      const [x, y] = points[corners[index]];
      handle.style.left = `${x}px`;
      handle.style.top = `${y}px`;
    });
  };
  document.body.append(outline, host, ...handles);
  outline.showPopover();
  host.showPopover();
  const resizeToggle = $<HTMLButtonElement>('resize-box');
  resizeToggle.addEventListener('click', () => {
    const enabled = resizeToggle.getAttribute('aria-pressed') !== 'true';
    resizeToggle.setAttribute('aria-pressed', String(enabled));
    resizeToggle.textContent = tr(enabled ? 'regionResizeDone' : 'regionResizeBox');
    handles.forEach((handle) => {
      if (enabled) handle.showPopover();
      else handle.hidePopover();
    });
    place();
  });
  place();
  // The card grows and shrinks (the Text style section opening, the font list
  // arriving, a status line appearing): follow it.
  const resizeObserver = new ResizeObserver(() => place());
  resizeObserver.observe(host);

  const close = (): void => {
    resizeObserver.disconnect();
    try { outline.hidePopover(); } catch { /* already closed */ }
    try { host.hidePopover(); } catch { /* already closed */ }
    outline.remove();
    host.remove();
    handles.forEach((handle) => {
      try { handle.hidePopover(); } catch { /* not currently shown */ }
      handle.remove();
    });
    document.removeEventListener('keydown', onKey, true);
    if (closeEditor === close) closeEditor = null;
  };
  const onKey = (ev: KeyboardEvent): void => { if (ev.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey, true);
  closeEditor = close;
  $<HTMLButtonElement>('cancel').addEventListener('click', close);

  const regionListItems = $<HTMLDivElement>('region-list-items');
  const listedRegions = all.filter((item) => !item.restoreOnly);
  if (!listedRegions.length) {
    const empty = document.createElement('div');
    empty.className = 'status';
    empty.textContent = tr('regionListEmpty');
    regionListItems.append(empty);
  }
  for (const item of listedRegions) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'region-list-item';
    button.dataset.regionId = item.id;
    button.setAttribute('aria-current', String(item.id === region.id));
    button.textContent = `${item.text || tr('regionOriginalLabel')} → ${item.translation || '—'}`;
    regionListItems.append(button);
  }
  regionListItems.addEventListener('click', (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-region-id]');
    const id = button?.dataset.regionId;
    if (!id || id === region.id) return;
    close();
    void editManualRegion(img, rawUrl, id);
  });

  const others = all.filter((r) => r.id !== region.id);
  const commit = async (next: StoredRegion[]): Promise<void> => {
    const warnings = await renderPage(img, rawUrl, next);
    await saveRegions(rawUrl, next);
    // A font without the glyphs drops those characters; say so, or the reader
    // just sees a word with letters missing and no idea why.
    for (const warning of warnings) {
      if (warning.code === 'font_missing_glyphs') deps.toast(tr('regionStyleFontMissing', { font: warning.font, chars: warning.chars }), true);
    }
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
      await commit([...others, { ...region, box: editingBox, text: orig.value.trim(), translation: trans.value.trim(), style: styleControls.get() }, ...(seed?.extraCommit ?? [])]);
      seed?.onCommitted?.(orig.value.trim(), trans.value.trim());
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
