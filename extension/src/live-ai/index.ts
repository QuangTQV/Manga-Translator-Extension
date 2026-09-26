// "Live AI" log viewer: a full-tab page (opened from the popup's Config tab)
// showing every LLM call the backend has made — prompt, response, timing —
// from GET /admin/live-ai-log, proxied by the service worker (which also
// attaches the stored account token, so an admin-gated hosted backend just
// works). The log holds real prompts and translations, so everything from it
// is rendered with textContent only, never as markup.
import { normalizeUiLanguage, t, type I18nKey, type UiLanguage } from '../shared/i18n.js';
import type { AppSettings, LiveAiImageResult, LiveAiLogEntry, LiveAiLogSettings, LiveAiLogSettingsResult, LiveAiLogResult } from '../shared/types.js';

const POLL_INTERVAL_MS = 2_000;
const RELATIVE_TIME_TICK_MS = 10_000;
const PREFS_KEY = 'mtLiveAiViewerPrefs';

interface Card {
  entry: LiveAiLogEntry;
  el: HTMLElement;
  haystack: string; // lower-cased text the search box matches against
}

function qs<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing element #${id}`);
  return el as T;
}

const statusPill = qs<HTMLSpanElement>('status');
const refreshBtn = qs<HTMLButtonElement>('btn-refresh');
const autoToggle = qs<HTMLInputElement>('auto');
const limitSelect = qs<HTMLSelectElement>('limit');
const typeFilter = qs<HTMLSelectElement>('type-filter');
const statusFilter = qs<HTMLSelectElement>('status-filter');
const searchInput = qs<HTMLInputElement>('search');
const clearBtn = qs<HTMLButtonElement>('btn-clear');
const summaryEl = qs<HTMLDivElement>('summary');
const bannerEl = qs<HTMLDivElement>('banner');
const emptyEl = qs<HTMLDivElement>('empty');
const listEl = qs<HTMLElement>('list');
const saveImagesToggle = qs<HTMLInputElement>('save-images');
const saveImagesLabel = qs<HTMLLabelElement>('save-images-label');
const imagesNote = qs<HTMLDivElement>('images-note');
const lightbox = qs<HTMLDivElement>('lightbox');
const lightboxImg = qs<HTMLImageElement>('lightbox-img');
const lightboxCaption = qs<HTMLDivElement>('lightbox-caption');
const lightboxClose = qs<HTMLButtonElement>('lightbox-close');

let lang: UiLanguage = 'en';
const cards: Card[] = []; // newest first, same order as the DOM
let newestTimestamp: number | undefined;
let inFlight = false;
let lastError: string | null = null;
let logSettings: LiveAiLogSettings | null = null;

const TYPE_CLASS: Record<string, string> = {
  translate: 't-translate',
  ocr_region: 't-region',
  translate_region: 't-region',
  suggest_instructions: 't-suggest',
  story_db_update: 't-suggest',
  support_chat: 't-chat',
  test_key: 't-test',
};

function tt(key: I18nKey, vars: Record<string, string | number> = {}): string {
  return t(lang, key, vars);
}

function applyI18n(): void {
  document.documentElement.lang = lang;
  document.title = tt('liveAiTitle');
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n as I18nKey | undefined;
    if (key) el.textContent = tt(key);
  });
  document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
    const key = el.dataset.i18nPlaceholder as I18nKey | undefined;
    if (key) el.placeholder = tt(key);
  });
  saveImagesLabel.title = tt('liveAiSaveImagesHint');
}

// ── formatting ──────────────────────────────────────────────────────────────

function formatLatency(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function relativeTime(timestampSeconds: number): string {
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: 'auto' });
  const seconds = Math.round(Date.now() / 1000 - timestampSeconds);
  if (seconds < 60) return rtf.format(-Math.max(seconds, 0), 'second');
  if (seconds < 3600) return rtf.format(-Math.round(seconds / 60), 'minute');
  if (seconds < 86400) return rtf.format(-Math.round(seconds / 3600), 'hour');
  return rtf.format(-Math.round(seconds / 86400), 'day');
}

function firstLine(text: string): string {
  return text.split('\n').find((line) => line.trim() !== '')?.trim() ?? '';
}

