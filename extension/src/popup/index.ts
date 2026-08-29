import { DEFAULT_SETTINGS, PROVIDERS, SOURCE_LANGUAGES, TARGET_LANGUAGES, normalizeProviderGroups, stripLegacyProviderFields, type AppSettings, type BackupApiKeyEntry, type ProviderGroupConfig, type TranslateConfig } from '../shared/types.js';
import { UI_LANGUAGES, normalizeUiLanguage, t, type I18nKey, type UiLanguage } from '../shared/i18n.js';

const STORAGE_KEY = 'manga_translator_settings';

type StoredSettings = Partial<Omit<AppSettings, 'config'>> & {
  config?: Partial<AppSettings['config']>;
};

type HealthState = 'checking' | 'ok' | 'error' | 'offline';

function qs<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id) as T;
  if (!el) throw new Error(`Missing element: #${id}`);
  return el;
}

const extensionEnabledToggle = qs<HTMLInputElement>('f-extension-enabled');
const masterToggleRow = qs<HTMLDivElement>('master-toggle-row');
const backendInput = qs<HTMLInputElement>('f-backend');
const sourceInput = qs<HTMLInputElement>('f-source');
const targetInput = qs<HTMLInputElement>('f-target');
const sourceLanguageList = qs<HTMLDataListElement>('lang-source-list');
const targetLanguageList = qs<HTMLDataListElement>('lang-target-list');
const outsideTextToggle = qs<HTMLInputElement>('f-outside-text');
const preTranslateToggle = qs<HTMLInputElement>('f-pre-translate');
const previousContextToggle = qs<HTMLInputElement>('f-previous-context');
const contextMemoryToggle = qs<HTMLInputElement>('f-context-memory');
const contextMemorySequentialToggle = qs<HTMLInputElement>('f-context-memory-sequential');
const scanBtn = qs<HTMLButtonElement>('btn-scan');
const autoBtn = qs<HTMLButtonElement>('btn-auto');
const saveBtn = qs<HTMLButtonElement>('btn-save');
const saveConfigBtn = qs<HTMLButtonElement>('btn-save-config');
const clearCacheBtn = qs<HTMLButtonElement>('btn-clear-cache');

const providerGroupsList = qs<HTMLDivElement>('provider-groups-list');
const addProviderGroupBtn = qs<HTMLButtonElement>('btn-add-provider-group');
const duplicateKeyWarning = qs<HTMLDivElement>('duplicate-key-warning');
const tempSlider = qs<HTMLInputElement>('f-temp');
const topPSlider = qs<HTMLInputElement>('f-topp');
const topKSlider = qs<HTMLInputElement>('f-topk');
const tempVal = qs<HTMLSpanElement>('val-temp');
const topPVal = qs<HTMLSpanElement>('val-topp');
const topKVal = qs<HTMLSpanElement>('val-topk');
const reasoningEffortSelect = qs<HTMLSelectElement>('f-reasoning-effort');
const maxTokensInput = qs<HTMLInputElement>('f-max-tokens');
const imageDetailSelect = qs<HTMLSelectElement>('f-image-detail');
const rotationStrategySelect = qs<HTMLSelectElement>('f-rotation-strategy');
const cooldownSecondsInput = qs<HTMLInputElement>('f-cooldown-seconds');
const contextToggle = qs<HTMLInputElement>('f-context');
const instructionsInput = qs<HTMLTextAreaElement>('f-instructions');
const expandInstructionsBtn = qs<HTMLButtonElement>('btn-expand-instructions');
const suggestInstructionsBtn = qs<HTMLButtonElement>('btn-suggest-instructions');
const suggestWebSearchToggle = qs<HTMLInputElement>('f-suggest-web-search');
const suggestStoryTitleInput = qs<HTMLInputElement>('f-suggest-story-title');
const llmInstructionsInput = qs<HTMLTextAreaElement>('f-llm-instructions');
const saveLlmBtn = qs<HTMLButtonElement>('btn-save-llm');
const uiLanguageSelect = qs<HTMLSelectElement>('f-ui-language');

const healthBadge = qs<HTMLSpanElement>('health-badge');
const statusEl = qs<HTMLDivElement>('popup-status');
const urlDisplay = qs<HTMLDivElement>('backend-url-display');

