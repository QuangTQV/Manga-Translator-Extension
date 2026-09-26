// "Live AI" log viewer: a full-tab page (opened from the popup's Config tab)
// showing every LLM call the backend has made — prompt, response, timing —
// from GET /admin/live-ai-log, proxied by the service worker (which also
// attaches the stored account token, so an admin-gated hosted backend just
// works). The log holds real prompts and translations, so everything from it
// is rendered with textContent only, never as markup.
import { normalizeUiLanguage, t, type I18nKey, type UiLanguage } from '../shared/i18n.js';
import type { AppSettings, LiveAiLogEntry, LiveAiLogResult } from '../shared/types.js';

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

let lang: UiLanguage = 'en';
const cards: Card[] = []; // newest first, same order as the DOM
let newestTimestamp: number | undefined;
let inFlight = false;
let lastError: string | null = null;

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

function buildBody(entry: LiveAiLogEntry): HTMLElement {
  const body = document.createElement('div');
  body.className = 'card-body';
  if (entry.system_prompt) body.append(textSection(tt('liveAiSystemPrompt'), entry.system_prompt));
  body.append(textSection(tt('liveAiPrompt'), entry.prompt_text));
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

  await refresh(true);
}

void init();