// ── one card ────────────────────────────────────────────────────────────────

function textSection(label: string, text: string, isError = false): HTMLElement {
  const section = document.createElement('div');
  section.className = 'section';

  const head = document.createElement('div');
  head.className = 'section-head';
  const title = document.createElement('span');
  title.className = `section-title${isError ? ' err' : ''}`;
  title.textContent = label;

  const pre = document.createElement('pre');
  pre.className = isError ? 'err' : '';
  // Prompts often start with a blank line; drop it for display (Copy still copies the original).
  pre.textContent = text.replace(/^\s*\n/, '');

  const expandBtn = document.createElement('button');
  expandBtn.type = 'button';
  expandBtn.textContent = tt('liveAiExpand');
  expandBtn.addEventListener('click', () => {
    const tall = pre.classList.toggle('tall');
    expandBtn.textContent = tt(tall ? 'liveAiCollapse' : 'liveAiExpand');
  });

  const copyBtn = document.createElement('button');
  copyBtn.type = 'button';
  copyBtn.textContent = tt('liveAiCopy');
  copyBtn.addEventListener('click', () => {
    void navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = tt('liveAiCopied');
      setTimeout(() => { copyBtn.textContent = tt('liveAiCopy'); }, 1200);
    }).catch(() => { /* clipboard blocked: nothing useful to do */ });
  });

  head.append(title, expandBtn, copyBtn);
  section.append(head, pre);
  return section;
}

// ── images sent to the model (only for calls made with "Save images" on) ────

const imageCache = new Map<string, string>(); // id -> data URL
const IMAGE_CACHE_LIMIT = 40; // pages can be megabytes; don't keep every one forever

async function loadImage(id: string): Promise<LiveAiImageResult> {
  const cached = imageCache.get(id);
  if (cached) return { ok: true, dataUrl: cached };
  const result = (await chrome.runtime.sendMessage({ type: 'LIVE_AI_IMAGE', id })) as LiveAiImageResult | undefined;
  if (result?.ok && result.dataUrl) {
    imageCache.set(id, result.dataUrl);
    if (imageCache.size > IMAGE_CACHE_LIMIT) imageCache.delete(imageCache.keys().next().value as string);
  }
  return result ?? { ok: false, error: 'No response from the extension' };
}

let lightboxItems: { dataUrl: string; caption: string }[] = [];
let lightboxIndex = 0;

function showLightbox(items: { dataUrl: string; caption: string }[], index: number): void {
  lightboxItems = items;
  lightboxIndex = index;
  const item = items[index];
  lightboxImg.src = item.dataUrl;
  lightboxCaption.textContent = `${item.caption}${items.length > 1 ? `  ·  ${index + 1} / ${items.length}  (← →)` : ''}`;
  lightbox.hidden = false;
}

function closeLightbox(): void {
  lightbox.hidden = true;
  lightboxImg.removeAttribute('src');
}

function imagesSection(entry: LiveAiLogEntry): HTMLElement {
  const refs = entry.images ?? [];
  const section = document.createElement('div');
  section.className = 'section';
  const head = document.createElement('div');
  head.className = 'section-head';
  const title = document.createElement('span');
  title.className = 'section-title';
  title.textContent = tt('liveAiImagesTitle', { n: refs.length });
  head.append(title);
  const grid = document.createElement('div');
  grid.className = 'thumbs';

  // Filled in as each image arrives; the lightbox pages through the ones that loaded.
  const loaded: ({ dataUrl: string; caption: string } | null)[] = refs.map(() => null);
  refs.forEach((ref, i) => {
    const thumb = document.createElement('button');
    thumb.type = 'button';
    thumb.className = 'thumb';
    const placeholder = document.createElement('div');
    placeholder.className = 'thumb-ph';
    placeholder.textContent = '…';
    const label = document.createElement('div');
    label.className = 'thumb-label';
    label.textContent = `#${i + 1} · ${Math.round(ref.kb)} KB`;
    thumb.append(placeholder, label);
    grid.append(thumb);

    void loadImage(ref.id).then((result) => {
      if (!result.ok || !result.dataUrl) {
        placeholder.textContent = tt('liveAiImageGone');
        thumb.disabled = true;
        return;
      }
      const img = document.createElement('img');
      img.alt = `#${i + 1}`;
      img.addEventListener('load', () => {
        label.textContent = `#${i + 1} · ${img.naturalWidth}×${img.naturalHeight} · ${Math.round(ref.kb)} KB`;
        loaded[i] = { dataUrl: result.dataUrl as string, caption: label.textContent ?? '' };
      });
      img.src = result.dataUrl;
      placeholder.replaceWith(img);
      thumb.addEventListener('click', () => {
        const items = loaded.filter((item): item is { dataUrl: string; caption: string } => item !== null);
        const own = loaded[i];
        showLightbox(items, own ? items.indexOf(own) : 0);
      });
    });
  });
  section.append(head, grid);
  return section;
}