let settings: AppSettings = normalizeSettings();
let uiLanguage: UiLanguage = 'en';
let healthState: HealthState = 'checking';
let isBound = false;
// blur/beforeunload trigger autoSave(), which persists whatever is currently
// in the form fields. Those listeners are registered before the async
// settings load resolves, so if the popup loses focus (or is closed) in
// that window, autoSave() would read the still-default/empty form and wipe
// the real saved settings (API keys included) in storage. Guard against it.
let settingsLoaded = false;

function normalizeSettings(raw?: StoredSettings): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(raw ?? {}),
    uiLanguage: normalizeUiLanguage(raw?.uiLanguage),
    config: {
      ...DEFAULT_SETTINGS.config,
      ...stripLegacyProviderFields(raw?.config),
      providerGroups: normalizeProviderGroups(raw?.config),
    },
  };
}

// Language names aren't run through per-UI-language translation here (unlike
// every other label in the popup) — the value picked/typed is sent to the
// backend verbatim as input_language/output_language, and some backend
// logic string-matches it in English (e.g. the Vietnamese-pronoun rules
// check for "vietnamese" in output_language). Translating the suggestion
// text would desync it from the value actually submitted, so the <datalist>
// suggestions are intentionally left in English across every UI language.
function populateLanguageDatalist(el: HTMLDataListElement, options: readonly string[]): void {
  el.replaceChildren();
  for (const optionValue of options) {
    const option = document.createElement('option');
    option.value = optionValue;
    // "Auto" behaves differently from every other entry (auto-detect, not
    // a fixed source language) and should stand out in the native
    // suggestion popup — <datalist> gives no way to color individual
    // entries (a hard cross-browser limitation), so a label prefix is the
    // only lever available here. `value` must stay exactly "Auto": the
    // backend matches it verbatim (input_language.strip().lower() ==
    // "auto"), so only the display label carries the marker.
    if (optionValue === 'Auto') option.label = '✦ Auto (auto-detect)';
    el.appendChild(option);
  }
}

function populateUiLanguageSelect(selected: UiLanguage): void {
  uiLanguageSelect.replaceChildren();
  for (const language of UI_LANGUAGES) {
    const option = document.createElement('option');
    option.value = language.code;
    option.textContent = `${language.nativeName} (${language.name})`;
    option.selected = language.code === selected;
    uiLanguageSelect.appendChild(option);
  }
}

// "Auto" (source-only, auto-detect) is visually called out with a distinct
// accent color so it reads as a deliberate mode, not just another
// language, since it behaves differently (the model infers the source
// language per-page instead of being told).
function updateSourceAutoStyle(): void {
  sourceInput.classList.toggle('lang-auto', sourceInput.value.trim().toLowerCase() === 'auto');
}

function renderLanguageSelects(): void {
  populateLanguageDatalist(sourceLanguageList, SOURCE_LANGUAGES);
  populateLanguageDatalist(targetLanguageList, TARGET_LANGUAGES);
  sourceInput.value = settings.config.inputLanguage;
  targetInput.value = settings.config.outputLanguage;
  updateSourceAutoStyle();
}

function setInstructionsExpandedState(expanded: boolean): void {
  instructionsInput.classList.toggle('textarea-expanded', expanded);
  expandInstructionsBtn.classList.toggle('active', expanded);
  expandInstructionsBtn.title = t(uiLanguage, expanded ? 'titleCollapseInstructions' : 'titleExpandInstructions');
}

function applyI18n(): void {
  document.documentElement.lang = uiLanguage;
  document.querySelectorAll<HTMLElement>('[data-i18n]').forEach((el) => {
    const key = el.dataset.i18n as I18nKey | undefined;
    if (key) el.textContent = t(uiLanguage, key);
  });
  document.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('[data-i18n-placeholder]').forEach((el) => {
    const key = el.dataset.i18nPlaceholder as I18nKey | undefined;
    if (key) el.placeholder = t(uiLanguage, key);
  });
  setHealthState(healthState);
  setAutoButtonState(autoBtn.classList.contains('active'));
  setInstructionsExpandedState(instructionsInput.classList.contains('textarea-expanded'));
}

function applyExtensionEnabledState(): void {
  const enabled = extensionEnabledToggle.checked;
  document.body.classList.toggle('mt-extension-disabled', !enabled);
  masterToggleRow.classList.toggle('disabled', !enabled);
}

