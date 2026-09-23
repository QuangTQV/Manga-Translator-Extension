import { fileToDataUrl } from './image-utils.js';
import { initRelationshipGraph } from './relationship-graph.js';
import { DEFAULT_SETTINGS, PROVIDERS, SOURCE_LANGUAGES, TARGET_LANGUAGES, normalizeProviderGroups, stripLegacyProviderFields, type AppSettings, type BackupApiKeyEntry, type ProviderGroupConfig, type TranslateConfig, type StoryCharacter, type StoryRelationship, type StoryGlossaryTerm, type StoryContinuityNote, type StoryDetail, type StorySummary } from '../shared/types.js';
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
const inpaintingMethodField = qs<HTMLDivElement>('inpainting-method-field');
const inpaintingMethodSelect = qs<HTMLSelectElement>('f-inpainting-method');
const fluxRemoteUrlRow = qs<HTMLDivElement>('flux-remote-url-row');
const fluxRemoteUrlInput = qs<HTMLInputElement>('f-flux-remote-url');
const fluxRemoteTokenInput = qs<HTMLInputElement>('f-flux-remote-token');
const testFluxRemoteBtn = qs<HTMLButtonElement>('btn-test-flux-remote');
const fluxRemoteTestStatus = qs<HTMLSpanElement>('flux-remote-test-status');
const preTranslateToggle = qs<HTMLInputElement>('f-pre-translate');
const previousContextToggle = qs<HTMLInputElement>('f-previous-context');
const contextMemoryToggle = qs<HTMLInputElement>('f-context-memory');
const contextMemorySequentialToggle = qs<HTMLInputElement>('f-context-memory-sequential');
const scanBtn = qs<HTMLButtonElement>('btn-scan');
const regionBtn = qs<HTMLButtonElement>('btn-region');
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

const accountLoggedOutView = qs<HTMLDivElement>('account-logged-out');
const accountLoggedInView = qs<HTMLDivElement>('account-logged-in');
const accountEmailInput = qs<HTMLInputElement>('f-account-email');
const accountRegisterBtn = qs<HTMLButtonElement>('btn-account-register');
const accountGoogleBtn = qs<HTMLButtonElement>('btn-account-google');
const accountTokenImportInput = qs<HTMLInputElement>('f-account-token-import');
const accountTokenImportBtn = qs<HTMLButtonElement>('btn-account-token-import');
const accountEmailDisplay = qs<HTMLDivElement>('account-email-display');
const accountPlanDisplay = qs<HTMLDivElement>('account-plan-display');
const accountUsageDisplay = qs<HTMLDivElement>('account-usage-display');
const accountRefreshBtn = qs<HTMLButtonElement>('btn-account-refresh');
const accountUpgradeBtn = qs<HTMLButtonElement>('btn-account-upgrade');
const accountLogoutBtn = qs<HTMLButtonElement>('btn-account-logout');
const accountOwnerSection = qs<HTMLDivElement>('account-owner-section');
const ownerProviderSelect = qs<HTMLSelectElement>('f-owner-provider');
const ownerModelInput = qs<HTMLInputElement>('f-owner-model');
const ownerBaseUrlInput = qs<HTMLInputElement>('f-owner-base-url');
const ownerApiKeyInput = qs<HTMLInputElement>('f-owner-api-key');
const ownerKeyStatus = qs<HTMLDivElement>('owner-key-status');
const ownerSaveBtn = qs<HTMLButtonElement>('btn-owner-save');