function buildBody(entry: LiveAiLogEntry): HTMLElement {
  const body = document.createElement('div');
  body.className = 'card-body';
  if (entry.system_prompt) body.append(textSection(tt('liveAiSystemPrompt'), entry.system_prompt));
  body.append(textSection(tt('liveAiPrompt'), entry.prompt_text));
  if (entry.images && entry.images.length > 0) {
    body.append(imagesSection(entry));
  } else if (entry.images_count > 0) {
    const note = document.createElement('div');
    note.className = 'section note';
    note.textContent = tt('liveAiImagesNotSaved');
    body.append(note);
  }
  if (entry.error) body.append(textSection(tt('liveAiError'), entry.error, true));
  if (entry.response_text) body.append(textSection(tt('liveAiResponse'), entry.response_text));
  return body;
}

function buildCard(entry: LiveAiLogEntry, fresh: boolean): Card {
  const el = document.createElement('article');
  el.className = `card${entry.error ? ' error' : ''}${fresh ? ' fresh' : ''}`;

  const head = document.createElement('button');
  head.type = 'button';
  head.className = 'card-head';
  head.setAttribute('aria-expanded', 'false');

  const chev = document.createElement('span');
  chev.className = 'chev';
  chev.textContent = '▸';

  const badge = document.createElement('span');
  badge.className = `badge ${TYPE_CLASS[entry.call_type] ?? ''}`.trim();
  badge.textContent = entry.call_type;

  const who = document.createElement('span');
  who.className = 'who';
  who.textContent = entry.model ? `${entry.provider} · ${entry.model}` : entry.provider;
  who.title = who.textContent;

  const preview = document.createElement('span');
  preview.className = 'preview';
  preview.textContent = firstLine(entry.error || entry.response_text || entry.prompt_text);

  const meta = document.createElement('span');
  meta.className = 'meta';
  const latency = document.createElement('span');
  latency.className = 'lat';
  latency.textContent = formatLatency(entry.latency_ms);
  meta.append(latency);
  if (entry.images_count > 0) {
    const images = document.createElement('span');
    images.className = 'imgs';
    images.textContent = tt('liveAiImages', { n: entry.images_count, kb: Math.round(entry.images_kb) });
    meta.append(images);
  }
  const time = document.createElement('time');
  time.dataset.ts = String(entry.timestamp);
  time.title = new Date(entry.timestamp * 1000).toLocaleString(lang);
  time.textContent = relativeTime(entry.timestamp);
  meta.append(time);

  head.append(chev, badge, who, preview, meta);
  el.append(head);

  // The (potentially large) body is only built the first time it's opened,
  // so a thousand collapsed cards stay cheap.
  let body: HTMLElement | null = null;
  head.addEventListener('click', () => {
    const open = !el.classList.contains('open');
    el.classList.toggle('open', open);
    head.setAttribute('aria-expanded', String(open));
    if (open && !body) {
      body = buildBody(entry);
      el.append(body);
    }
    if (body) body.hidden = !open;
  });

  const haystack = [entry.call_type, entry.provider, entry.model, entry.system_prompt, entry.prompt_text, entry.response_text, entry.error]
    .filter((part): part is string => typeof part === 'string')
    .join('\n')
    .toLowerCase();
  return { entry, el, haystack };
}

// ── list state ──────────────────────────────────────────────────────────────