function setHealthState(state: HealthState): void {
  healthState = state;
  healthBadge.className = state === 'ok' ? 'health-badge ok' : state === 'checking' ? 'health-badge' : 'health-badge err';
  const key: I18nKey =
    state === 'ok' ? 'healthOk' :
    state === 'error' ? 'healthError' :
    state === 'offline' ? 'healthOffline' :
    'healthChecking';
  healthBadge.textContent = t(uiLanguage, key);
}

// The per-key weight input only matters for "random" rotation (round_robin
// and sequential ignore it entirely) — hidden otherwise so it doesn't read
// as a control that's always in effect.
function updateRotationWeightVisibility(): void {
  providerGroupsList.classList.toggle('rotation-random', rotationStrategySelect.value === 'random');
}

function setAutoButtonState(active: boolean): void {
  autoBtn.classList.toggle('active', active);
  autoBtn.textContent = t(uiLanguage, active ? 'btnAutoOn' : 'btnAuto');
}

function initTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-pane').forEach((p) => p.classList.remove('active'));
      btn.classList.add('active');
      const pane = document.getElementById(`tab-${btn.dataset.tab}`);
      pane?.classList.add('active');
      await autoSave();
    });
  });
}

function initSliders(): void {
  tempSlider.addEventListener('input', () => { tempVal.textContent = Number(tempSlider.value).toFixed(2); });
  topPSlider.addEventListener('input', () => { topPVal.textContent = Number(topPSlider.value).toFixed(2); });
  topKSlider.addEventListener('input', () => { topKVal.textContent = topKSlider.value; });
}

async function init(): Promise<void> {
  initTabs();
  initSliders();
  window.addEventListener('blur', () => { void autoSave(); });
  window.addEventListener('beforeunload', () => { void autoSave(); });
  await loadAndBind();
}