const storyDbLockedView = qs<HTMLDivElement>('storydb-locked');
const storyDbEditorView = qs<HTMLDivElement>('storydb-editor');
const storySelect = qs<HTMLSelectElement>('f-story-select');
const storyNewNameInput = qs<HTMLInputElement>('f-story-new-name');
const storyNewBtn = qs<HTMLButtonElement>('btn-story-new');
const storyContentFields = qs<HTMLDivElement>('story-content-fields');
const storyNameInput = qs<HTMLInputElement>('f-story-name');
const storyCharactersList = qs<HTMLDivElement>('story-characters-list');
const addStoryCharacterBtn = qs<HTMLButtonElement>('btn-add-story-character');
const storyRelationshipsList = qs<HTMLDivElement>('story-relationships-list');
const addStoryRelationshipBtn = qs<HTMLButtonElement>('btn-add-story-relationship');
const storyGlossaryList = qs<HTMLDivElement>('story-glossary-list');
const addStoryGlossaryBtn = qs<HTMLButtonElement>('btn-add-story-glossary');
const storyContinuityEnabledToggle = qs<HTMLInputElement>('f-story-continuity-enabled');
const storyContinuityNotesList = qs<HTMLDivElement>('story-continuity-notes-list');
const addStoryContinuityNoteBtn = qs<HTMLButtonElement>('btn-add-story-continuity-note');
const storyGraphSvg = document.getElementById('story-graph') as unknown as SVGSVGElement;
const storyGraphInfo = qs<HTMLDivElement>('story-graph-info');
const storyGraphConnectBtn = qs<HTMLButtonElement>('btn-graph-connect');
const storyGraphResetBtn = qs<HTMLButtonElement>('btn-graph-reset');
const economyModeToggle = qs<HTMLInputElement>('f-economy-mode');
const fontPackSelect = qs<HTMLSelectElement>('f-font-pack');
const minFontSizeInput = qs<HTMLInputElement>('f-min-font-size');
const maxFontSizeInput = qs<HTMLInputElement>('f-max-font-size');
const storyRefImagesToggle = qs<HTMLInputElement>('f-story-ref-images');
const storySaveBtn = qs<HTMLButtonElement>('btn-story-save');
const storyDeleteBtn = qs<HTMLButtonElement>('btn-story-delete');

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
  storyRefImagesToggle.checked = settings.config.useStoryReferenceImages ?? false;
  economyModeToggle.checked = settings.config.economyMode ?? false;
  inpaintingMethodSelect.value = settings.config.inpaintingMethod || 'auto';
  fluxRemoteUrlInput.value = settings.config.fluxRemoteBaseUrl ?? '';
  fluxRemoteTokenInput.value = settings.config.fluxRemoteToken ?? '';
  updateInpaintingMethodVisibility();
  preTranslateToggle.checked = settings.config.preTranslate ?? false;
  previousContextToggle.checked = settings.config.previousContextEnabled ?? false;
  contextMemoryToggle.checked = settings.config.contextMemoryEnabled ?? false;
  contextMemorySequentialToggle.checked = settings.config.contextMemorySequential ?? false;
  minFontSizeInput.value = String(settings.config.minFontSize ?? 8);
  maxFontSizeInput.value = String(settings.config.maxFontSize ?? 16);
  void loadFontPackOptions(settings.backendUrl, settings.config.fontDir);

  renderAccountView();
  if (settings.accountToken) void refreshAccountStatus();

  renderStoryDbView();
  if (settings.accountToken) void loadStoryList();

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

  for (const el of [backendInput, sourceInput, targetInput, outsideTextToggle, storyRefImagesToggle, economyModeToggle, fontPackSelect, minFontSizeInput, maxFontSizeInput, preTranslateToggle, previousContextToggle, contextMemoryToggle, contextMemorySequentialToggle, inpaintingMethodSelect, fluxRemoteUrlInput, fluxRemoteTokenInput]) {
    el.addEventListener('change', () => { void autoSave(); });
  }
  sourceInput.addEventListener('input', updateSourceAutoStyle);

  outsideTextToggle.addEventListener('change', updateInpaintingMethodVisibility);
  inpaintingMethodSelect.addEventListener('change', updateInpaintingMethodVisibility);
  testFluxRemoteBtn.addEventListener('click', () => { void handleTestFluxRemote(); });

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

  // Manual region tool: box one spot on the page, read/type/AI-translate its text.
  regionBtn.addEventListener('click', async () => {
    regionBtn.disabled = true;
    try {
      await autoSave();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error(t(uiLanguage, 'errorNoActiveTab'));
      const injected = await ensureContentScript(tab.id);
      if (!injected) throw new Error(t(uiLanguage, 'errorInjectContent'));
      await chrome.tabs.sendMessage(tab.id, { type: 'START_REGION_SELECT' });
      window.close();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), 'err');
      regionBtn.disabled = false;
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

  accountRegisterBtn.addEventListener('click', () => { void handleAccountRegister(); });
  accountGoogleBtn.addEventListener('click', () => { void handleAccountGoogleLogin(); });
  accountTokenImportBtn.addEventListener('click', () => { void handleAccountTokenImport(); });
  accountRefreshBtn.addEventListener('click', () => { void refreshAccountStatus(); });
  accountUpgradeBtn.addEventListener('click', () => { void handleAccountUpgradeDemo(); });
  accountLogoutBtn.addEventListener('click', () => { void handleAccountLogout(); });
  ownerSaveBtn.addEventListener('click', () => { void handleOwnerSave(); });

  storySelect.addEventListener('change', () => { void handleStorySelectChange(); });
  storyNewBtn.addEventListener('click', () => { void handleStoryNew(); });
  addStoryCharacterBtn.addEventListener('click', () => { addStoryCharacterRow(); });
  addStoryRelationshipBtn.addEventListener('click', () => { addStoryRelationshipRow(); });
  addStoryGlossaryBtn.addEventListener('click', () => { addStoryGlossaryRow(); });
  addStoryContinuityNoteBtn.addEventListener('click', () => { addStoryContinuityNoteRow(); });
  storySaveBtn.addEventListener('click', () => { void handleStorySave(); });
  storyDeleteBtn.addEventListener('click', () => { void handleStoryDelete(); });
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

  const reasoningEffortField = document.createElement('select');
  reasoningEffortField.className = 'select fb-reasoning-effort';
  reasoningEffortField.title = t(uiLanguage, 'titlePerGroupReasoningEffort');
  const reasoningEffortOptions: [string, string][] = [
    ['', t(uiLanguage, 'reasoningInherit')],
    ['none', 'None'], ['minimal', 'Minimal'], ['low', 'Low'],
    ['medium', 'Medium'], ['high', 'High'], ['xhigh', 'X-High'],
  ];
  for (const [value, label] of reasoningEffortOptions) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    reasoningEffortField.appendChild(opt);
  }
  reasoningEffortField.value = data?.reasoningEffort ?? '';

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

  const testAllBtn = document.createElement('button');
  testAllBtn.type = 'button';
  testAllBtn.className = 'btn-test-all';
  testAllBtn.textContent = t(uiLanguage, 'btnTestAllKeys');
  testAllBtn.addEventListener('click', () => {
    void (async () => {
      testAllBtn.disabled = true;
      try {
        const keyRows = Array.from(apiKeysList.querySelectorAll<HTMLDivElement>('.backup-key-row'))
          .filter((kr) => kr.querySelector<HTMLInputElement>('.bk-enabled')?.checked !== false);
        await Promise.all(keyRows.map((kr) => {
          const kf = kr.querySelector<HTMLInputElement>('.bk-key');
          const btn = kr.querySelector<HTMLButtonElement>('.btn-test-key');
          const status = kr.querySelector<HTMLSpanElement>('.bk-test-status');
          const errBtn = kr.querySelector<HTMLButtonElement>('.btn-view-error');
          const errBox = kr.querySelector<HTMLDivElement>('.bk-error-detail');
          return (kf && btn && status && errBtn && errBox) ? runKeyTest(kr, kf, btn, status, errBtn, errBox) : Promise.resolve(false);
        }));
      } finally {
        testAllBtn.disabled = false;
      }
    })();
  });

  enabledCheckbox.addEventListener('change', syncProviderEnabledStyle);

  for (const el of [providerSelect, modelField, baseUrlField, reasoningEffortField, enabledCheckbox]) {
    el.addEventListener('change', () => { updateDuplicateKeyWarning(); void autoSave(); });
  }
  providerSelect.addEventListener('input', () => updateDuplicateKeyWarning());

  row.append(header, providerSelect, modelField, baseUrlField, reasoningEffortField, apiKeysList, addKeyBtn, testAllBtn);
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
    const reasoningEffort = rowEl.querySelector<HTMLSelectElement>('.fb-reasoning-effort')?.value ?? '';
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
    rows.push({ provider, modelName: modelName || undefined, apiKeys, baseUrl: baseUrl || undefined, enabled, reasoningEffort: reasoningEffort || undefined });
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

  const testBtn = document.createElement('button');
  testBtn.type = 'button';
  testBtn.className = 'btn-test-key';
  testBtn.textContent = t(uiLanguage, 'btnTestKey');
  testBtn.title = t(uiLanguage, 'hintTestKey');

  const testStatus = document.createElement('span');
  testStatus.className = 'bk-test-status';

  const errorDetailBtn = document.createElement('button');
  errorDetailBtn.type = 'button';
  errorDetailBtn.className = 'btn-view-error';
  errorDetailBtn.textContent = '🔍';
  errorDetailBtn.title = t(uiLanguage, 'btnViewError');

  const errorDetailBox = document.createElement('div');
  errorDetailBox.className = 'bk-error-detail';

  errorDetailBtn.addEventListener('click', () => { errorDetailBox.classList.toggle('visible'); });

  testBtn.addEventListener('click', () => { void runKeyTest(row, keyField, testBtn, testStatus, errorDetailBtn, errorDetailBox); });

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
  keyField.addEventListener('input', () => {
    updateDuplicateKeyWarning();
    testStatus.className = 'bk-test-status'; testStatus.textContent = ''; testStatus.title = '';
    errorDetailBtn.classList.remove('visible');
    errorDetailBox.classList.remove('visible'); errorDetailBox.textContent = '';
  });

  row.append(enabledCheckbox, keyField, weightField, testBtn, testStatus, errorDetailBtn, upBtn, downBtn, removeBtn, errorDetailBox);
  return row;
}