function clearList(): void {
  cards.length = 0;
  listEl.replaceChildren();
}

function refreshTypeOptions(): void {
  const types = Array.from(new Set(cards.map((c) => c.entry.call_type))).sort();
  const selected = typeFilter.value || 'all';
  const options = [new Option(tt('liveAiAllTypes'), 'all'), ...types.map((type) => new Option(type, type))];
  typeFilter.replaceChildren(...options);
  typeFilter.value = types.includes(selected) || selected === 'all' ? selected : 'all';
}

function applyFilters(): void {
  const type = typeFilter.value || 'all';
  const errorsOnly = statusFilter.value === 'errors';
  const needle = searchInput.value.trim().toLowerCase();
  let shown = 0;
  let errors = 0;
  let latencySum = 0;
  for (const card of cards) {
    const visible =
      (type === 'all' || card.entry.call_type === type) &&
      (!errorsOnly || Boolean(card.entry.error)) &&
      (needle === '' || card.haystack.includes(needle));
    card.el.hidden = !visible;
    if (visible) {
      shown += 1;
      latencySum += card.entry.latency_ms;
      if (card.entry.error) errors += 1;
    }
  }
  summaryEl.textContent = cards.length === 0
    ? ''
    : tt('liveAiSummary', { shown, total: cards.length, errors, avg: shown ? formatLatency(latencySum / shown) : '—' });

  const showEmpty = shown === 0 && lastError === null;
  emptyEl.classList.toggle('show', showEmpty);
  emptyEl.textContent = showEmpty ? tt(cards.length === 0 ? 'liveAiEmpty' : 'liveAiNoMatch') : '';
}

function setStatus(state: 'live' | 'paused' | 'error'): void {
  statusPill.className = `pill ${state === 'paused' ? '' : state}`.trim();
  statusPill.textContent = tt(state === 'live' ? 'liveAiStatusLive' : state === 'paused' ? 'liveAiStatusPaused' : 'liveAiStatusError');
}

function syncStatus(): void {
  setStatus(lastError !== null ? 'error' : autoToggle.checked ? 'live' : 'paused');
}

function showError(message: string | null): void {
  lastError = message;
  bannerEl.classList.toggle('show', message !== null);
  bannerEl.textContent = message ?? '';
  syncStatus();
}

function errorMessage(result: LiveAiLogResult): string {
  if (result.status === 404) return tt('liveAiDisabled');
  if (result.status === 401) return tt('liveAiNeedLogin');
  if (result.status === 403) return tt('liveAiForbidden');
  return result.error ?? 'Unknown error';
}

// ── fetching ────────────────────────────────────────────────────────────────

function ingest(received: LiveAiLogEntry[], initial: boolean, limit: number): void {
  if (initial) clearList();
  // A backend from before `since` existed ignores it and sends everything
  // again; only what is newer than the newest entry already shown is new.
  const seenUpTo = newestTimestamp;
  const entries = initial || seenUpTo === undefined ? received : received.filter((e) => e.timestamp > seenUpTo);
  // `entries` is newest first; prepending oldest-to-newest keeps the newest on top.
  for (const entry of [...entries].reverse()) {
    const card = buildCard(entry, !initial);
    cards.unshift(card);
    listEl.prepend(card.el);
  }
  if (entries.length > 0) newestTimestamp = Math.max(newestTimestamp ?? 0, entries[0].timestamp);
  while (cards.length > limit) cards.pop()?.el.remove();
  refreshTypeOptions();
  applyFilters();
}

async function refresh(initial = false): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  try {
    const limit = Number(limitSelect.value);
    const since = initial ? undefined : newestTimestamp;
    const result = (await chrome.runtime.sendMessage({ type: 'LIVE_AI_LOG', limit, since })) as LiveAiLogResult | undefined;
    if (!result || !result.ok) {
      showError(errorMessage(result ?? { ok: false, error: 'No response from the extension' }));
      applyFilters();
      return;
    }
    showError(null);
    ingest(result.entries ?? [], initial, limit);
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  } finally {
    inFlight = false;
  }
}

// ── "Save images" switch ────────────────────────────────────────────────────