async function loadAndBind(): Promise<void> {
  settings = await getSettings();
  uiLanguage = settings.uiLanguage;

  populateUiLanguageSelect(settings.uiLanguage);
  applyI18n();

  extensionEnabledToggle.checked = settings.extensionEnabled;
  applyExtensionEnabledState();

  backendInput.value = settings.backendUrl;
  urlDisplay.textContent = settings.backendUrl.replace(/^https?:\/\//, '');
  renderLanguageSelects();
  outsideTextToggle.checked = settings.config.outsideTextEnabled ?? false;
  preTranslateToggle.checked = settings.config.preTranslate ?? false;
  previousContextToggle.checked = settings.config.previousContextEnabled ?? false;
  contextMemoryToggle.checked = settings.config.contextMemoryEnabled ?? false;
  contextMemorySequentialToggle.checked = settings.config.contextMemorySequential ?? true;

  renderProviderGroups(settings.config.providerGroups ?? []);
  updateDuplicateKeyWarning();
  tempSlider.value = String(settings.config.temperature);
  topPSlider.value = String(settings.config.topP);
  topKSlider.value = String(settings.config.topK);
  reasoningEffortSelect.value = settings.config.reasoningEffort ?? '';
  maxTokensInput.value = settings.config.maxTokens != null ? String(settings.config.maxTokens) : '';
  imageDetailSelect.value = settings.config.imageDetail || 'auto';
  rotationStrategySelect.value = settings.config.rotationStrategy || 'round_robin';
  updateRotationWeightVisibility();
  cooldownSecondsInput.value = String(settings.config.cooldownSeconds ?? 15);
  tempVal.textContent = Number(settings.config.temperature).toFixed(2);
  topPVal.textContent = Number(settings.config.topP).toFixed(2);
  topKVal.textContent = String(settings.config.topK);
  contextToggle.checked = settings.config.sendFullPageContext;
  instructionsInput.value = settings.config.specialInstructions ?? '';
  llmInstructionsInput.value = settings.config.llmInstructions ?? '';

  settingsLoaded = true;
  bind();
  await checkHealth(settings.backendUrl);
}

function bind(): void {
  if (isBound) return;
  isBound = true;

  saveBtn.addEventListener('click', async () => { await saveAndReport('statusSettingsSaved'); });
  saveConfigBtn.addEventListener('click', async () => { await saveAndReport('statusSettingsSaved'); });
  saveLlmBtn.addEventListener('click', async () => { await saveAndReport('statusLlmSettingsSaved'); });

  extensionEnabledToggle.addEventListener('change', () => {
    applyExtensionEnabledState();
    void autoSave();
    if (!extensionEnabledToggle.checked) {
      // Stop any auto-translate loop already running in the active tab
      // immediately, rather than waiting for it to hit the background's
      // disabled-check on its next request.
      void chrome.tabs.query({ active: true, currentWindow: true }).then(([tab]) => {
        if (tab?.id) void chrome.tabs.sendMessage(tab.id, { type: 'STOP_AUTO_TRANSLATE' }).catch(() => {});
      });
    }
  });

  for (const el of [backendInput, sourceInput, targetInput, outsideTextToggle, preTranslateToggle, previousContextToggle, contextMemoryToggle, contextMemorySequentialToggle]) {
    el.addEventListener('change', () => { void autoSave(); });
  }
  sourceInput.addEventListener('input', updateSourceAutoStyle);

  uiLanguageSelect.addEventListener('change', () => {
    uiLanguage = normalizeUiLanguage(uiLanguageSelect.value);
    settings = collectAllSettings();
    applyI18n();
    renderLanguageSelects();
    void autoSave();
  });

  for (const el of [instructionsInput, llmInstructionsInput]) {
    el.addEventListener('change', () => { void autoSave(); });
  }
  reasoningEffortSelect.addEventListener('change', () => { void autoSave(); });
  maxTokensInput.addEventListener('change', () => { void autoSave(); });
  imageDetailSelect.addEventListener('change', () => { void autoSave(); });
  rotationStrategySelect.addEventListener('change', () => { updateRotationWeightVisibility(); void autoSave(); });
  cooldownSecondsInput.addEventListener('change', () => { void autoSave(); });
  for (const el of [tempSlider, topPSlider, topKSlider, contextToggle]) {
    el.addEventListener('change', () => { void autoSave(); });
  }
  addProviderGroupBtn.addEventListener('click', () => {
    providerGroupsList.appendChild(createProviderGroupRow());
    syncMoveButtons(providerGroupsList, 'fallback-provider-row');
    updateDuplicateKeyWarning();
  });

  scanBtn.addEventListener('click', async () => {
    scanBtn.disabled = true;
    setStatus(t(uiLanguage, 'statusOpeningScanner'), '');
    try {
      await autoSave();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error(t(uiLanguage, 'errorNoActiveTab'));
      const injected = await ensureContentScript(tab.id);
      if (!injected) throw new Error(t(uiLanguage, 'errorInjectContent'));
      const opened = await chrome.tabs.sendMessage(tab.id, { type: 'OPEN_SCANNER' });
      if (!opened?.ok) throw new Error(opened?.error ?? t(uiLanguage, 'errorScannerFailed'));
      setStatus(t(uiLanguage, 'statusScannerOpened'), 'ok');
      window.close();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), 'err');
      scanBtn.disabled = false;
    }
  });

  autoBtn.addEventListener('click', async () => {
    autoBtn.disabled = true;
    try {
      await autoSave();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error(t(uiLanguage, 'errorNoActiveTab'));
      const injected = await ensureContentScript(tab.id);
      if (!injected) throw new Error(t(uiLanguage, 'errorInjectContent'));
      if (autoBtn.classList.contains('active')) {
        setStatus(t(uiLanguage, 'statusStoppingAuto'), '');
        await chrome.tabs.sendMessage(tab.id, { type: 'STOP_AUTO_TRANSLATE' });
        setStatus(t(uiLanguage, 'statusAutoStopped'), 'ok');
        setAutoButtonState(false);
      } else {
        setStatus(t(uiLanguage, 'statusStartingAuto'), '');
        await chrome.tabs.sendMessage(tab.id, { type: 'START_AUTO_TRANSLATE' });
        setStatus(t(uiLanguage, 'statusAutoActive'), 'ok');
        setAutoButtonState(true);
      }
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      autoBtn.disabled = false;
    }
  });

  clearCacheBtn.addEventListener('click', async () => {
    clearCacheBtn.disabled = true;
    setStatus(t(uiLanguage, 'statusClearingCache'), '');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id) {
        await ensureContentScript(tab.id);
        await chrome.tabs.sendMessage(tab.id, { type: 'CLEAR_CACHE' } as never);
      }
      setStatus(t(uiLanguage, 'statusCacheCleared'), 'ok');
      setTimeout(() => { clearCacheBtn.disabled = false; }, 2000);
    } catch {
      setStatus(t(uiLanguage, 'statusCacheCleared'), 'ok');
      clearCacheBtn.disabled = false;
    }
  });

  expandInstructionsBtn.addEventListener('click', () => {
    setInstructionsExpandedState(!instructionsInput.classList.contains('textarea-expanded'));
  });

  suggestInstructionsBtn.addEventListener('click', async () => {
    suggestInstructionsBtn.disabled = true;
    setStatus(t(uiLanguage, 'statusSuggestingInstructions'), '');
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error(t(uiLanguage, 'errorNoActiveTab'));
      const injected = await ensureContentScript(tab.id);
      if (!injected) throw new Error(t(uiLanguage, 'errorInjectContent'));

      const result = await chrome.tabs.sendMessage(tab.id, {
        type: 'SUGGEST_FROM_SCAN',
        enableWebSearch: suggestWebSearchToggle.checked,
        storyTitle: suggestStoryTitleInput.value.trim() || undefined,
      } as never) as { ok: boolean; error?: string };
      if (!result?.ok) {
        throw new Error(result?.error || t(uiLanguage, 'errorNoScanFound'));
      }

      // The content script wrote directly to storage — re-read it so the
      // popup's in-memory settings and the textarea both reflect it.
      settings = await getSettings();
      instructionsInput.value = settings.config.specialInstructions ?? '';
      setStatus(t(uiLanguage, 'statusSuggestInstructionsDone'), 'ok');
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), 'err');
    } finally {
      suggestInstructionsBtn.disabled = false;
    }
  });

  void refreshAutoTranslateStatus();
}