// Reads the enclosing provider group's current provider/model/base URL at
// test time (not creation time) — the user may edit them after adding a
// key row, and a test should always ping against whatever is configured
// right now.
function readGroupProviderFields(keyRow: HTMLElement): { provider: string; modelName: string; baseUrl: string; reasoningEffort: string } {
  const groupRow = keyRow.closest<HTMLDivElement>('.fallback-provider-row');
  // Same value a real translate request for this row would send: its own
  // override if set, else the general Reasoning Effort setting, else Auto
  // (unset) — never forced to a fixed value here, since backends disagree
  // on which values (if any) they accept.
  const ownReasoningEffort = groupRow?.querySelector<HTMLSelectElement>('.fb-reasoning-effort')?.value ?? '';
  return {
    provider: groupRow?.querySelector<HTMLSelectElement>('.fb-provider')?.value ?? '',
    modelName: groupRow?.querySelector<HTMLInputElement>('.fb-model')?.value.trim() ?? '',
    baseUrl: groupRow?.querySelector<HTMLInputElement>('.fb-base-url')?.value.trim() ?? '',
    reasoningEffort: ownReasoningEffort || reasoningEffortSelect.value || '',
  };
}

function testApiKeyValue(provider: string, modelName: string, baseUrl: string, apiKey: string, reasoningEffort: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: 'TEST_API_KEY', body: { provider, model_name: modelName || undefined, api_key: apiKey, base_url: baseUrl || undefined, reasoning_effort: reasoningEffort || undefined } },
      (resp: unknown) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) { resolve({ ok: false, error: lastError.message }); return; }
        resolve((resp as { ok: boolean; error?: string }) ?? { ok: false, error: 'no response' });
      },
    );
  });
}

async function runKeyTest(
  keyRow: HTMLDivElement,
  keyField: HTMLInputElement,
  testBtn: HTMLButtonElement,
  statusEl: HTMLSpanElement,
  errorBtn: HTMLButtonElement,
  errorBox: HTMLDivElement,
): Promise<boolean> {
  const key = keyField.value.trim();
  errorBtn.classList.remove('visible');
  errorBox.classList.remove('visible');
  errorBox.textContent = '';
  if (!key) {
    statusEl.className = 'bk-test-status';
    statusEl.textContent = '';
    statusEl.title = '';
    return false;
  }
  const { provider, modelName, baseUrl, reasoningEffort } = readGroupProviderFields(keyRow);
  testBtn.disabled = true;
  statusEl.className = 'bk-test-status pending';
  statusEl.textContent = '…';
  statusEl.title = t(uiLanguage, 'testKeyPending');
  try {
    const result = await testApiKeyValue(provider, modelName, baseUrl, key, reasoningEffort);
    statusEl.className = `bk-test-status ${result.ok ? 'ok' : 'fail'}`;
    statusEl.textContent = result.ok ? '✓' : '✗';
    statusEl.title = result.ok ? t(uiLanguage, 'testKeyOk') : (result.error || t(uiLanguage, 'testKeyFail'));
    if (!result.ok) {
      errorBox.textContent = result.error || t(uiLanguage, 'testKeyFail');
      errorBtn.classList.add('visible');
    }
    return result.ok;
  } finally {
    testBtn.disabled = false;
  }
}

function updateInpaintingMethodVisibility(): void {
  inpaintingMethodField.style.display = outsideTextToggle.checked ? '' : 'none';
  fluxRemoteUrlRow.style.display = inpaintingMethodSelect.value.endsWith('_remote') ? '' : 'none';
}

async function handleTestFluxRemote(): Promise<void> {
  const url = fluxRemoteUrlInput.value.trim();
  fluxRemoteTestStatus.className = 'bk-test-status';
  fluxRemoteTestStatus.textContent = '';
  fluxRemoteTestStatus.title = '';
  if (!url) return;
  testFluxRemoteBtn.disabled = true;
  fluxRemoteTestStatus.className = 'bk-test-status pending';
  fluxRemoteTestStatus.textContent = '…';
  fluxRemoteTestStatus.title = t(uiLanguage, 'testKeyPending');
  try {
    const result = await new Promise<{ ok: boolean; error?: string }>((resolve) => {
      chrome.runtime.sendMessage({ type: 'TEST_FLUX_REMOTE', url, token: fluxRemoteTokenInput.value.trim() || undefined }, (resp: unknown) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) { resolve({ ok: false, error: lastError.message }); return; }
        resolve((resp as { ok: boolean; error?: string }) ?? { ok: false, error: 'no response' });
      });
    });
    fluxRemoteTestStatus.className = `bk-test-status ${result.ok ? 'ok' : 'fail'}`;
    fluxRemoteTestStatus.textContent = result.ok ? '✓' : '✗';
    fluxRemoteTestStatus.title = result.ok ? t(uiLanguage, 'testKeyOk') : (result.error || t(uiLanguage, 'testKeyFail'));
  } finally {
    testFluxRemoteBtn.disabled = false;
  }
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
      useStoryReferenceImages: storyRefImagesToggle.checked,
      economyMode: economyModeToggle.checked,
      fontDir: fontPackSelect.value || undefined,
      minFontSize: Math.max(1, parseInt(minFontSizeInput.value, 10) || DEFAULT_SETTINGS.config.minFontSize),
      maxFontSize: Math.max(1, parseInt(maxFontSizeInput.value, 10) || DEFAULT_SETTINGS.config.maxFontSize),
      inpaintingMethod: inpaintingMethodSelect.value || 'auto',
      fluxRemoteBaseUrl: fluxRemoteUrlInput.value.trim() || undefined,
      fluxRemoteToken: fluxRemoteTokenInput.value.trim() || undefined,
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