function renderImagesNote(): void {
  const on = logSettings?.images === true;
  saveImagesToggle.checked = on;
  imagesNote.classList.toggle('on', on);
  imagesNote.textContent = logSettings ? (on ? tt('liveAiImagesOnNote', { mb: logSettings.images_max_mb }) : tt('liveAiImagesOffNote')) : '';
}

async function loadLogSettings(): Promise<void> {
  const result = (await chrome.runtime.sendMessage({ type: 'LIVE_AI_LOG_SETTINGS' })) as LiveAiLogSettingsResult | undefined;
  if (result?.ok && result.settings) logSettings = result.settings;
  renderImagesNote();
}

async function changeSaveImages(images: boolean): Promise<void> {
  saveImagesToggle.disabled = true;
  try {
    const result = (await chrome.runtime.sendMessage({ type: 'LIVE_AI_LOG_SETTINGS', images })) as LiveAiLogSettingsResult | undefined;
    if (result?.ok && result.settings) {
      logSettings = result.settings;
    } else {
      showError(errorMessage({ ok: false, status: result?.status, error: result?.error }));
    }
  } finally {
    saveImagesToggle.disabled = false;
    renderImagesNote(); // reflects what the backend actually says, also after a failure
  }
}

// ── prefs ───────────────────────────────────────────────────────────────────

function loadPrefs(): void {
  try {
    const prefs = JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as { limit?: string; auto?: boolean };
    if (prefs.limit && Array.from(limitSelect.options).some((o) => o.value === prefs.limit)) limitSelect.value = prefs.limit;
    if (typeof prefs.auto === 'boolean') autoToggle.checked = prefs.auto;
  } catch { /* storage unavailable: defaults are fine */ }
}

function savePrefs(): void {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ limit: limitSelect.value, auto: autoToggle.checked }));
  } catch { /* ignore */ }
}

// ── wiring ──────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
  const response = (await chrome.runtime.sendMessage({ type: 'GET_SETTINGS' })) as { settings?: AppSettings } | undefined;
  lang = normalizeUiLanguage(response?.settings?.uiLanguage);
  applyI18n();
  loadPrefs();
  refreshTypeOptions();
  syncStatus();

  refreshBtn.addEventListener('click', () => { void refresh(false); });
  saveImagesToggle.addEventListener('change', () => { void changeSaveImages(saveImagesToggle.checked); });
  lightbox.addEventListener('click', closeLightbox); // anywhere, including the image
  lightboxClose.addEventListener('click', (ev) => { ev.stopPropagation(); closeLightbox(); });
  document.addEventListener('keydown', (ev) => {
    if (lightbox.hidden) return;
    if (ev.key === 'Escape') closeLightbox();
    else if (ev.key === 'ArrowRight' && lightboxItems.length > 1) showLightbox(lightboxItems, (lightboxIndex + 1) % lightboxItems.length);
    else if (ev.key === 'ArrowLeft' && lightboxItems.length > 1) showLightbox(lightboxItems, (lightboxIndex - 1 + lightboxItems.length) % lightboxItems.length);
  });
  autoToggle.addEventListener('change', () => { savePrefs(); syncStatus(); if (autoToggle.checked) void refresh(false); });
  limitSelect.addEventListener('change', () => { savePrefs(); newestTimestamp = undefined; void refresh(true); });
  for (const el of [typeFilter, statusFilter]) el.addEventListener('change', applyFilters);
  searchInput.addEventListener('input', applyFilters);
  clearBtn.addEventListener('click', () => {
    // Only hides what's already there; polling continues from the newest
    // entry seen, so just new calls appear afterwards.
    clearList();
    refreshTypeOptions();
    applyFilters();
  });

  setInterval(() => {
    if (autoToggle.checked && !document.hidden) void refresh(false);
  }, POLL_INTERVAL_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && autoToggle.checked) void refresh(false);
  });
  setInterval(() => {
    listEl.querySelectorAll<HTMLTimeElement>('time[data-ts]').forEach((el) => {
      el.textContent = relativeTime(Number(el.dataset.ts));
    });
  }, RELATIVE_TIME_TICK_MS);

  await Promise.all([refresh(true), loadLogSettings()]);
}

void init();