async function saveAndReport(successKey: I18nKey): Promise<void> {
  setStatus(t(uiLanguage, 'statusSaving'), '');
  const saved = await autoSave();
  if (saved) {
    urlDisplay.textContent = settings.backendUrl.replace(/^https?:\/\//, '');
    setStatus(t(uiLanguage, successKey), 'ok');
    await checkHealth(settings.backendUrl);
  } else {
    setStatus(t(uiLanguage, 'statusSaveFailed'), 'err');
  }
}

async function refreshAutoTranslateStatus(): Promise<void> {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab?.id) {
      await ensureContentScript(tab.id);
      const status = await chrome.tabs.sendMessage(tab.id, { type: 'GET_AUTO_TRANSLATE_STATUS' });
      if (status?.active) setAutoButtonState(true);
    }
  } catch {
    /* ignore */
  }
}

// Duplicated within the same provider+model is flagged (rotating between
// two identical accounts wastes a request instead of reaching fresh
// quota — the backend silently skips the repeat anyway). The same key
// against a *different* model is NOT flagged: many providers meter rate
// limits per model, so reusing one account across two models is a
// legitimate way to get two independent rotation candidates, not a
// mistake — matches the backend's own (provider, key, model) dedup scope.
function updateDuplicateKeyWarning(): void {
  const seenByBucket = new Map<string, Set<string>>();
  const dupInfoByBucket = new Map<string, { provider: string; model?: string; count: number }>();

  function check(provider: string, model: string | undefined, rawKey: string): void {
    const key = rawKey.trim();
    if (!key) return;
    const bucket = `${provider} ${model ?? ''}`;
    let seen = seenByBucket.get(bucket);
    if (!seen) { seen = new Set(); seenByBucket.set(bucket, seen); }
    if (seen.has(key)) {
      const info = dupInfoByBucket.get(bucket) ?? { provider, model, count: 0 };
      info.count += 1;
      dupInfoByBucket.set(bucket, info);
    } else {
      seen.add(key);
    }
  }

  for (const group of collectProviderGroups()) {
    for (const entry of group.apiKeys) check(group.provider, group.modelName, entry.key);
  }

  const lines = Array.from(dupInfoByBucket.values())
    .map(({ provider, model, count }) => t(uiLanguage, 'warningDuplicateKeys', {
      provider: model ? `${provider} (${model})` : provider,
      count,
    }));

  duplicateKeyWarning.style.display = lines.length ? 'block' : 'none';
  duplicateKeyWarning.textContent = lines.join(' ');
}

// Order matters for the "sequential" rotation strategy (always starts at
// the first entry, only advancing on failure) — these let the user drag a
// key/provider to the front instead of deleting and re-adding everything
// in the right order. Works for any row type sharing a `rowClass`: the top-
// level API Keys list, each fallback provider's own nested key list, and
// the fallback-provider list itself.
function syncMoveButtons(container: HTMLElement, rowClass: string): void {
  const rows = Array.from(container.children) as HTMLElement[];
  rows.forEach((row, i) => {
    if (!row.classList.contains(rowClass)) return;
    const up = row.querySelector<HTMLButtonElement>('.btn-move-up');
    const down = row.querySelector<HTMLButtonElement>('.btn-move-down');
    if (up) up.disabled = i === 0;
    if (down) down.disabled = i === rows.length - 1;
  });
}