// Populates the Font select from the backend's own fonts/ directory (see
// endpoints/translate.py:list_fonts) so a translator who drops a font pack
// there sees it without editing any config file. Best-effort: a saved
// fontDir the live list doesn't (yet) include — backend offline, or a pack
// added on a different machine — is kept as an extra option rather than
// silently dropped, so the popup never shows a blank/wrong selection.
async function loadFontPackOptions(backendUrl: string, currentFontDir: string | undefined): Promise<void> {
  let fonts: string[] = [];
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${backendUrl.replace(/\/$/, '')}/fonts`, { signal: controller.signal });
    clearTimeout(timeout);
    if (response.ok) {
      const data = await response.json() as { fonts?: string[] };
      fonts = Array.isArray(data.fonts) ? data.fonts : [];
    }
  } catch {
    // Backend unreachable — keep whatever the select already has (at least "Auto").
  }
  if (currentFontDir && !fonts.includes(currentFontDir)) fonts = [...fonts, currentFontDir];

  const previousValue = fontPackSelect.value || currentFontDir || '';
  for (const opt of Array.from(fontPackSelect.querySelectorAll('option[value]:not([value=""])'))) opt.remove();
  for (const name of fonts) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    fontPackSelect.appendChild(opt);
  }
  fontPackSelect.value = fonts.includes(previousValue) ? previousValue : '';
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

// ─────────────────────────────────────────────────────────────────────────────
// Account (only relevant against a centrally-hosted backend — see
// backend/auth.py; the normal local backend ignores accountToken entirely)
// ─────────────────────────────────────────────────────────────────────────────

interface AccountInfo {
  email: string;
  token?: string;
  plan: string;
  usage_count: number;
  quota: number;
  period_start: number;
  is_admin: boolean;
}

interface AccountMessageResult {
  ok: boolean;
  account?: AccountInfo;
  error?: string;
}

function accountMessage(type: string, extra: Record<string, unknown> = {}): Promise<AccountMessageResult> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, (resp: unknown) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) { resolve({ ok: false, error: lastError.message }); return; }
      resolve((resp as AccountMessageResult) ?? { ok: false, error: 'no response' });
    });
  });
}

function planLabel(plan: string): string {
  return plan === 'paid' ? t(uiLanguage, 'planPaid') : t(uiLanguage, 'planFree');
}

function renderAccountView(): void {
  const loggedIn = Boolean(settings.accountToken);
  accountLoggedOutView.style.display = loggedIn ? 'none' : '';
  accountLoggedInView.style.display = loggedIn ? '' : 'none';
  if (loggedIn) accountEmailDisplay.textContent = settings.accountEmail ?? '';
}

function renderAccountInfo(info: AccountInfo): void {
  accountEmailDisplay.textContent = info.email;
  accountPlanDisplay.textContent = planLabel(info.plan);
  accountUsageDisplay.textContent = t(uiLanguage, 'accountUsageFormat', { used: info.usage_count, quota: info.quota });
  accountOwnerSection.style.display = info.is_admin ? '' : 'none';
  if (info.is_admin) void loadOwnerConfig();
}

async function handleAccountRegister(): Promise<void> {
  const email = accountEmailInput.value.trim();
  if (!email) return;
  accountRegisterBtn.disabled = true;
  setStatus(t(uiLanguage, 'statusAccountRegistering'), '');
  try {
    const result = await accountMessage('ACCOUNT_REGISTER', { email });
    if (!result.ok || !result.account?.token) {
      setStatus(`${t(uiLanguage, 'errorAccountRegisterFailed')}: ${result.error ?? ''}`, 'err');
      return;
    }
    settings.accountToken = result.account.token;
    settings.accountEmail = result.account.email;
    await autoSave();
    renderAccountInfo(result.account);
    renderAccountView();
    renderStoryDbView();
    void loadStoryList();
    accountEmailInput.value = '';
    setStatus(t(uiLanguage, 'statusAccountRegistered'), 'ok');
  } finally {
    accountRegisterBtn.disabled = false;
  }
}

async function handleAccountGoogleLogin(): Promise<void> {
  accountGoogleBtn.disabled = true;
  setStatus(t(uiLanguage, 'statusAccountGoogleSigningIn'), '');
  try {
    const result = await accountMessage('ACCOUNT_GOOGLE_LOGIN');
    if (!result.ok || !result.account?.token) {
      setStatus(`${t(uiLanguage, 'errorAccountGoogleFailed')}: ${result.error ?? ''}`, 'err');
      return;
    }
    settings.accountToken = result.account.token;
    settings.accountEmail = result.account.email;
    await autoSave();
    renderAccountInfo(result.account);
    renderAccountView();
    renderStoryDbView();
    void loadStoryList();
    setStatus(t(uiLanguage, 'statusAccountLoggedIn'), 'ok');
  } finally {
    accountGoogleBtn.disabled = false;
  }
}

async function handleAccountTokenImport(): Promise<void> {
  const token = accountTokenImportInput.value.trim();
  if (!token) return;
  accountTokenImportBtn.disabled = true;
  setStatus(t(uiLanguage, 'statusAccountLoggingIn'), '');
  try {
    const result = await accountMessage('ACCOUNT_ME', { token });
    if (!result.ok || !result.account) {
      setStatus(`${t(uiLanguage, 'errorAccountLoginFailed')}: ${result.error ?? ''}`, 'err');
      return;
    }
    settings.accountToken = token;
    settings.accountEmail = result.account.email;
    await autoSave();
    renderAccountInfo(result.account);
    renderAccountView();
    renderStoryDbView();
    void loadStoryList();
    accountTokenImportInput.value = '';
    setStatus(t(uiLanguage, 'statusAccountLoggedIn'), 'ok');
  } finally {
    accountTokenImportBtn.disabled = false;
  }
}

async function refreshAccountStatus(): Promise<void> {
  if (!settings.accountToken) return;
  accountRefreshBtn.disabled = true;
  setStatus(t(uiLanguage, 'statusAccountRefreshing'), '');
  try {
    const result = await accountMessage('ACCOUNT_ME');
    if (!result.ok || !result.account) {
      setStatus(`${t(uiLanguage, 'errorAccountRefreshFailed')}: ${result.error ?? ''}`, 'err');
      return;
    }
    renderAccountInfo(result.account);
    setStatus(t(uiLanguage, 'statusAccountRefreshed'), 'ok');
  } finally {
    accountRefreshBtn.disabled = false;
  }
}

async function handleAccountUpgradeDemo(): Promise<void> {
  if (!settings.accountToken) return;
  accountUpgradeBtn.disabled = true;
  setStatus(t(uiLanguage, 'statusAccountUpgrading'), '');
  try {
    const result = await accountMessage('ACCOUNT_SET_PLAN', { token: settings.accountToken, plan: 'paid' });
    if (!result.ok || !result.account) {
      setStatus(result.error ?? t(uiLanguage, 'errorAccountRefreshFailed'), 'err');
      return;
    }
    renderAccountInfo(result.account);
    setStatus(t(uiLanguage, 'statusAccountUpgraded'), 'ok');
  } finally {
    accountUpgradeBtn.disabled = false;
  }
}

async function handleAccountLogout(): Promise<void> {
  // Revoke the token server-side first, while it's still known — a logout
  // that only cleared local storage would leave the old token usable
  // forever if it ever leaked. Best-effort: local state is cleared either
  // way, since the point of clicking "logout" is to stop using this
  // token locally regardless of backend reachability.
  const token = settings.accountToken;
  if (token) {
    try {
      await accountMessage('ACCOUNT_LOGOUT', { token });
    } catch {
      // ignore — still proceed to clear local state below
    }
  }
  settings.accountToken = undefined;
  settings.accountEmail = undefined;
  settings.activeStoryId = undefined;
  await autoSave();
  renderAccountView();
  renderStoryDbView();
}

// ─────────────────────────────────────────────────────────────────────────────
// Owner section (Account tab, only shown when the logged-in account's
// is_admin is true) — configures the shared LLM provider/model/key for
// every user of this hosted deployment. See backend/auth.py:require_admin,
// core/server_config.py.
// ─────────────────────────────────────────────────────────────────────────────

interface SharedLlmConfigInfo {
  provider: string;
  model_name?: string | null;
  api_key_set: boolean;
  base_url?: string | null;
}

interface AdminMessageResult {
  ok: boolean;
  config?: SharedLlmConfigInfo;
  error?: string;
}

function adminMessage(type: string, extra: Record<string, unknown> = {}): Promise<AdminMessageResult> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, (resp: unknown) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) { resolve({ ok: false, error: lastError.message }); return; }
      resolve((resp as AdminMessageResult) ?? { ok: false, error: 'no response' });
    });
  });
}

function populateOwnerProviderSelect(): void {
  if (ownerProviderSelect.options.length > 0) return;
  for (const p of PROVIDERS) {
    const opt = document.createElement('option');
    opt.value = p;
    opt.textContent = p;
    ownerProviderSelect.appendChild(opt);
  }
}

function renderOwnerConfig(config: SharedLlmConfigInfo): void {
  ownerProviderSelect.value = config.provider || PROVIDERS[0];
  ownerModelInput.value = config.model_name ?? '';
  ownerBaseUrlInput.value = config.base_url ?? '';
  // The real key is never sent back by the server — leave the field blank
  // either way, and let the hint below explain what blank means right now.
  ownerApiKeyInput.value = '';
  ownerKeyStatus.textContent = t(uiLanguage, config.api_key_set ? 'hintOwnerKeySet' : 'hintOwnerKeyEmpty');
}

async function loadOwnerConfig(): Promise<void> {
  populateOwnerProviderSelect();
  const result = await adminMessage('ADMIN_GET_LLM_CONFIG');
  if (!result.ok || !result.config) {
    setStatus(`${t(uiLanguage, 'errorOwnerConfigLoadFailed')}: ${result.error ?? ''}`, 'err');
    return;
  }
  renderOwnerConfig(result.config);
}

async function handleOwnerSave(): Promise<void> {
  ownerSaveBtn.disabled = true;
  setStatus(t(uiLanguage, 'statusOwnerConfigSaving'), '');
  try {
    const result = await adminMessage('ADMIN_SET_LLM_CONFIG', {
      body: {
        provider: ownerProviderSelect.value,
        model_name: ownerModelInput.value.trim() || undefined,
        api_key: ownerApiKeyInput.value.trim() || undefined,
        base_url: ownerBaseUrlInput.value.trim() || undefined,
      },
    });
    if (!result.ok || !result.config) {
      setStatus(`${t(uiLanguage, 'errorOwnerConfigSaveFailed')}: ${result.error ?? ''}`, 'err');
      return;
    }
    renderOwnerConfig(result.config);
    setStatus(t(uiLanguage, 'statusOwnerConfigSaved'), 'ok');
  } finally {
    ownerSaveBtn.disabled = false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Story DB (character database / relationships / glossary) — the "Story DB"
// tab, only usable when logged in (see backend/auth.py:require_login,
// core/story_context.py). Each story is edited as a whole document: picking
// one loads its content into the form, Save PUTs the whole thing back.
// ─────────────────────────────────────────────────────────────────────────────

interface StoryListMessageResult { ok: boolean; stories?: StorySummary[]; error?: string; }
interface StoryDetailMessageResult { ok: boolean; story?: StoryDetail; error?: string; }
interface StoryOkMessageResult { ok: boolean; error?: string; }

const GENDER_OPTIONS: { value: string; key: I18nKey }[] = [
  { value: 'unknown', key: 'genderOptionUnknown' },
  { value: 'female', key: 'genderOptionFemale' },
  { value: 'male', key: 'genderOptionMale' },
  { value: 'other', key: 'genderOptionOther' },
];

function storyMessage<T>(type: string, extra: Record<string, unknown> = {}): Promise<T> {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage({ type, ...extra }, (resp: unknown) => {
      const lastError = chrome.runtime.lastError;
      if (lastError) { resolve({ ok: false, error: lastError.message } as T); return; }
      resolve((resp as T) ?? ({ ok: false, error: 'no response' } as T));
    });
  });
}

function renderStoryDbView(): void {
  const loggedIn = Boolean(settings.accountToken);
  storyDbLockedView.style.display = loggedIn ? 'none' : '';
  storyDbEditorView.style.display = loggedIn ? '' : 'none';
  if (!loggedIn) storyContentFields.style.display = 'none';
}

function populateStorySelect(stories: StorySummary[], preferredId?: string): string {
  storySelect.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = t(uiLanguage, 'placeholderStorySelect');
  storySelect.appendChild(placeholder);
  for (const s of stories) {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = s.name;
    storySelect.appendChild(opt);
  }
  const resolvedId = preferredId && stories.some((s) => s.id === preferredId) ? preferredId : (stories[0]?.id ?? '');
  storySelect.value = resolvedId;
  return resolvedId;
}

async function refreshStoryOptions(preferredId?: string): Promise<string> {
  const result = await storyMessage<StoryListMessageResult>('STORY_LIST');
  if (!result.ok || !result.stories) {
    setStatus(`${t(uiLanguage, 'errorStoryListFailed')}: ${result.error ?? ''}`, 'err');
    return '';
  }
  return populateStorySelect(result.stories, preferredId);
}

async function loadStoryIntoForm(id: string): Promise<void> {
  const result = await storyMessage<StoryDetailMessageResult>('STORY_GET', { id });
  if (!result.ok || !result.story) {
    setStatus(`${t(uiLanguage, 'errorStoryLoadFailed')}: ${result.error ?? ''}`, 'err');
    return;
  }
  storySelect.value = id;
  storyNameInput.value = result.story.name;
  renderStoryCharacters(result.story.characters);
  renderStoryRelationships(result.story.relationships);
  renderStoryGlossary(result.story.glossary);
  storyContinuityEnabledToggle.checked = result.story.continuity_notes_enabled;
  renderStoryContinuityNotes(result.story.continuity_notes);
  storyContentFields.style.display = '';
  settings.activeStoryId = id;
  await autoSave();
}

async function loadStoryList(): Promise<void> {
  const id = await refreshStoryOptions(settings.activeStoryId);
  if (id) {
    await loadStoryIntoForm(id);
  } else {
    storyContentFields.style.display = 'none';
  }
}

async function handleStorySelectChange(): Promise<void> {
  const id = storySelect.value;
  if (!id) {
    storyContentFields.style.display = 'none';
    settings.activeStoryId = undefined;
    await autoSave();
    return;
  }
  await loadStoryIntoForm(id);
}

async function handleStoryNew(): Promise<void> {
  const name = storyNewNameInput.value.trim();
  if (!name) return;
  storyNewBtn.disabled = true;
  setStatus(t(uiLanguage, 'statusStoryCreating'), '');
  try {
    const result = await storyMessage<StoryDetailMessageResult>('STORY_CREATE', { name });
    if (!result.ok || !result.story) {
      setStatus(`${t(uiLanguage, 'errorStoryCreateFailed')}: ${result.error ?? ''}`, 'err');
      return;
    }
    storyNewNameInput.value = '';
    await refreshStoryOptions(result.story.id);
    await loadStoryIntoForm(result.story.id);
    setStatus(t(uiLanguage, 'statusStoryCreated'), 'ok');
  } finally {
    storyNewBtn.disabled = false;
  }
}

async function handleStorySave(): Promise<void> {
  const id = storySelect.value;
  if (!id) return;
  const name = storyNameInput.value.trim();
  if (!name) {
    setStatus(t(uiLanguage, 'errorStoryNameRequired'), 'err');
    return;
  }
  storySaveBtn.disabled = true;
  setStatus(t(uiLanguage, 'statusStorySaving'), '');
  try {
    const payload = {
      name,
      characters: collectStoryCharacters(),
      relationships: collectStoryRelationships(),
      glossary: collectStoryGlossary(),
      continuity_notes: collectStoryContinuityNotes(),
      continuity_notes_enabled: storyContinuityEnabledToggle.checked,
    };
    const result = await storyMessage<StoryDetailMessageResult>('STORY_SAVE', { id, payload });
    if (!result.ok || !result.story) {
      setStatus(`${t(uiLanguage, 'errorStorySaveFailed')}: ${result.error ?? ''}`, 'err');
      return;
    }
    await refreshStoryOptions(id); // picks up a renamed title in the select's option text
    setStatus(t(uiLanguage, 'statusStorySaved'), 'ok');
  } finally {
    storySaveBtn.disabled = false;
  }
}

async function handleStoryDelete(): Promise<void> {
  const id = storySelect.value;
  if (!id) return;
  if (!window.confirm(t(uiLanguage, 'confirmStoryDelete'))) return;
  storyDeleteBtn.disabled = true;
  try {
    const result = await storyMessage<StoryOkMessageResult>('STORY_DELETE', { id });
    if (!result.ok) {
      setStatus(`${t(uiLanguage, 'errorStoryDeleteFailed')}: ${result.error ?? ''}`, 'err');
      return;
    }
    if (settings.activeStoryId === id) {
      settings.activeStoryId = undefined;
      await autoSave();
    }
    await loadStoryList();
    setStatus(t(uiLanguage, 'statusStoryDeleted'), 'ok');
  } finally {
    storyDeleteBtn.disabled = false;
  }
}

function populateCharacterSelect(select: HTMLSelectElement, selectedId?: string): void {
  const previous = selectedId ?? select.value;
  select.innerHTML = '';
  // A native <select> always shows *some* option selected — without an
  // empty placeholder, a relationship whose referenced character gets
  // deleted (or renamed away) would silently fall back to whichever
  // character happens to be first in the list instead of surfacing as
  // "unselected", quietly re-pointing the relationship at the wrong
  // character on save.
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = t(uiLanguage, 'placeholderRelationCharacter');
  select.appendChild(placeholder);
  for (const charRow of Array.from(storyCharactersList.querySelectorAll<HTMLDivElement>('.story-char-row'))) {
    const id = charRow.dataset.charId ?? '';
    const name = charRow.querySelector<HTMLInputElement>('.sc-name')?.value.trim() || t(uiLanguage, 'placeholderCharacterName');
    const opt = document.createElement('option');
    opt.value = id;
    opt.textContent = name;
    select.appendChild(opt);
  }
  select.value = previous && Array.from(select.options).some((o) => o.value === previous) ? previous : '';
}

function refreshRelationshipCharacterOptions(): void {
  for (const relRow of Array.from(storyRelationshipsList.querySelectorAll<HTMLDivElement>('.story-rel-row'))) {
    const aSelect = relRow.querySelector<HTMLSelectElement>('.sr-char-a');
    const bSelect = relRow.querySelector<HTMLSelectElement>('.sr-char-b');
    if (aSelect) populateCharacterSelect(aSelect, aSelect.value);
    if (bSelect) populateCharacterSelect(bSelect, bSelect.value);
  }
}

function createStoryCharacterRow(data?: StoryCharacter): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'story-char-row';
  row.dataset.charId = data?.id ?? crypto.randomUUID();
  if (data?.avatar) row.dataset.avatar = data.avatar;
  if (data?.reference_images?.length) row.dataset.refs = JSON.stringify(data.reference_images);
  if (data?.x !== undefined && data?.y !== undefined) {
    row.dataset.x = String(data.x);
    row.dataset.y = String(data.y);
  }

  const nameField = document.createElement('input');
  nameField.className = 'input sc-name';
  nameField.type = 'text';
  nameField.placeholder = t(uiLanguage, 'placeholderCharacterName');
  nameField.value = data?.name ?? '';
  nameField.addEventListener('input', () => { refreshRelationshipCharacterOptions(); });

  const genderField = document.createElement('select');
  genderField.className = 'select sc-gender';
  for (const g of GENDER_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = g.value;
    opt.textContent = t(uiLanguage, g.key);
    genderField.appendChild(opt);
  }
  genderField.value = data?.gender ?? 'unknown';

  const roleField = document.createElement('input');
  roleField.className = 'input sc-role';
  roleField.type = 'text';
  roleField.placeholder = t(uiLanguage, 'placeholderCharacterRole');
  roleField.value = data?.role ?? '';

  const voiceField = document.createElement('input');
  voiceField.className = 'input sc-voice';
  voiceField.type = 'text';
  voiceField.placeholder = t(uiLanguage, 'placeholderCharacterVoice');
  voiceField.value = data?.voice_notes ?? '';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-fallback';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => {
    row.remove();
    refreshRelationshipCharacterOptions();
  });

  row.appendChild(nameField);
  row.appendChild(genderField);
  row.appendChild(roleField);
  row.appendChild(voiceField);
  row.appendChild(removeBtn);
  row.appendChild(createCharacterAssets(row));
  return row;
}

const MAX_REFERENCE_IMAGES_PER_CHARACTER = 2;

function readRowRefs(row: HTMLElement): string[] {
  try {
    const parsed = JSON.parse(row.dataset.refs ?? '[]');
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

// Avatar + reference-image pickers for one character row. The data lives on
// the row (dataset.avatar / dataset.refs) like the map position does, so
// collectStoryCharacters() and the relationship map read it from the same
// place; a bubbling 'change' tells the map to redraw.
function createCharacterAssets(row: HTMLDivElement): HTMLDivElement {
  const box = document.createElement('div');
  box.className = 'sc-assets';

  const pickImages = (multiple: boolean, onFiles: (files: File[]) => Promise<void>): void => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.multiple = multiple;
    input.addEventListener('change', () => {
      void onFiles(Array.from(input.files ?? [])).catch(() => setStatus(t(uiLanguage, 'errorStoryImageFailed'), 'err'));
    });
    input.click();
  };

  const render = (): void => {
    box.replaceChildren();

    // Avatar
    const avatar = row.dataset.avatar;
    if (avatar) {
      const thumb = document.createElement('div');
      thumb.className = 'sc-thumb round';
      thumb.title = t(uiLanguage, 'titleCharacterAvatar');
      const img = document.createElement('img');
      img.src = avatar;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'sc-thumb-x';
      x.textContent = '×';
      x.addEventListener('click', () => {
        delete row.dataset.avatar;
        render();
        row.dispatchEvent(new Event('change', { bubbles: true }));
      });
      thumb.append(img, x);
      box.appendChild(thumb);
    } else {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'sc-add-btn round';
      add.textContent = '👤';
      add.title = t(uiLanguage, 'titleCharacterAvatar');
      add.addEventListener('click', () => pickImages(false, async ([file]) => {
        if (!file) return;
        row.dataset.avatar = await fileToDataUrl(file, { maxSide: 96, crop: true, quality: 0.8 });
        render();
        row.dispatchEvent(new Event('change', { bubbles: true }));
      }));
      box.appendChild(add);
    }

    const label = document.createElement('span');
    label.className = 'sc-assets-label';
    label.textContent = t(uiLanguage, 'labelCharacterReferences');
    box.appendChild(label);

    // Reference images
    const refs = readRowRefs(row);
    refs.forEach((src, i) => {
      const thumb = document.createElement('div');
      thumb.className = 'sc-thumb';
      const img = document.createElement('img');
      img.src = src;
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'sc-thumb-x';
      x.textContent = '×';
      x.addEventListener('click', () => {
        const next = readRowRefs(row).filter((_, j) => j !== i);
        if (next.length) row.dataset.refs = JSON.stringify(next); else delete row.dataset.refs;
        render();
      });
      thumb.append(img, x);
      box.appendChild(thumb);
    });
    if (refs.length < MAX_REFERENCE_IMAGES_PER_CHARACTER) {
      const add = document.createElement('button');
      add.type = 'button';
      add.className = 'sc-add-btn';
      add.textContent = '🖼';
      add.title = t(uiLanguage, 'titleCharacterReferences');
      add.addEventListener('click', () => pickImages(true, async (files) => {
        const room = MAX_REFERENCE_IMAGES_PER_CHARACTER - readRowRefs(row).length;
        const added: string[] = [];
        for (const file of files.slice(0, room)) added.push(await fileToDataUrl(file, { maxSide: 448, quality: 0.8 }));
        if (!added.length) return;
        row.dataset.refs = JSON.stringify([...readRowRefs(row), ...added]);
        render();
      }));
      box.appendChild(add);
    }
  };

  render();
  return box;
}

function createStoryRelationshipRow(data?: StoryRelationship): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'story-rel-row';

  const charASelect = document.createElement('select');
  charASelect.className = 'select sr-char-a';
  const charBSelect = document.createElement('select');
  charBSelect.className = 'select sr-char-b';

  const relationField = document.createElement('input');
  relationField.className = 'input sr-relation';
  relationField.type = 'text';
  relationField.placeholder = t(uiLanguage, 'placeholderRelationSurface');
  relationField.value = data?.surface_relation ?? '';

  const notesField = document.createElement('input');
  notesField.className = 'input sr-notes';
  notesField.type = 'text';
  notesField.placeholder = t(uiLanguage, 'placeholderRelationNotes');
  notesField.value = data?.address_notes ?? '';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-fallback';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => { row.remove(); });

  row.appendChild(charASelect);
  row.appendChild(charBSelect);
  row.appendChild(relationField);
  row.appendChild(notesField);
  row.appendChild(removeBtn);

  populateCharacterSelect(charASelect, data?.character_a_id);
  populateCharacterSelect(charBSelect, data?.character_b_id);

  return row;
}

function createStoryGlossaryRow(data?: StoryGlossaryTerm): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'story-glossary-row';

  const termField = document.createElement('input');
  termField.className = 'input sg-term';
  termField.type = 'text';
  termField.placeholder = t(uiLanguage, 'placeholderGlossaryTerm');
  termField.value = data?.term ?? '';

  const translationField = document.createElement('input');
  translationField.className = 'input sg-translation';
  translationField.type = 'text';
  translationField.placeholder = t(uiLanguage, 'placeholderGlossaryTranslation');
  translationField.value = data?.translation ?? '';

  const notesField = document.createElement('input');
  notesField.className = 'input sg-notes';
  notesField.type = 'text';
  notesField.placeholder = t(uiLanguage, 'placeholderGlossaryNotes');
  notesField.value = data?.notes ?? '';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-fallback';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => { row.remove(); });

  row.appendChild(termField);
  row.appendChild(translationField);
  row.appendChild(notesField);
  row.appendChild(removeBtn);
  return row;
}

function createStoryContinuityNoteRow(data?: StoryContinuityNote): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'story-continuity-note-row';

  const textField = document.createElement('input');
  textField.className = 'input scn-text';
  textField.type = 'text';
  textField.placeholder = t(uiLanguage, 'placeholderContinuityNoteText');
  textField.value = data?.text ?? '';

  const sourceField = document.createElement('input');
  sourceField.className = 'input scn-source';
  sourceField.type = 'text';
  sourceField.placeholder = t(uiLanguage, 'placeholderContinuityNoteSource');
  sourceField.value = data?.source_label ?? '';

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-fallback';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => { row.remove(); });

  row.appendChild(textField);
  row.appendChild(sourceField);
  row.appendChild(removeBtn);
  return row;
}

function renderStoryCharacters(characters: StoryCharacter[]): void {
  storyCharactersList.innerHTML = '';
  for (const c of characters) storyCharactersList.appendChild(createStoryCharacterRow(c));
}

function renderStoryRelationships(relationships: StoryRelationship[]): void {
  storyRelationshipsList.innerHTML = '';
  for (const r of relationships) storyRelationshipsList.appendChild(createStoryRelationshipRow(r));
}

function renderStoryGlossary(glossary: StoryGlossaryTerm[]): void {
  storyGlossaryList.innerHTML = '';
  for (const g of glossary) storyGlossaryList.appendChild(createStoryGlossaryRow(g));
}

function renderStoryContinuityNotes(notes: StoryContinuityNote[]): void {
  storyContinuityNotesList.innerHTML = '';
  for (const n of notes) storyContinuityNotesList.appendChild(createStoryContinuityNoteRow(n));
}

function addStoryCharacterRow(): void {
  storyCharactersList.appendChild(createStoryCharacterRow());
  refreshRelationshipCharacterOptions();
}

function addStoryRelationshipRow(): void {
  storyRelationshipsList.appendChild(createStoryRelationshipRow());
}

// The relationship map is a live view over the character/relationship rows
// above; "Connect" mode in it appends a pre-filled relationship row.
initRelationshipGraph({
  svg: storyGraphSvg,
  info: storyGraphInfo,
  connectBtn: storyGraphConnectBtn,
  resetBtn: storyGraphResetBtn,
  charactersList: storyCharactersList,
  relationshipsList: storyRelationshipsList,
  t: (key) => t(uiLanguage, key as Parameters<typeof t>[1]),
  addRelationship: (aId, bId) => {
    const row = createStoryRelationshipRow({ id: crypto.randomUUID(), character_a_id: aId, character_b_id: bId, surface_relation: '' });
    storyRelationshipsList.appendChild(row);
    return row;
  },
});

function addStoryGlossaryRow(): void {
  storyGlossaryList.appendChild(createStoryGlossaryRow());
}

function addStoryContinuityNoteRow(): void {
  storyContinuityNotesList.appendChild(createStoryContinuityNoteRow());
}

function collectStoryCharacters(): StoryCharacter[] {
  const out: StoryCharacter[] = [];
  for (const row of Array.from(storyCharactersList.querySelectorAll<HTMLDivElement>('.story-char-row'))) {
    const name = row.querySelector<HTMLInputElement>('.sc-name')?.value.trim() ?? '';
    if (!name) continue;
    const gender = row.querySelector<HTMLSelectElement>('.sc-gender')?.value || 'unknown';
    const role = row.querySelector<HTMLInputElement>('.sc-role')?.value.trim() || undefined;
    const voiceNotes = row.querySelector<HTMLInputElement>('.sc-voice')?.value.trim() || undefined;
    const x = row.dataset.x !== undefined ? Number(row.dataset.x) : undefined;
    const y = row.dataset.y !== undefined ? Number(row.dataset.y) : undefined;
    const refs = readRowRefs(row);
    out.push({ id: row.dataset.charId ?? crypto.randomUUID(), name, gender, role, voice_notes: voiceNotes, x, y, avatar: row.dataset.avatar || undefined, reference_images: refs });
  }
  return out;
}

function collectStoryRelationships(): StoryRelationship[] {
  const out: StoryRelationship[] = [];
  for (const row of Array.from(storyRelationshipsList.querySelectorAll<HTMLDivElement>('.story-rel-row'))) {
    const characterAId = row.querySelector<HTMLSelectElement>('.sr-char-a')?.value ?? '';
    const characterBId = row.querySelector<HTMLSelectElement>('.sr-char-b')?.value ?? '';
    const surfaceRelation = row.querySelector<HTMLInputElement>('.sr-relation')?.value.trim() ?? '';
    if (!characterAId || !characterBId || !surfaceRelation) continue;
    const addressNotes = row.querySelector<HTMLInputElement>('.sr-notes')?.value.trim() || undefined;
    out.push({
      id: crypto.randomUUID(), character_a_id: characterAId, character_b_id: characterBId,
      surface_relation: surfaceRelation, address_notes: addressNotes,
    });
  }
  return out;
}

function collectStoryGlossary(): StoryGlossaryTerm[] {
  const out: StoryGlossaryTerm[] = [];
  for (const row of Array.from(storyGlossaryList.querySelectorAll<HTMLDivElement>('.story-glossary-row'))) {
    const term = row.querySelector<HTMLInputElement>('.sg-term')?.value.trim() ?? '';
    const translation = row.querySelector<HTMLInputElement>('.sg-translation')?.value.trim() ?? '';
    if (!term || !translation) continue;
    const notes = row.querySelector<HTMLInputElement>('.sg-notes')?.value.trim() || undefined;
    out.push({ id: crypto.randomUUID(), term, translation, notes });
  }
  return out;
}

function collectStoryContinuityNotes(): StoryContinuityNote[] {
  const out: StoryContinuityNote[] = [];
  for (const row of Array.from(storyContinuityNotesList.querySelectorAll<HTMLDivElement>('.story-continuity-note-row'))) {
    const text = row.querySelector<HTMLInputElement>('.scn-text')?.value.trim() ?? '';
    if (!text) continue;
    const sourceLabel = row.querySelector<HTMLInputElement>('.scn-source')?.value.trim() || undefined;
    out.push({ id: crypto.randomUUID(), text, source_label: sourceLabel });
  }
  return out;
}

void init();