function moveRow(row: HTMLElement, direction: -1 | 1, rowClass: string): void {
  const parent = row.parentElement;
  if (!parent) return;
  if (direction === -1 && row.previousElementSibling) {
    parent.insertBefore(row, row.previousElementSibling);
  } else if (direction === 1 && row.nextElementSibling) {
    parent.insertBefore(row.nextElementSibling, row);
  }
  syncMoveButtons(parent, rowClass);
  updateDuplicateKeyWarning();
  void autoSave();
}

function createMoveButtons(row: HTMLElement, rowClass: string): [HTMLButtonElement, HTMLButtonElement] {
  const upBtn = document.createElement('button');
  upBtn.type = 'button';
  upBtn.className = 'btn-move btn-move-up';
  upBtn.textContent = '▲';
  upBtn.title = t(uiLanguage, 'hintMoveUp');
  upBtn.addEventListener('click', () => moveRow(row, -1, rowClass));

  const downBtn = document.createElement('button');
  downBtn.type = 'button';
  downBtn.className = 'btn-move btn-move-down';
  downBtn.textContent = '▼';
  downBtn.title = t(uiLanguage, 'hintMoveDown');
  downBtn.addEventListener('click', () => moveRow(row, 1, rowClass));

  return [upBtn, downBtn];
}

function createProviderGroupRow(data?: ProviderGroupConfig): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'fallback-provider-row';

  const header = document.createElement('div');
  header.className = 'fallback-provider-row-header';

  const enabledLabel = document.createElement('label');
  enabledLabel.style.display = 'flex';
  enabledLabel.style.alignItems = 'center';
  enabledLabel.style.gap = '5px';
  enabledLabel.style.cursor = 'pointer';
  const enabledCheckbox = document.createElement('input');
  enabledCheckbox.type = 'checkbox';
  enabledCheckbox.className = 'fb-enabled';
  enabledCheckbox.checked = data?.enabled !== false;
  enabledCheckbox.style.accentColor = '#3b82f6';
  enabledCheckbox.style.cursor = 'pointer';
  const indexLabel = document.createElement('span');
  indexLabel.className = 'fallback-provider-index';
  indexLabel.textContent = t(uiLanguage, 'labelProviderGroup');
  enabledLabel.append(enabledCheckbox, indexLabel);
  enabledLabel.title = t(uiLanguage, 'hintFallbackEnabled');

  const [fbUpBtn, fbDownBtn] = createMoveButtons(row, 'fallback-provider-row');

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-fallback';
  removeBtn.textContent = `× ${t(uiLanguage, 'btnRemoveFallback')}`;
  removeBtn.addEventListener('click', () => {
    const parent = row.parentElement;
    row.remove();
    if (parent) syncMoveButtons(parent, 'fallback-provider-row');
    updateDuplicateKeyWarning();
    void autoSave();
  });
  header.append(enabledLabel, fbUpBtn, fbDownBtn, removeBtn);

  const providerSelect = document.createElement('select');
  providerSelect.className = 'select fb-provider';
  for (const p of PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    providerSelect.appendChild(opt);
  }
  providerSelect.value = data?.provider ?? PROVIDERS[0];

  const modelField = document.createElement('input');
  modelField.className = 'input fb-model';
  modelField.type = 'text';
  modelField.placeholder = t(uiLanguage, 'placeholderModel');
  modelField.value = data?.modelName ?? '';

  const baseUrlField = document.createElement('input');
  baseUrlField.className = 'input fb-base-url';
  baseUrlField.type = 'url';
  baseUrlField.placeholder = t(uiLanguage, 'labelBaseUrl');
  baseUrlField.value = data?.baseUrl ?? '';

  const apiKeysList = document.createElement('div');
  apiKeysList.className = 'fb-api-keys-list';
  for (const entry of data?.apiKeys ?? []) {
    apiKeysList.appendChild(createBackupKeyRow(entry));
  }
  syncMoveButtons(apiKeysList, 'backup-key-row');

  // A disabled provider group is skipped entirely during rotation
  // (buildProviderRotation filters on group.enabled), so every key under
  // it is already inert regardless of the key's own checkbox — reflect
  // that here instead of leaving keys looking active while nothing under
  // this provider actually runs. Dims + locks the key rows without
  // touching each key's own stored enabled value, so re-enabling the
  // provider restores exactly which keys were on before.
  const syncProviderEnabledStyle = () => {
    const providerEnabled = enabledCheckbox.checked;
    row.classList.toggle('provider-disabled', !providerEnabled);
    // Only lock the per-key enabled checkbox — re-checking one wouldn't do
    // anything until the provider itself is back on, so leave it visibly
    // inert. Key/weight text fields stay editable so a key can still be
    // typed in or adjusted while the provider is temporarily off.
    for (const checkbox of apiKeysList.querySelectorAll<HTMLInputElement>('.bk-enabled')) {
      checkbox.disabled = !providerEnabled;
    }
  };
  syncProviderEnabledStyle();

  const addKeyBtn = document.createElement('button');
  addKeyBtn.type = 'button';
  addKeyBtn.className = 'btn-add-fallback';
  addKeyBtn.textContent = t(uiLanguage, 'btnAddBackupKey');
  addKeyBtn.addEventListener('click', () => {
    apiKeysList.appendChild(createBackupKeyRow());
    syncMoveButtons(apiKeysList, 'backup-key-row');
    syncProviderEnabledStyle();
    updateDuplicateKeyWarning();
  });

  enabledCheckbox.addEventListener('change', syncProviderEnabledStyle);

  for (const el of [providerSelect, modelField, baseUrlField, enabledCheckbox]) {
    el.addEventListener('change', () => { updateDuplicateKeyWarning(); void autoSave(); });
  }
  providerSelect.addEventListener('input', () => updateDuplicateKeyWarning());

  row.append(header, providerSelect, modelField, baseUrlField, apiKeysList, addKeyBtn);
  return row;
}

function renderProviderGroups(rows: ProviderGroupConfig[]): void {
  providerGroupsList.innerHTML = '';
  for (const row of rows) {
    providerGroupsList.appendChild(createProviderGroupRow(row));
  }
  syncMoveButtons(providerGroupsList, 'fallback-provider-row');
}

function collectProviderGroups(): ProviderGroupConfig[] {
  const rows: ProviderGroupConfig[] = [];
  for (const rowEl of Array.from(providerGroupsList.querySelectorAll<HTMLDivElement>('.fallback-provider-row'))) {
    const provider = rowEl.querySelector<HTMLSelectElement>('.fb-provider')?.value ?? '';
    const modelName = rowEl.querySelector<HTMLInputElement>('.fb-model')?.value.trim() ?? '';
    const baseUrl = rowEl.querySelector<HTMLInputElement>('.fb-base-url')?.value.trim() ?? '';
    const enabled = rowEl.querySelector<HTMLInputElement>('.fb-enabled')?.checked ?? true;
    const apiKeys: BackupApiKeyEntry[] = [];
    for (const keyRowEl of Array.from(rowEl.querySelectorAll<HTMLDivElement>('.fb-api-keys-list .backup-key-row'))) {
      const key = keyRowEl.querySelector<HTMLInputElement>('.bk-key')?.value.trim() ?? '';
      const keyEnabled = keyRowEl.querySelector<HTMLInputElement>('.bk-enabled')?.checked ?? true;
      if (!key) continue;
      const weightRaw = parseFloat(keyRowEl.querySelector<HTMLInputElement>('.bk-weight')?.value ?? '1');
      const weight = Number.isFinite(weightRaw) && weightRaw > 0 ? weightRaw : undefined;
      apiKeys.push({ key, enabled: keyEnabled, ...(weight !== undefined ? { weight } : {}) });
    }
    if (!provider || apiKeys.length === 0) continue; // skip incomplete rows
    rows.push({ provider, modelName: modelName || undefined, apiKeys, baseUrl: baseUrl || undefined, enabled });
  }
  return rows;
}

function createBackupKeyRow(data?: BackupApiKeyEntry): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'backup-key-row';

  const enabledCheckbox = document.createElement('input');
  enabledCheckbox.type = 'checkbox';
  enabledCheckbox.className = 'bk-enabled';
  enabledCheckbox.checked = data?.enabled !== false;
  enabledCheckbox.title = t(uiLanguage, 'hintBackupKeyEnabled');

  const keyField = document.createElement('input');
  keyField.className = 'input bk-key';
  keyField.type = 'password';
  keyField.placeholder = t(uiLanguage, 'placeholderApiKey');
  keyField.value = data?.key ?? '';

  const weightField = document.createElement('input');
  weightField.className = 'input bk-weight';
  weightField.type = 'number';
  weightField.min = '0';
  weightField.step = '0.1';
  weightField.title = t(uiLanguage, 'hintKeyWeight');
  weightField.value = String(data?.weight ?? 1);

  const [upBtn, downBtn] = createMoveButtons(row, 'backup-key-row');

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-fallback';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    const parent = row.parentElement;
    row.remove();
    if (parent) syncMoveButtons(parent, 'backup-key-row');
    updateDuplicateKeyWarning();
    void autoSave();
  });

  const syncDisabledStyle = () => row.classList.toggle('disabled', !enabledCheckbox.checked);
  syncDisabledStyle();

  for (const el of [enabledCheckbox, keyField, weightField]) {
    el.addEventListener('change', () => { syncDisabledStyle(); updateDuplicateKeyWarning(); void autoSave(); });
  }
  keyField.addEventListener('input', () => updateDuplicateKeyWarning());

  row.append(enabledCheckbox, keyField, weightField, upBtn, downBtn, removeBtn);
  return row;
}

async function autoSave(): Promise<boolean> {
  if (!settingsLoaded) return false;
  const next = collectAllSettings();
  const saved = await saveSettings(next);
  if (saved) settings = next;
  return saved;
}

function collectAllSettings(): AppSettings {
  return {
    ...settings,
    extensionEnabled: extensionEnabledToggle.checked,
    backendUrl: backendInput.value.trim() || DEFAULT_SETTINGS.backendUrl,
    uiLanguage: normalizeUiLanguage(uiLanguageSelect.value),
    config: {
      ...settings.config,
      inputLanguage: sourceInput.value.trim() || DEFAULT_SETTINGS.config.inputLanguage,
      outputLanguage: targetInput.value.trim() || DEFAULT_SETTINGS.config.outputLanguage,
      temperature: parseFloat(tempSlider.value),
      topP: parseFloat(topPSlider.value),
      topK: parseInt(topKSlider.value, 10),
      reasoningEffort: reasoningEffortSelect.value || undefined,
      maxTokens: (() => {
        const parsed = parseInt(maxTokensInput.value, 10);
        return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
      })(),
      imageDetail: imageDetailSelect.value || 'auto',
      rotationStrategy: (rotationStrategySelect.value || 'round_robin') as TranslateConfig['rotationStrategy'],
      cooldownSeconds: Math.max(0, parseFloat(cooldownSecondsInput.value)) || 15,
      sendFullPageContext: contextToggle.checked,
      outsideTextEnabled: outsideTextToggle.checked,
      preTranslate: preTranslateToggle.checked,
      previousContextEnabled: previousContextToggle.checked,
      contextMemoryEnabled: contextMemoryToggle.checked,
      contextMemorySequential: contextMemorySequentialToggle.checked,
      specialInstructions: instructionsInput.value.trim() || undefined,
      llmInstructions: llmInstructionsInput.value.trim() || undefined,
      providerGroups: collectProviderGroups(),
    },
  };
}

async function getSettings(): Promise<AppSettings> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeSettings(result[STORAGE_KEY] as StoredSettings | undefined);
}

async function saveSettings(nextSettings: AppSettings): Promise<boolean> {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: nextSettings });
    return true;
  } catch {
    return false;
  }
}

async function checkHealth(backendUrl: string): Promise<void> {
  setHealthState('checking');
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${backendUrl.replace(/\/$/, '')}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    setHealthState(response.ok ? 'ok' : 'error');
  } catch {
    setHealthState('offline');
  }
}

async function ensureContentScript(tabId: number): Promise<boolean> {
  const pingContentScript = async (): Promise<boolean> => {
    try {
      const ping = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      return Boolean(ping?.ok);
    } catch {
      return false;
    }
  };

  if (await pingContentScript()) return true;

  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      files: ['content-script/index.js'],
    });
    return await pingContentScript();
  } catch {
    return false;
  }
}

function setStatus(message: string, type: '' | 'ok' | 'err'): void {
  statusEl.textContent = message;
  statusEl.className = type;
}

void init();
