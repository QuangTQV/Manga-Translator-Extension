import { UI_LANGUAGES, normalizeUiLanguage, t, type I18nKey, type UiLanguage } from '../shared/i18n.js';
import { DEFAULT_SETTINGS, PROVIDERS, SOURCE_LANGUAGES, TARGET_LANGUAGES, normalizeProviderGroups, stripLegacyProviderFields, type AppSettings, type BackupApiKeyEntry, type ProviderGroupConfig, type StoryCharacter, type StoryContinuityNote, type StoryDetail, type StoryGlossaryTerm, type StoryRelationship, type StorySummary, type TranslateConfig } from '../shared/types.js';
import { fileToDataUrl } from './image-utils.js';
import { renderMarkdown } from './markdown.js';
import { initRelationshipGraph } from './relationship-graph.js';

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
const webSearchSourceSelect = qs<HTMLSelectElement>('f-web-search-source');
const searxngStartStatus = qs<HTMLSpanElement>('searxng-start-status');
const webSearchTestQueryInput = qs<HTMLInputElement>('f-web-search-test-query');
const testWebSearchBtn = qs<HTMLButtonElement>('btn-test-web-search');
const webSearchTestStatus = qs<HTMLSpanElement>('web-search-test-status');
const webSearchTestResults = qs<HTMLPreElement>('web-search-test-results');
const sourceInput = qs<HTMLInputElement>('f-source');
const targetInput = qs<HTMLInputElement>('f-target');
const sourceLanguageList = qs<HTMLDataListElement>('lang-source-list');
const targetLanguageList = qs<HTMLDataListElement>('lang-target-list');
const useStoryDbToggle = qs<HTMLInputElement>('f-use-story-db');
const outsideTextToggle = qs<HTMLInputElement>('f-outside-text');
const inpaintingMethodField = qs<HTMLDivElement>('inpainting-method-field');
const inpaintingMethodSelect = qs<HTMLSelectElement>('f-inpainting-method');
const fluxRemoteUrlRow = qs<HTMLDivElement>('flux-remote-url-row');
const fluxRemoteUrlInput = qs<HTMLInputElement>('f-flux-remote-url');
const fluxRemoteTokenInput = qs<HTMLInputElement>('f-flux-remote-token');
const testFluxRemoteBtn = qs<HTMLButtonElement>('btn-test-flux-remote');
const fluxRemoteTestStatus = qs<HTMLSpanElement>('flux-remote-test-status');
const preTranslateToggle = qs<HTMLInputElement>('f-pre-translate');
const textReadingSelect = qs<HTMLSelectElement>('f-text-reading');
const readingDirectionSelect = qs<HTMLSelectElement>('f-reading-direction');
const previousContextToggle = qs<HTMLInputElement>('f-previous-context');
const contextMemoryToggle = qs<HTMLInputElement>('f-context-memory');
const contextMemorySequentialToggle = qs<HTMLInputElement>('f-context-memory-sequential');
const scanBtn = qs<HTMLButtonElement>('btn-scan');
const regionBtn = qs<HTMLButtonElement>('btn-region');
const eraserBtn = qs<HTMLButtonElement>('btn-eraser');
const autoBtn = qs<HTMLButtonElement>('btn-auto');
const saveBtn = qs<HTMLButtonElement>('btn-save');
const saveConfigBtn = qs<HTMLButtonElement>('btn-save-config');
const resetPreferencesBtn = qs<HTMLButtonElement>('btn-reset-preferences');
const openLiveAiBtn = qs<HTMLButtonElement>('btn-open-live-ai');
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
const preReplacementsInput = qs<HTMLTextAreaElement>('f-pre-replacements');
const letteringUppercaseToggle = qs<HTMLInputElement>('f-lettering-uppercase');
const letteringAlignSelect = qs<HTMLSelectElement>('f-lettering-align');
const letteringTextColorMode = qs<HTMLSelectElement>('f-lettering-text-color-mode');
const letteringTextColorInput = qs<HTMLInputElement>('f-lettering-text-color');
const letteringOutlineWidthSelect = qs<HTMLSelectElement>('f-lettering-outline-width');
const letteringOutlineColorMode = qs<HTMLSelectElement>('f-lettering-outline-color-mode');
const letteringOutlineColorInput = qs<HTMLInputElement>('f-lettering-outline-color');
const postReplacementsInput = qs<HTMLTextAreaElement>('f-post-replacements');
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
const storyDomainMismatchWarning = qs<HTMLDivElement>('story-domain-mismatch-warning');
const storyNewNameInput = qs<HTMLInputElement>('f-story-new-name');
const storyNewBtn = qs<HTMLButtonElement>('btn-story-new');
const storyContentFields = qs<HTMLDivElement>('story-content-fields');
const storyDraftBanner = qs<HTMLDivElement>('story-draft-banner');
const storyDraftDiscardBtn = qs<HTMLButtonElement>('btn-story-draft-discard');
const storyUndoBtn = qs<HTMLButtonElement>('btn-story-undo');
const storyRedoBtn = qs<HTMLButtonElement>('btn-story-redo');
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
const combinePageImageToggle = qs<HTMLInputElement>('f-combine-page-image');
const combinePageImageResolutionRow = qs<HTMLDivElement>('combine-page-image-resolution-row');
const combinePageImageResolutionSelect = qs<HTMLSelectElement>('f-combine-page-image-resolution');
const fontPackSelect = qs<HTMLSelectElement>('f-font-pack');
const minFontSizeInput = qs<HTMLInputElement>('f-min-font-size');
const maxFontSizeInput = qs<HTMLInputElement>('f-max-font-size');
const storyRefImagesToggle = qs<HTMLInputElement>('f-story-ref-images');
const storySaveBtn = qs<HTMLButtonElement>('btn-story-save');
const storyDeleteBtn = qs<HTMLButtonElement>('btn-story-delete');
const storyExportBtn = qs<HTMLButtonElement>('btn-story-export');
const storyImportBtn = qs<HTMLButtonElement>('btn-story-import');
const storyImportFileInput = qs<HTMLInputElement>('f-story-import-file');
const storyUpdateDescriptionInput = qs<HTMLTextAreaElement>('f-story-update-description');
const storyUpdateWebSearchToggle = qs<HTMLInputElement>('f-story-update-web-search');
const storyUpdateFromDescriptionBtn = qs<HTMLButtonElement>('btn-story-update-from-description');
const storyUpdateStatus = qs<HTMLDivElement>('story-update-status');
const supersamplingSelect = qs<HTMLSelectElement>('f-supersampling');

const healthBadge = qs<HTMLSpanElement>('health-badge');
const openWindowBtn = qs<HTMLButtonElement>('btn-open-window');
const helpChatBtn = qs<HTMLButtonElement>('btn-help-chat');
const supportChatOverlay = qs<HTMLDivElement>('support-chat-overlay');
const supportChatMessagesEl = qs<HTMLDivElement>('support-chat-messages');
const supportChatErrorEl = qs<HTMLDivElement>('support-chat-error');
const supportChatInput = qs<HTMLTextAreaElement>('support-chat-input');
const supportChatSendBtn = qs<HTMLButtonElement>('btn-send-support-chat');
const supportChatCloseBtn = qs<HTMLButtonElement>('btn-close-support-chat');
const supportChatClearBtn = qs<HTMLButtonElement>('btn-clear-support-chat');
const statusEl = qs<HTMLDivElement>('popup-status');
const settingsSaveStatusEl = qs<HTMLDivElement>('settings-save-status');
const settingsSearchInput = qs<HTMLInputElement>('settings-search');
const settingsSearchWrap = qs<HTMLDivElement>('settings-search-wrap');
const settingsSearchClearBtn = qs<HTMLButtonElement>('settings-search-clear');
const settingsSearchFeedback = qs<HTMLDivElement>('settings-search-feedback');
const settingsSearchResults = qs<HTMLDivElement>('settings-search-results');
const urlDisplay = qs<HTMLDivElement>('backend-url-display');

let settings: AppSettings = normalizeSettings();
let uiLanguage: UiLanguage = 'en';
let healthState: HealthState = 'checking';
let isBound = false;
let settingsSaveRevision = 0;
let settingsSaveState: 'idle' | 'saving' | 'saved' | 'error' = 'idle';
let tabBeforeSettingsSearch: string | null = null;
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
  document.querySelectorAll<HTMLElement>('[data-i18n-aria-label]').forEach((el) => {
    const key = el.dataset.i18nAriaLabel as I18nKey | undefined;
    if (key) el.setAttribute('aria-label', t(uiLanguage, key));
  });
  setHealthState(healthState);
  renderAutoSaveStatus();
  setAutoButtonState(autoBtn.classList.contains('active'));
  setInstructionsExpandedState(instructionsInput.classList.contains('textarea-expanded'));
  openWindowBtn.title = t(uiLanguage, 'titleOpenPopupWindow');
  helpChatBtn.title = t(uiLanguage, 'supportChatTitle');
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
      activateTab(btn.dataset.tab ?? 'translate');
      await autoSave();
    });
  });
}

function activateTab(tabName: string): void {
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab-btn'));
  const panes = Array.from(document.querySelectorAll<HTMLElement>('.tab-pane'));
  const previousPane = panes.find((pane) => pane.classList.contains('active'));
  const nextPane = panes.find((pane) => pane.id === `tab-${tabName}`);
  if (!nextPane) return;
  if (nextPane !== previousPane) {
    const previousIndex = previousPane ? panes.indexOf(previousPane) : panes.indexOf(nextPane);
    const nextIndex = panes.indexOf(nextPane);
    nextPane.style.setProperty('--tab-enter-x', `${nextIndex > previousIndex ? 4 : -4}px`);
  }

  buttons.forEach((button) => {
    button.classList.toggle('active', button.dataset.tab === tabName);
  });
  panes.forEach((pane) => {
    pane.classList.toggle('active', pane.id === `tab-${tabName}`);
  });
}

function initSettingsSearch(): void {
  const tabButtons = Array.from(document.querySelectorAll<HTMLButtonElement>('.tab-btn'));
  const panes = Array.from(document.querySelectorAll<HTMLElement>('.tab-pane'));

  const clearSearch = (): void => {
    settingsSearchInput.value = '';
    settingsSearchWrap.classList.remove('has-query');
    settingsSearchFeedback.textContent = '';
    settingsSearchResults.replaceChildren();
    panes.forEach((pane) => {
      pane.querySelectorAll<HTMLElement>('.field, .toggle-row').forEach((row) => row.classList.remove('search-hidden'));
      pane.querySelectorAll<HTMLDetailsElement>('details[data-search-opened="true"]').forEach((details) => {
        details.open = false;
        delete details.dataset.searchOpened;
      });
    });
    tabButtons.forEach((button) => { button.hidden = false; });
    if (tabBeforeSettingsSearch) activateTab(tabBeforeSettingsSearch);
    tabBeforeSettingsSearch = null;
  };

  const jumpToSetting = (tabName: string, row: HTMLElement): void => {
    const details = row.closest<HTMLDetailsElement>('details');
    // Keep the destination disclosure open after clearing the temporary search.
    if (details) delete details.dataset.searchOpened;
    tabBeforeSettingsSearch = null;
    clearSearch();
    if (details) details.open = true;
    activateTab(tabName);
    window.requestAnimationFrame(() => {
      row.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'center' });
      row.classList.add('settings-search-target');
      window.setTimeout(() => row.classList.remove('settings-search-target'), 950);
      row.querySelector<HTMLElement>('input, select, textarea, button')?.focus({ preventScroll: true });
    });
  };

  settingsSearchInput.addEventListener('input', () => {
    const query = normalizeSettingsSearch(settingsSearchInput.value);
    settingsSearchWrap.classList.toggle('has-query', query.length > 0);
    if (!query) {
      clearSearch();
      return;
    }
    if (!tabBeforeSettingsSearch) {
      tabBeforeSettingsSearch = document.querySelector<HTMLButtonElement>('.tab-btn.active')?.dataset.tab ?? 'translate';
    }

    let totalMatches = 0;
    const matchingTabs = new Set<string>();
    const results: Array<{ tabName: string; tabLabel: string; row: HTMLElement; label: string; score: number }> = [];
    for (const pane of panes) {
      const rows = Array.from(pane.querySelectorAll<HTMLElement>('.field, .toggle-row'))
        .filter((row) => !row.parentElement?.closest('.field, .toggle-row'));
      let paneMatches = 0;
      for (const row of rows) {
        let ancestor = row.parentElement;
        let conditionallyHidden = row.style.display === 'none';
        while (!conditionallyHidden && ancestor && ancestor !== pane) {
          conditionallyHidden = ancestor.style.display === 'none';
          ancestor = ancestor.parentElement;
        }
        if (conditionallyHidden) {
          row.classList.remove('search-hidden');
          continue;
        }
        const score = settingsSearchMatchScore(query, row.textContent ?? '');
        const matches = score > 0;
        row.classList.toggle('search-hidden', !matches);
        if (matches) {
          paneMatches += 1;
          row.closest('details:not([open])')?.setAttribute('data-search-opened', 'true');
          const details = row.closest<HTMLDetailsElement>('details[data-search-opened="true"]');
          if (details) details.open = true;
          const tabName = pane.id.replace(/^tab-/, '');
          const tabButton = tabButtons.find((button) => button.dataset.tab === tabName);
          const labelElement = row.querySelector<HTMLElement>('.label, .toggle-title');
          results.push({
            tabName,
            tabLabel: tabButton?.textContent?.trim() || tabName,
            row,
            label: labelElement?.textContent?.trim() || row.textContent?.trim().replace(/\s+/g, ' ').slice(0, 70) || tabName,
            score,
          });
        }
      }
      totalMatches += paneMatches;
      const tabName = pane.id.replace(/^tab-/, '');
      if (paneMatches > 0) matchingTabs.add(tabName);
    }

    if (matchingTabs.size > 0) {
      tabButtons.forEach((button) => { button.hidden = !matchingTabs.has(button.dataset.tab ?? ''); });
      const activeName = document.querySelector<HTMLButtonElement>('.tab-btn.active')?.dataset.tab;
      if (!activeName || !matchingTabs.has(activeName)) activateTab(matchingTabs.values().next().value ?? 'translate');
      settingsSearchFeedback.textContent = t(uiLanguage, 'statusSettingsSearchCount', { count: totalMatches });
      results.sort((a, b) => b.score - a.score || a.label.localeCompare(b.label));
      settingsSearchResults.replaceChildren(...results.slice(0, 12).map((result) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'settings-search-result';
        button.setAttribute('role', 'option');
        const label = document.createElement('span');
        label.className = 'settings-search-result-label';
        label.textContent = result.label;
        const tabLabel = document.createElement('span');
        tabLabel.className = 'settings-search-result-tab';
        tabLabel.textContent = result.tabLabel;
        button.append(label, tabLabel);
        button.addEventListener('click', () => jumpToSetting(result.tabName, result.row));
        return button;
      }));
    } else {
      // Keep navigation available for correction, but avoid leaving an empty
      // hidden-tab row after a query with no hits.
      tabButtons.forEach((button) => { button.hidden = false; });
      activateTab(tabBeforeSettingsSearch ?? 'translate');
      settingsSearchFeedback.textContent = t(uiLanguage, 'statusSettingsSearchEmpty');
      settingsSearchResults.replaceChildren();
    }
  });

  settingsSearchClearBtn.addEventListener('click', clearSearch);
}

function normalizeSettingsSearch(value: string): string {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

const SETTINGS_SEARCH_SYNONYMS: Array<{ triggers: string[]; aliases: string }> = [
  { triggers: ['font size', 'text size', 'lettering'], aliases: 'co chu kich thuoc chu font size text size' },
  { triggers: ['economy', 'cost', 'price'], aliases: 'tiet kiem chi phi gia re economy cost price cheap' },
  { triggers: ['api key', 'api token', 'provider'], aliases: 'khoa key ma khoa credential token provider model' },
  { triggers: ['reading direction', 'right to left', 'left to right'], aliases: 'huong doc phai trai manga comic reading direction' },
  { triggers: ['combine page', 'page image', 'full page'], aliases: 'gop trang gop anh toan trang combine page image' },
  { triggers: ['translate', 'translation', 'language'], aliases: 'dich ngon ngu ban dich translate translation language' },
  { triggers: ['erase', 'inpainting'], aliases: 'xoa chu tay xoa lam sach erase inpainting' },
];

function settingsSearchMatchScore(query: string, rowText: string): number {
  if (!query) return 0;
  let text = normalizeSettingsSearch(rowText);
  for (const synonym of SETTINGS_SEARCH_SYNONYMS) {
    if (synonym.triggers.some((trigger) => text.includes(trigger))) text += ` ${synonym.aliases}`;
  }
  if (text.includes(query)) return 100 + query.length;

  const queryTerms = query.split(/\s+/).filter(Boolean);
  const words = text.split(/\s+/).filter(Boolean);
  let score = 0;
  for (const term of queryTerms) {
    let best = 0;
    for (const word of words) {
      if (word === term) best = Math.max(best, 12);
      else if (term.length >= 2 && word.startsWith(term)) best = Math.max(best, 9);
      else if (term.length >= 4 && editDistanceAtMost(term, word, term.length >= 7 ? 2 : 1)) best = Math.max(best, 5);
    }
    if (!best) return 0;
    score += best;
  }
  return score;
}

function editDistanceAtMost(a: string, b: string, limit: number): boolean {
  if (Math.abs(a.length - b.length) > limit) return false;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    let rowMinimum = i;
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMinimum = Math.min(rowMinimum, current[j]);
    }
    if (rowMinimum > limit) return false;
    previous = current;
  }
  return previous[b.length] <= limit;
}

function initSliders(): void {
  tempSlider.addEventListener('input', () => { tempVal.textContent = Number(tempSlider.value).toFixed(2); });
  topPSlider.addEventListener('input', () => { topPVal.textContent = Number(topPSlider.value).toFixed(2); });
  topKSlider.addEventListener('input', () => { topKVal.textContent = topKSlider.value; });
}

// The action popup uses a fixed, custom bottom-right drag handle because the
// browser's native body resize grip follows the end of long scrollable content.
// For larger workspaces, `#btn-open-window` opens a standalone OS window whose
// frame can be resized normally.
const POPUP_SIZE_KEY = 'mtPopupSize';
let popupSizeSaveTimer: number | undefined;

async function restorePopupSize(): Promise<void> {
  try {
    const raw = await chrome.storage.local.get(POPUP_SIZE_KEY);
    const saved = raw[POPUP_SIZE_KEY] as { w?: number; h?: number } | undefined;
    if (saved?.w) document.body.style.width = `${saved.w}px`;
    if (saved?.h) document.body.style.height = `${saved.h}px`;
  } catch {
    // chrome.storage unavailable (shouldn't happen in the real extension) — keep the CSS default size.
  }
}

function initPopupResize(): void {
  // The browser's native CSS resize grip on `body` follows the scrollable
  // content edge, so on long tabs it can disappear below the viewport. Keep
  // our own grip fixed to the visible bottom-right corner instead.
  document.body.style.resize = 'none';
  const handle = document.createElement('button');
  handle.type = 'button';
  handle.className = 'popup-resize-handle';
  handle.setAttribute('aria-label', 'Resize popup');
  handle.title = 'Drag to resize popup';
  document.documentElement.append(handle);

  let dragStart: { x: number; y: number; width: number; height: number } | null = null;
  handle.addEventListener('pointerdown', (event) => {
    event.preventDefault();
    dragStart = {
      x: event.clientX,
      y: event.clientY,
      width: document.body.getBoundingClientRect().width,
      height: document.body.getBoundingClientRect().height,
    };
    handle.setPointerCapture(event.pointerId);
  });
  handle.addEventListener('pointermove', (event) => {
    if (!dragStart) return;
    const width = Math.max(340, Math.min(720, dragStart.width + event.clientX - dragStart.x));
    const height = Math.max(460, Math.min(680, dragStart.height + event.clientY - dragStart.y));
    document.body.style.width = `${Math.round(width)}px`;
    document.body.style.height = `${Math.round(height)}px`;
  });
  const stopResize = (): void => { dragStart = null; };
  handle.addEventListener('pointerup', stopResize);
  handle.addEventListener('pointercancel', stopResize);
  handle.addEventListener('keydown', (event) => {
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const rect = document.body.getBoundingClientRect();
    const step = event.shiftKey ? 48 : 16;
    const widthDelta = event.key === 'ArrowRight' ? step : event.key === 'ArrowLeft' ? -step : 0;
    const heightDelta = event.key === 'ArrowDown' ? step : event.key === 'ArrowUp' ? -step : 0;
    document.body.style.width = `${Math.max(340, Math.min(720, rect.width + widthDelta))}px`;
    document.body.style.height = `${Math.max(460, Math.min(680, rect.height + heightDelta))}px`;
  });

  const observer = new ResizeObserver((entries) => {
    const entry = entries[0];
    if (!entry) return;
    const { width, height } = entry.contentRect;
    window.clearTimeout(popupSizeSaveTimer);
    popupSizeSaveTimer = window.setTimeout(() => {
      void chrome.storage.local.set({ [POPUP_SIZE_KEY]: { w: Math.round(width), h: Math.round(height) } });
    }, 300);
  });
  observer.observe(document.body);
}

// A real chrome.windows popup-type window (as opposed to the action popup) is
// freely, reliably resizable by dragging any of its OS-drawn edges — the same
// page just runs with `?standalone=1` so it can fill that window instead of
// being capped to the action popup's fixed size, and remembers its own size
// across opens via window resize events (not ResizeObserver on body, since in
// this mode body just fills whatever the real window's content area is).
const POPUP_WINDOW_SIZE_KEY = 'mtPopupWindowSize';
const isStandaloneWindow = new URLSearchParams(window.location.search).get('standalone') === '1';
let popupWindowSizeSaveTimer: number | undefined;

async function openInStandaloneWindow(): Promise<void> {
  let width = 460;
  let height = 680;
  try {
    const raw = await chrome.storage.local.get(POPUP_WINDOW_SIZE_KEY);
    const saved = raw[POPUP_WINDOW_SIZE_KEY] as { w?: number; h?: number } | undefined;
    if (saved?.w) width = saved.w;
    if (saved?.h) height = saved.h;
  } catch {
    // chrome.storage unavailable — fall back to the defaults above.
  }
  await chrome.windows.create({
    url: chrome.runtime.getURL('popup/index.html?standalone=1'),
    type: 'popup',
    width,
    height,
  });
  window.close();
}

function initStandaloneWindow(): void {
  document.documentElement.classList.add('standalone-window');
  window.addEventListener('resize', () => {
    window.clearTimeout(popupWindowSizeSaveTimer);
    popupWindowSizeSaveTimer = window.setTimeout(() => {
      void chrome.storage.local.set({
        [POPUP_WINDOW_SIZE_KEY]: { w: window.outerWidth, h: window.outerHeight },
      });
    }, 300);
  });
}

async function init(): Promise<void> {
  initTabs();
  initSettingsSearch();
  initSliders();
  if (isStandaloneWindow) {
    initStandaloneWindow();
  } else {
    await restorePopupSize();
    initPopupResize();
    openWindowBtn.addEventListener('click', () => { void openInStandaloneWindow(); });
  }
  window.addEventListener('blur', () => { void autoSave(); });
  window.addEventListener('beforeunload', () => { void autoSave(); });
  await initSupportChat();
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
  renderConfigSettings();
  settingsLoaded = true;
  setAutoSaveState('saved');

  renderAccountView();
  if (settings.accountToken) void refreshAccountStatus();

  renderStoryDbView();
  if (settings.accountToken) void loadStoryList();

  bind();
  // Check SearXNG status if already selected
  if (webSearchSourceSelect.value === 'searxng') {
    void handleWebSearchSourceChange();
  }
  await checkHealth(settings.backendUrl);
}

function renderConfigSettings(): void {
  useStoryDbToggle.checked = settings.config.useStoryDb ?? false;
  outsideTextToggle.checked = settings.config.outsideTextEnabled ?? false;
  storyRefImagesToggle.checked = settings.config.useStoryReferenceImages ?? false;
  economyModeToggle.checked = settings.config.economyMode ?? false;
  combinePageImageToggle.checked = settings.config.combineIntoPageImage ?? true;
  combinePageImageResolutionSelect.value = settings.config.combinePageImageResolution
    ?? (settings.config.combinePageImageMaxSide === 1024 ? 'low'
      : (settings.config.combinePageImageMaxSide ?? 1536) >= 2048 ? 'high' : 'auto');
  updateCombinePageImageResolutionVisibility();
  inpaintingMethodSelect.value = settings.config.inpaintingMethod || 'lama';
  fluxRemoteUrlInput.value = settings.config.fluxRemoteBaseUrl ?? '';
  fluxRemoteTokenInput.value = settings.config.fluxRemoteToken ?? '';
  updateInpaintingMethodVisibility();
  preTranslateToggle.checked = settings.config.preTranslate ?? false;
  textReadingSelect.value = settings.config.translationMode === 'two-step' && settings.config.ocrMethod !== 'LLM' ? settings.config.ocrMethod : 'llm';
  readingDirectionSelect.value = settings.config.readingDirection ?? 'rtl';
  previousContextToggle.checked = settings.config.previousContextEnabled ?? false;
  contextMemoryToggle.checked = settings.config.contextMemoryEnabled ?? false;
  contextMemorySequentialToggle.checked = settings.config.contextMemorySequential ?? false;
  minFontSizeInput.value = String(settings.config.minFontSize ?? 8);
  maxFontSizeInput.value = String(settings.config.maxFontSize ?? 16);
  supersamplingSelect.value = String(settings.config.supersamplingFactor ?? 4);
  void loadFontPackOptions(settings.backendUrl, settings.config.fontDir);

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
  preReplacementsInput.value = settings.config.preReplacements ?? '';
  postReplacementsInput.value = settings.config.postReplacements ?? '';
  letteringUppercaseToggle.checked = settings.config.letteringUppercase ?? false;
  letteringAlignSelect.value = settings.config.letteringAlign ?? 'center';
  letteringTextColorMode.value = settings.config.letteringTextColor ? 'custom' : 'auto';
  if (settings.config.letteringTextColor) letteringTextColorInput.value = settings.config.letteringTextColor;
  letteringOutlineWidthSelect.value = String(settings.config.letteringOutlineWidth ?? 0);
  letteringOutlineColorMode.value = settings.config.letteringOutlineColor ? 'custom' : 'auto';
  if (settings.config.letteringOutlineColor) letteringOutlineColorInput.value = settings.config.letteringOutlineColor;
  updateLetteringVisibility();
  suggestStoryTitleInput.value = settings.config.suggestStoryTitle ?? '';
  suggestWebSearchToggle.checked = settings.config.suggestWebSearch ?? false;
  webSearchSourceSelect.value = settings.config.webSearchProvider ?? 'provider';
}

function bind(): void {
  if (isBound) return;
  isBound = true;

  saveBtn.addEventListener('click', async () => { await saveAndReport('statusSettingsSaved'); });
  saveConfigBtn.addEventListener('click', async () => { await saveAndReport('statusSettingsSaved'); });
  resetPreferencesBtn.addEventListener('click', () => { void handleResetPreferences(); });
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

  for (const el of [backendInput, webSearchSourceSelect, sourceInput, targetInput, useStoryDbToggle, outsideTextToggle, storyRefImagesToggle, economyModeToggle, combinePageImageToggle, combinePageImageResolutionSelect, fontPackSelect, minFontSizeInput, maxFontSizeInput, supersamplingSelect, textReadingSelect, readingDirectionSelect, preTranslateToggle, previousContextToggle, contextMemoryToggle, contextMemorySequentialToggle, inpaintingMethodSelect, fluxRemoteUrlInput, fluxRemoteTokenInput, suggestStoryTitleInput, suggestWebSearchToggle]) {
    el.addEventListener('change', () => { void autoSave(); });
  }
  sourceInput.addEventListener('input', updateSourceAutoStyle);
  // The Live AI log viewer is a full extension page in its own tab (the popup
  // is far too small to read prompts in); it reads the backend URL and account
  // token itself, so nothing needs passing along.
  openLiveAiBtn.addEventListener('click', () => {
    void chrome.tabs.create({ url: chrome.runtime.getURL('live-ai/index.html') });
  });
  for (const el of [letteringUppercaseToggle, letteringAlignSelect, letteringTextColorMode, letteringTextColorInput, letteringOutlineWidthSelect, letteringOutlineColorMode, letteringOutlineColorInput]) {
    el.addEventListener('change', () => { updateLetteringVisibility(); void autoSave(); });
  }

  outsideTextToggle.addEventListener('change', updateInpaintingMethodVisibility);
  combinePageImageToggle.addEventListener('change', updateCombinePageImageResolutionVisibility);
  inpaintingMethodSelect.addEventListener('change', updateInpaintingMethodVisibility);
  testFluxRemoteBtn.addEventListener('click', () => { void handleTestFluxRemote(); });
  testWebSearchBtn.addEventListener('click', () => { void handleTestWebSearch(); });
  webSearchSourceSelect.addEventListener('change', () => { void handleWebSearchSourceChange(); });

  uiLanguageSelect.addEventListener('change', () => {
    uiLanguage = normalizeUiLanguage(uiLanguageSelect.value);
    settings = collectAllSettings();
    applyI18n();
    renderLanguageSelects();
    void autoSave();
  });

  for (const el of [instructionsInput, llmInstructionsInput, preReplacementsInput, postReplacementsInput]) {
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

  eraserBtn.addEventListener('click', async () => {
    eraserBtn.disabled = true;
    try {
      await autoSave();
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error(t(uiLanguage, 'errorNoActiveTab'));
      const injected = await ensureContentScript(tab.id);
      if (!injected) throw new Error(t(uiLanguage, 'errorInjectContent'));
      await chrome.tabs.sendMessage(tab.id, { type: 'START_ERASER_SELECT' });
      window.close();
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err), 'err');
      eraserBtn.disabled = false;
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
    if (suggestWebSearchToggle.checked
      && webSearchSourceSelect.value === 'searxng'
      && !suggestStoryTitleInput.value.trim()) {
      setStatus(t(uiLanguage, 'errorSuggestSearxngTitleRequired'), 'err');
      return;
    }
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
  useStoryDbToggle.addEventListener('change', () => { void checkStoryDomainMismatch(storySelect.value); });
  storyNewBtn.addEventListener('click', () => { void handleStoryNew(); });
  addStoryCharacterBtn.addEventListener('click', () => { addStoryCharacterRow(); });
  addStoryRelationshipBtn.addEventListener('click', () => { addStoryRelationshipRow(); });
  addStoryGlossaryBtn.addEventListener('click', () => { addStoryGlossaryRow(); });
  addStoryContinuityNoteBtn.addEventListener('click', () => { addStoryContinuityNoteRow(); });
  storySaveBtn.addEventListener('click', () => { void handleStorySave(); });
  storyDeleteBtn.addEventListener('click', () => { void handleStoryDelete(); });
  storyExportBtn.addEventListener('click', () => { handleStoryExport(); });
  storyImportBtn.addEventListener('click', () => { storyImportFileInput.click(); });
  storyImportFileInput.addEventListener('change', () => {
    const file = storyImportFileInput.files?.[0];
    storyImportFileInput.value = '';
    if (file) void handleStoryImportFile(file);
  });
  storyUpdateFromDescriptionBtn.addEventListener('click', () => { void handleStoryUpdateFromDescription(); });
  const onStoryFieldChange = (ev: Event): void => {
    scheduleStoryDraftSave();
    // Undo/redo is about the story's actual data, not the scratch
    // "update from description" input box.
    if (ev.target !== storyUpdateDescriptionInput) scheduleStoryHistoryCheckpoint();
  };
  storyContentFields.addEventListener('input', onStoryFieldChange);
  storyContentFields.addEventListener('change', onStoryFieldChange);
  // Adding/removing a character/relationship/glossary/note row, and dragging
  // a node in the relationship map (which sets data-x/data-y directly), are
  // structural DOM changes that don't fire input/change — a MutationObserver
  // catches those too, so nothing needs a bespoke draft-save/history call at
  // each individual add/remove/drag site.
  new MutationObserver(() => {
    scheduleStoryDraftSave();
    scheduleStoryHistoryCheckpoint();
  }).observe(storyContentFields, {
    childList: true, subtree: true, attributes: true, attributeFilter: ['data-x', 'data-y', 'data-avatar', 'data-refs'],
  });
  storyDraftDiscardBtn.addEventListener('click', () => { void handleStoryDraftDiscard(); });
  storyUndoBtn.addEventListener('click', handleStoryUndo);
  storyRedoBtn.addEventListener('click', handleStoryRedo);
  storyContentFields.addEventListener('keydown', (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || ev.key.toLowerCase() !== 'z') return;
    ev.preventDefault();
    if (ev.shiftKey) handleStoryRedo(); else handleStoryUndo();
  });
}

async function handleResetPreferences(): Promise<void> {
  const previous = settings;
  settings = normalizeSettings({
    ...settings,
    extensionEnabled: DEFAULT_SETTINGS.extensionEnabled,
    config: {
      ...DEFAULT_SETTINGS.config,
      providerGroups: settings.config.providerGroups,
      // Keep the optional remote inpainting connection details; these are
      // service credentials/URLs, not translation preferences.
      fluxRemoteBaseUrl: settings.config.fluxRemoteBaseUrl,
      fluxRemoteToken: settings.config.fluxRemoteToken,
      // Preserve user-authored content and replacement rules as well.
      specialInstructions: settings.config.specialInstructions,
      llmInstructions: settings.config.llmInstructions,
      preReplacements: settings.config.preReplacements,
      postReplacements: settings.config.postReplacements,
      suggestStoryTitle: settings.config.suggestStoryTitle,
    },
  });
  extensionEnabledToggle.checked = settings.extensionEnabled;
  applyExtensionEnabledState();
  renderLanguageSelects();
  renderConfigSettings();

  const saved = await autoSave();
  if (saved) {
    setStatus(t(uiLanguage, 'statusPreferencesReset'), 'ok');
  } else {
    settings = previous;
    extensionEnabledToggle.checked = settings.extensionEnabled;
    applyExtensionEnabledState();
    renderLanguageSelects();
    renderConfigSettings();
    setStatus(t(uiLanguage, 'statusSaveFailed'), 'err');
  }
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

function updateCombinePageImageResolutionVisibility(): void {
  combinePageImageResolutionRow.style.display = combinePageImageToggle.checked ? '' : 'none';
}

// Always shown (not only with Outside text on): the Eraser and Select text
// area tools also use LaMa when it's picked here.
function updateInpaintingMethodVisibility(): void {
  inpaintingMethodField.style.display = '';
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

async function handleTestWebSearch(): Promise<void> {
  const query = webSearchTestQueryInput.value.trim();
  webSearchTestStatus.className = 'bk-test-status';
  webSearchTestStatus.textContent = '';
  webSearchTestStatus.title = '';
  webSearchTestResults.style.display = 'none';
  webSearchTestResults.textContent = '';
  if (!query) {
    webSearchTestStatus.className = 'bk-test-status fail';
    webSearchTestStatus.textContent = t(uiLanguage, 'errorTestWebSearchQuery');
    return;
  }

  testWebSearchBtn.disabled = true;
  webSearchTestStatus.className = 'bk-test-status pending';
  webSearchTestStatus.textContent = t(uiLanguage, 'statusTestWebSearchPending');
  try {
    await autoSave();
    const result = await new Promise<{ query?: string; result_count?: number; results?: string; error?: string }>((resolve) => {
      chrome.runtime.sendMessage({ type: 'TEST_WEB_SEARCH', query }, (response: unknown) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) { resolve({ error: lastError.message }); return; }
        resolve((response as { query?: string; result_count?: number; results?: string; error?: string }) ?? { error: 'No response from background service worker.' });
      });
    });
    if (result.error) {
      webSearchTestStatus.className = 'bk-test-status fail';
      webSearchTestStatus.textContent = '✗';
      webSearchTestStatus.title = result.error;
      webSearchTestResults.textContent = result.error;
      webSearchTestResults.style.display = 'block';
      return;
    }
    const count = result.result_count ?? 0;
    webSearchTestStatus.className = `bk-test-status ${count ? 'ok' : 'fail'}`;
    // Keep this badge short — it sits in a tight flex row next to the
    // input/button. The full "connected but empty" sentence goes in the
    // title tooltip instead; the detailed backend diagnostic (e.g. which
    // SearXNG engines were blocked) is already shown below in the results
    // <pre>, so it doesn't need repeating here too.
    webSearchTestStatus.textContent = t(uiLanguage, 'statusTestWebSearchCount', { count });
    webSearchTestStatus.title = count ? (result.query ?? query) : t(uiLanguage, 'statusTestWebSearchEmpty');
    webSearchTestResults.textContent = result.results ?? '';
    webSearchTestResults.style.display = 'block';
  } finally {
    testWebSearchBtn.disabled = false;
  }
}

async function handleWebSearchSourceChange(): Promise<void> {
  const selectedSource = webSearchSourceSelect.value;
  if (selectedSource !== 'searxng') {
    searxngStartStatus.className = 'bk-test-status';
    searxngStartStatus.textContent = '';
    searxngStartStatus.title = '';
    return;
  }

  searxngStartStatus.className = 'bk-test-status pending';
  searxngStartStatus.textContent = t(uiLanguage, 'statusSearxngStarting');
  try {
    await autoSave();
    const result = await new Promise<{ ready?: boolean; started?: boolean; url?: string; error?: string }>((resolve) => {
      chrome.runtime.sendMessage({ type: 'ENSURE_SEARXNG' }, (response: unknown) => {
        const lastError = chrome.runtime.lastError;
        if (lastError) { resolve({ error: lastError.message }); return; }
        resolve((response as { ready?: boolean; started?: boolean; url?: string; error?: string }) ?? { error: 'No response from background service worker.' });
      });
    });
    if (result.error) {
      searxngStartStatus.className = 'bk-test-status fail';
      searxngStartStatus.textContent = t(uiLanguage, 'statusSearxngError');
      searxngStartStatus.title = result.error;
      return;
    }
    if (result.ready) {
      searxngStartStatus.className = 'bk-test-status ok';
      searxngStartStatus.textContent = t(uiLanguage, 'statusSearxngReady');
      if (result.started) {
        searxngStartStatus.title = t(uiLanguage, 'statusSearxngReady') + ' (auto-started)';
      } else {
        searxngStartStatus.title = t(uiLanguage, 'statusSearxngReady') + ' (already running)';
      }
    }
  } catch (error) {
    searxngStartStatus.className = 'bk-test-status fail';
    searxngStartStatus.textContent = t(uiLanguage, 'statusSearxngError');
    searxngStartStatus.title = error instanceof Error ? error.message : String(error);
  }
}

async function autoSave(): Promise<boolean> {
  if (!settingsLoaded) return false;
  const revision = ++settingsSaveRevision;
  setAutoSaveState('saving');
  const next = collectAllSettings();
  const saved = await saveSettings(next);
  if (saved) settings = next;
  if (revision === settingsSaveRevision) setAutoSaveState(saved ? 'saved' : 'error');
  return saved;
}

function setAutoSaveState(state: 'saving' | 'saved' | 'error'): void {
  settingsSaveState = state;
  renderAutoSaveStatus();
}

function renderAutoSaveStatus(): void {
  settingsSaveStatusEl.dataset.state = settingsSaveState;
  const key: I18nKey | null = settingsSaveState === 'saving'
    ? 'statusAutoSaveSaving'
    : settingsSaveState === 'saved'
      ? 'statusAutoSaveSaved'
      : settingsSaveState === 'error'
        ? 'statusAutoSaveFailed'
        : null;
  settingsSaveStatusEl.textContent = key ? t(uiLanguage, key) : '';
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
      useStoryDb: useStoryDbToggle.checked,
      outsideTextEnabled: outsideTextToggle.checked,
      useStoryReferenceImages: storyRefImagesToggle.checked,
      economyMode: economyModeToggle.checked,
      combineIntoPageImage: combinePageImageToggle.checked,
      combinePageImageResolution: combinePageImageResolutionSelect.value as NonNullable<TranslateConfig['combinePageImageResolution']>,
      // Keep the numeric field for compatibility with older backends; the
      // newer backend uses the resolution mode above when it is present.
      combinePageImageMaxSide: ({ low: 1024, standard: 1536, high: 2560, auto: 1536 } as const)[combinePageImageResolutionSelect.value as 'low' | 'standard' | 'high' | 'auto'],
      readingDirection: readingDirectionSelect.value as TranslateConfig['readingDirection'],
      fontDir: fontPackSelect.value || undefined,
      minFontSize: Math.max(1, parseInt(minFontSizeInput.value, 10) || DEFAULT_SETTINGS.config.minFontSize),
      maxFontSize: Math.max(1, parseInt(maxFontSizeInput.value, 10) || DEFAULT_SETTINGS.config.maxFontSize),
      supersamplingFactor: parseInt(supersamplingSelect.value, 10) || DEFAULT_SETTINGS.config.supersamplingFactor,
      inpaintingMethod: inpaintingMethodSelect.value || 'lama',
      fluxRemoteBaseUrl: fluxRemoteUrlInput.value.trim() || undefined,
      fluxRemoteToken: fluxRemoteTokenInput.value.trim() || undefined,
      // One select drives the (translationMode, ocrMethod) pair the backend takes:
      // a local OCR only makes sense with the two-step flow, and vice versa.
      translationMode: textReadingSelect.value === 'llm' ? 'one-step' : 'two-step',
      ocrMethod: textReadingSelect.value === 'llm' ? 'LLM' : (textReadingSelect.value as TranslateConfig['ocrMethod']),
      preTranslate: preTranslateToggle.checked,
      previousContextEnabled: previousContextToggle.checked,
      contextMemoryEnabled: contextMemoryToggle.checked,
      contextMemorySequential: contextMemorySequentialToggle.checked,
      specialInstructions: instructionsInput.value.trim() || undefined,
      llmInstructions: llmInstructionsInput.value.trim() || undefined,
      preReplacements: preReplacementsInput.value.trim() || undefined,
      postReplacements: postReplacementsInput.value.trim() || undefined,
      letteringUppercase: letteringUppercaseToggle.checked || undefined,
      letteringAlign: letteringAlignSelect.value === 'center' ? undefined : (letteringAlignSelect.value as TranslateConfig['letteringAlign']),
      letteringTextColor: letteringTextColorMode.value === 'custom' ? letteringTextColorInput.value : undefined,
      letteringOutlineWidth: parseInt(letteringOutlineWidthSelect.value, 10) || undefined,
      letteringOutlineColor: letteringOutlineColorMode.value === 'custom' ? letteringOutlineColorInput.value : undefined,
      suggestStoryTitle: suggestStoryTitleInput.value.trim() || undefined,
      suggestWebSearch: suggestWebSearchToggle.checked,
      webSearchProvider: (webSearchSourceSelect.value || 'provider') as TranslateConfig['webSearchProvider'],
      providerGroups: collectProviderGroups(),
    },
  };
}

// Color pickers only show once "Custom" is chosen; the outline color only
// matters when there is an outline.
function updateLetteringVisibility(): void {
  letteringTextColorInput.style.display = letteringTextColorMode.value === 'custom' ? '' : 'none';
  const hasOutline = letteringOutlineWidthSelect.value !== '0';
  letteringOutlineColorMode.style.display = hasOutline ? '' : 'none';
  letteringOutlineColorInput.style.display = hasOutline && letteringOutlineColorMode.value === 'custom' ? '' : 'none';
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

let statusHideTimer: number | undefined;

// The status line is fixed to the popup's own viewport (see its CSS) so it
// stays visible regardless of scroll position in a tall tab — but that also
// means it should get out of the way again once its job is done. A success
// message auto-hides after a few seconds; an error stays until replaced, so
// the user has time to actually read it.
function setStatus(message: string, type: '' | 'ok' | 'err'): void {
  window.clearTimeout(statusHideTimer);
  statusEl.textContent = message;
  statusEl.className = type;
  statusEl.classList.toggle('visible', message.length > 0);
  if (type === 'ok' && message) {
    statusHideTimer = window.setTimeout(() => { statusEl.classList.remove('visible'); }, 3000);
  }
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

// "Active story" (settings.activeStoryId) is one global selection, not
// per-site — nothing stops the user from forgetting to switch it when they
// move from reading one manga to another, and a wrong selection means the
// wrong character DB/glossary gets silently applied. We don't auto-switch it
// for them (too easy to override a choice they made on purpose), but we can
// warn: background/index.ts remembers the last story actually used per
// hostname (chrome.storage.local['mtStoryDomainMap']) every time a translate
// request goes out with a story_id, and this checks the currently active
// tab's hostname against that the moment a story is loaded into the form.
const STORY_DOMAIN_MAP_KEY = 'mtStoryDomainMap';

async function checkStoryDomainMismatch(currentStoryId: string): Promise<void> {
  storyDomainMismatchWarning.style.display = 'none';
  // Nothing to warn about if the Translate tab's "Use Story DB" toggle is
  // off — no story_id is ever sent in that case, so no mismatch is possible.
  if (!currentStoryId || !useStoryDbToggle.checked) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.url) return;
    const hostname = new URL(tab.url).hostname;
    if (!hostname) return;
    const raw = await chrome.storage.local.get(STORY_DOMAIN_MAP_KEY);
    const map = raw[STORY_DOMAIN_MAP_KEY] as Record<string, string> | undefined;
    const previousStoryId = map?.[hostname];
    if (!previousStoryId || previousStoryId === currentStoryId) return;
    const previousStoryName = Array.from(storySelect.options).find((o) => o.value === previousStoryId)?.textContent;
    if (!previousStoryName) return; // that story was renamed/deleted since — nothing useful to say
    storyDomainMismatchWarning.textContent = t(uiLanguage, 'warningStoryDomainMismatch', { domain: hostname, story: previousStoryName });
    storyDomainMismatchWarning.style.display = '';
  } catch {
    // chrome.tabs unavailable, or tab.url unreadable (e.g. a chrome:// page) — nothing to warn about.
  }
}

async function refreshStoryOptions(preferredId?: string): Promise<string> {
  const result = await storyMessage<StoryListMessageResult>('STORY_LIST');
  if (!result.ok || !result.stories) {
    setStatus(`${t(uiLanguage, 'errorStoryListFailed')}: ${result.error ?? ''}`, 'err');
    return '';
  }
  return populateStorySelect(result.stories, preferredId);
}

// Popups get torn down and rebuilt from scratch every time they're closed —
// unlike the other tabs (which autosave to the account/settings on every
// change), Story DB only ever commits on an explicit "Save story" click, so
// anything typed but not yet saved was silently lost the moment the popup
// closed (clicking elsewhere on the page closes it, same as any browser
// action popup). This mirrors that same content into chrome.storage.local
// as a per-story draft, restored the next time the popup opens on that
// story, and cleared once it's actually saved (or the story is deleted).
interface StoryDraft {
  name: string;
  characters: StoryCharacter[];
  relationships: StoryRelationship[];
  glossary: StoryGlossaryTerm[];
  continuityNotes: StoryContinuityNote[];
  continuityNotesEnabled: boolean;
  updateDescription: string;
  savedAt: number;
}

const storyDraftKey = (id: string): string => `mtStoryDraft:${id}`;
let storyDraftSaveTimer: number | undefined;

function scheduleStoryDraftSave(): void {
  const id = storySelect.value;
  if (!id) return;
  window.clearTimeout(storyDraftSaveTimer);
  storyDraftSaveTimer = window.setTimeout(() => { void saveStoryDraftNow(id); }, 500);
}

async function saveStoryDraftNow(id: string): Promise<void> {
  const draft: StoryDraft = {
    name: storyNameInput.value,
    characters: collectStoryCharacters(),
    relationships: collectStoryRelationships(),
    glossary: collectStoryGlossary(),
    continuityNotes: collectStoryContinuityNotes(),
    continuityNotesEnabled: storyContinuityEnabledToggle.checked,
    updateDescription: storyUpdateDescriptionInput.value,
    savedAt: Date.now(),
  };
  try {
    await chrome.storage.local.set({ [storyDraftKey(id)]: draft });
  } catch { /* storage is best-effort — worst case the draft just doesn't survive a reopen */ }
}

async function loadStoryDraft(id: string): Promise<StoryDraft | null> {
  try {
    const raw = await chrome.storage.local.get(storyDraftKey(id));
    return (raw[storyDraftKey(id)] as StoryDraft | undefined) ?? null;
  } catch {
    return null;
  }
}

async function clearStoryDraft(id: string): Promise<void> {
  try {
    await chrome.storage.local.remove(storyDraftKey(id));
  } catch { /* ignore */ }
}

function applyStoryDraft(draft: StoryDraft): void {
  storyNameInput.value = draft.name;
  renderStoryCharacters(draft.characters);
  renderStoryRelationships(draft.relationships);
  renderStoryGlossary(draft.glossary);
  storyContinuityEnabledToggle.checked = draft.continuityNotesEnabled;
  renderStoryContinuityNotes(draft.continuityNotes);
  storyUpdateDescriptionInput.value = draft.updateDescription ?? '';
}

// ── Story DB undo/redo ──────────────────────────────────────────────────────
// A history of form snapshots, separate from the draft-recovery mechanism
// above (which is about surviving a *closed popup*; this is about stepping
// back and forth *within* one editing session). Deliberately excludes the
// "update from description" textarea — undo/redo is about the story's actual
// data, not a scratch input box. Reset to empty every time a story is
// (re)loaded, so there is nothing to undo past the state it loaded in.
interface StorySnapshot {
  name: string;
  characters: StoryCharacter[];
  relationships: StoryRelationship[];
  glossary: StoryGlossaryTerm[];
  continuityNotes: StoryContinuityNote[];
  continuityNotesEnabled: boolean;
}

let storyUndoStack: StorySnapshot[] = [];
let storyRedoStack: StorySnapshot[] = [];
let storyHistoryCurrent: StorySnapshot | null = null;
let storyHistoryTimer: number | undefined;
let applyingStoryHistory = false;
const STORY_HISTORY_LIMIT = 50;

function captureStorySnapshot(): StorySnapshot {
  return {
    name: storyNameInput.value,
    characters: collectStoryCharacters(),
    relationships: collectStoryRelationships(),
    glossary: collectStoryGlossary(),
    continuityNotes: collectStoryContinuityNotes(),
    continuityNotesEnabled: storyContinuityEnabledToggle.checked,
  };
}

function snapshotsEqual(a: StorySnapshot, b: StorySnapshot): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function applyStorySnapshot(snap: StorySnapshot): void {
  storyNameInput.value = snap.name;
  renderStoryCharacters(snap.characters);
  renderStoryRelationships(snap.relationships);
  renderStoryGlossary(snap.glossary);
  storyContinuityEnabledToggle.checked = snap.continuityNotesEnabled;
  renderStoryContinuityNotes(snap.continuityNotes);
}

function updateStoryUndoRedoButtons(): void {
  storyUndoBtn.disabled = storyUndoStack.length === 0;
  storyRedoBtn.disabled = storyRedoStack.length === 0;
}

/** Resets history to "nothing to undo past the current state" — called
 * whenever a story is (re)loaded (including after restoring a draft). */
function resetStoryHistory(): void {
  window.clearTimeout(storyHistoryTimer);
  storyUndoStack = [];
  storyRedoStack = [];
  storyHistoryCurrent = captureStorySnapshot();
  updateStoryUndoRedoButtons();
}

/** Pushes the *previous* checkpoint onto the undo stack and adopts the
 * live form as the new checkpoint, if it actually differs — called after a
 * debounced pause in editing so rapid typing collapses into one undo step,
 * not one per keystroke. */
function commitStoryHistoryCheckpoint(): void {
  if (applyingStoryHistory) return;
  const snap = captureStorySnapshot();
  if (storyHistoryCurrent && snapshotsEqual(snap, storyHistoryCurrent)) return;
  if (storyHistoryCurrent) {
    storyUndoStack.push(storyHistoryCurrent);
    if (storyUndoStack.length > STORY_HISTORY_LIMIT) storyUndoStack.shift();
  }
  storyHistoryCurrent = snap;
  storyRedoStack = [];
  updateStoryUndoRedoButtons();
}

function scheduleStoryHistoryCheckpoint(): void {
  if (applyingStoryHistory) return;
  window.clearTimeout(storyHistoryTimer);
  storyHistoryTimer = window.setTimeout(commitStoryHistoryCheckpoint, 600);
}

function handleStoryUndo(): void {
  window.clearTimeout(storyHistoryTimer);
  commitStoryHistoryCheckpoint(); // finalise whatever's mid-edit first, so undo reverts it like any other step
  if (!storyUndoStack.length || !storyHistoryCurrent) return;
  const previous = storyUndoStack.pop()!;
  storyRedoStack.push(storyHistoryCurrent);
  applyingStoryHistory = true;
  applyStorySnapshot(previous);
  applyingStoryHistory = false;
  storyHistoryCurrent = previous;
  updateStoryUndoRedoButtons();
}

function handleStoryRedo(): void {
  if (!storyRedoStack.length || !storyHistoryCurrent) return;
  const next = storyRedoStack.pop()!;
  storyUndoStack.push(storyHistoryCurrent);
  applyingStoryHistory = true;
  applyStorySnapshot(next);
  applyingStoryHistory = false;
  storyHistoryCurrent = next;
  updateStoryUndoRedoButtons();
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
  storyUpdateDescriptionInput.value = '';
  storyContentFields.style.display = '';
  storyDraftBanner.style.display = 'none';
  settings.activeStoryId = id;
  await autoSave();
  await checkStoryDomainMismatch(id);

  const draft = await loadStoryDraft(id);
  if (draft) {
    applyStoryDraft(draft);
    storyDraftBanner.style.display = 'flex';
  }
  resetStoryHistory();
}

async function handleStoryDraftDiscard(): Promise<void> {
  const id = storySelect.value;
  if (!id) return;
  if (!window.confirm(t(uiLanguage, 'confirmStoryDraftDiscard'))) return;
  await clearStoryDraft(id);
  storyDraftBanner.style.display = 'none';
  await loadStoryIntoForm(id); // reloads from the server, with no draft left to restore
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
    storyDomainMismatchWarning.style.display = 'none';
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
    await clearStoryDraft(id); // now safely persisted server-side — no draft left to restore
    storyDraftBanner.style.display = 'none';
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
    await clearStoryDraft(id);
    await loadStoryList();
    setStatus(t(uiLanguage, 'statusStoryDeleted'), 'ok');
  } finally {
    storyDeleteBtn.disabled = false;
  }
}

// Export/import a Story DB as a plain JSON file — to back it up or hand it to
// a co-translator/editor, since a Story DB otherwise only lives on one
// account. Exports whatever is currently in the form (including unsaved
// edits); import fills the form for review, it does not save by itself —
// the user still clicks "Save story" to commit it.
function handleStoryExport(): void {
  const id = storySelect.value;
  if (!id) return;
  const payload = {
    name: storyNameInput.value.trim(),
    characters: collectStoryCharacters(),
    relationships: collectStoryRelationships(),
    glossary: collectStoryGlossary(),
    continuity_notes: collectStoryContinuityNotes(),
    continuity_notes_enabled: storyContinuityEnabledToggle.checked,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  const safeName = (payload.name || 'story').replace(/[^\w.-]+/g, '_');
  a.download = `${safeName}.mtstory.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function handleStoryImportFile(file: File): Promise<void> {
  if (!storySelect.value) {
    setStatus(t(uiLanguage, 'errorStoryImportNoStory'), 'err');
    return;
  }
  try {
    const data = JSON.parse(await file.text()) as Partial<StoryDetail>;
    if (!Array.isArray(data.characters) || !Array.isArray(data.relationships) || !Array.isArray(data.glossary)) {
      throw new Error('unrecognized file shape');
    }
    if (typeof data.name === 'string' && data.name.trim()) storyNameInput.value = data.name.trim();
    renderStoryCharacters(data.characters);
    renderStoryRelationships(data.relationships);
    renderStoryGlossary(data.glossary);
    storyContinuityEnabledToggle.checked = !!data.continuity_notes_enabled;
    renderStoryContinuityNotes(Array.isArray(data.continuity_notes) ? data.continuity_notes : []);
    storyContentFields.style.display = '';
    scheduleStoryDraftSave(); // imported content isn't saved server-side until Save story — protect it the same as any other unsaved edit
    setStatus(t(uiLanguage, 'statusStoryImported'), 'ok');
  } catch {
    setStatus(t(uiLanguage, 'errorStoryImportFailed'), 'err');
  }
}

/** The first enabled provider group with at least one enabled key — this
 * feature is a low-frequency, one-off helper (like "Suggest Notes"), so it
 * deliberately doesn't pull in the full rotation/fallback-provider
 * machinery content-script.ts's buildProviderRotation assembles for the
 * actual translate loop. */
function firstEnabledProvider(): { provider: string; modelName?: string; apiKey?: string; baseUrl?: string } | null {
  for (const group of settings.config.providerGroups ?? []) {
    if (group.enabled === false) continue;
    const key = group.apiKeys.find((k) => k.enabled);
    if (key) return { provider: group.provider, modelName: group.modelName, apiKey: key.key, baseUrl: group.baseUrl };
  }
  return null;
}

interface StoryUpdateMessageResult {
  ok: boolean;
  characters?: StoryCharacter[];
  relationships?: StoryRelationship[];
  continuityNote?: StoryContinuityNote | null;
  error?: string;
}

async function handleStoryUpdateFromDescription(): Promise<void> {
  const description = storyUpdateDescriptionInput.value.trim();
  if (!description) {
    storyUpdateStatus.className = 'story-update-status error';
    storyUpdateStatus.textContent = t(uiLanguage, 'errorStoryUpdateNoDescription');
    return;
  }
  const providerInfo = firstEnabledProvider();
  if (!providerInfo) {
    storyUpdateStatus.className = 'story-update-status error';
    storyUpdateStatus.textContent = t(uiLanguage, 'errorNoProviderConfigured');
    return;
  }

  storyUpdateFromDescriptionBtn.disabled = true;
  storyUpdateStatus.className = 'story-update-status pending';
  storyUpdateStatus.textContent = t(uiLanguage, storyUpdateWebSearchToggle.checked ? 'statusStorySearchingWeb' : 'statusStoryUpdating');
  try {
    const result = await storyMessage<StoryUpdateMessageResult>('STORY_UPDATE_FROM_DESCRIPTION', {
      body: {
        description,
        characters: collectStoryCharacters(),
        relationships: collectStoryRelationships(),
        input_language: settings.config.inputLanguage,
        output_language: settings.config.outputLanguage,
        provider: providerInfo.provider,
        model_name: providerInfo.modelName,
        api_key: providerInfo.apiKey,
        base_url: providerInfo.baseUrl,
        enable_web_search: storyUpdateWebSearchToggle.checked,
        web_search_provider: settings.config.webSearchProvider ?? 'provider',
        story_title: storyNameInput.value.trim() || undefined,
      },
    });
    if (!result.ok || !result.characters || !result.relationships) {
      storyUpdateStatus.className = 'story-update-status error';
      storyUpdateStatus.textContent = `${t(uiLanguage, 'errorStoryUpdateFailed')}: ${result.error ?? ''}`;
      return;
    }
    renderStoryCharacters(result.characters);
    renderStoryRelationships(result.relationships);
    if (result.continuityNote) {
      renderStoryContinuityNotes([...collectStoryContinuityNotes(), result.continuityNote]);
    }
    storyUpdateDescriptionInput.value = '';
    scheduleStoryDraftSave(); // the merged result isn't saved server-side until Save story — protect it the same as any other unsaved edit
    storyUpdateStatus.className = 'story-update-status success';
    storyUpdateStatus.textContent = t(uiLanguage, 'statusStoryUpdated');
  } catch (e) {
    storyUpdateStatus.className = 'story-update-status error';
    storyUpdateStatus.textContent = e instanceof Error ? e.message : String(e);
  } finally {
    storyUpdateFromDescriptionBtn.disabled = false;
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
  // A character freshly loaded from the backend always carries explicit
  // `x`/`y` keys — Pydantic serialises an unset Optional field as JSON
  // `null`, not by omitting the key — so `!== undefined` alone let a
  // never-dragged character's position through as the literal string
  // "null", which Number() turns into NaN and the graph then renders at a
  // garbled (0,0)-ish spot. Only accept an actual number.
  if (typeof data?.x === 'number' && typeof data?.y === 'number') {
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

  const roleField = createAutoGrowField('sc-role', 'placeholderCharacterRole', data?.role ?? '');

  const voiceField = createAutoGrowField('sc-voice', 'placeholderCharacterVoice', data?.voice_notes ?? '');

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

// Story DB free-text fields (role, voice notes, relationship, notes): a
// textarea that starts one line tall and grows with its content (see
// .textarea-auto) — a single-line input hid everything past its width.
function createAutoGrowField(className: string, placeholderKey: I18nKey, value: string): HTMLTextAreaElement {
  const field = document.createElement('textarea');
  field.className = `textarea textarea-auto ${className}`;
  field.rows = 1;
  field.placeholder = t(uiLanguage, placeholderKey);
  field.value = value;
  return field;
}

function createStoryRelationshipRow(data?: StoryRelationship): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'story-rel-row';

  const charASelect = document.createElement('select');
  charASelect.className = 'select sr-char-a';
  const charBSelect = document.createElement('select');
  charBSelect.className = 'select sr-char-b';

  const relationField = createAutoGrowField('sr-relation', 'placeholderRelationSurface', data?.surface_relation ?? '');

  const notesField = createAutoGrowField('sr-notes', 'placeholderRelationNotes', data?.address_notes ?? '');

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

  const notesField = createAutoGrowField('sg-notes', 'placeholderGlossaryNotes', data?.notes ?? '');

  // "Enforce exactly": deterministic post-translation rewrite of this term
  // (and the listed variants), instead of only asking the model nicely.
  const enforceLabel = document.createElement('label');
  enforceLabel.className = 'sg-enforce-label';
  enforceLabel.title = t(uiLanguage, 'hintGlossaryEnforce');
  const enforceBox = document.createElement('input');
  enforceBox.type = 'checkbox';
  enforceBox.className = 'sg-enforce';
  enforceBox.checked = data?.enforce === true;
  const enforceText = document.createElement('span');
  enforceText.textContent = t(uiLanguage, 'labelGlossaryEnforce');
  enforceLabel.appendChild(enforceBox);
  enforceLabel.appendChild(enforceText);

  const variantsField = document.createElement('input');
  variantsField.className = 'input sg-variants';
  variantsField.type = 'text';
  variantsField.placeholder = t(uiLanguage, 'placeholderGlossaryVariants');
  variantsField.value = data?.variants ?? '';
  const syncVariants = (): void => { variantsField.style.display = enforceBox.checked ? '' : 'none'; };
  enforceBox.addEventListener('change', syncVariants);
  syncVariants();

  const removeBtn = document.createElement('button');
  removeBtn.type = 'button';
  removeBtn.className = 'btn-remove-fallback';
  removeBtn.textContent = '×';
  removeBtn.addEventListener('click', () => { row.remove(); });

  row.appendChild(termField);
  row.appendChild(translationField);
  row.appendChild(notesField);
  row.appendChild(enforceLabel);
  row.appendChild(variantsField);
  row.appendChild(removeBtn);
  return row;
}

function createStoryContinuityNoteRow(data?: StoryContinuityNote): HTMLDivElement {
  const row = document.createElement('div');
  row.className = 'story-continuity-note-row';

  const textField = createAutoGrowField('scn-text', 'placeholderContinuityNoteText', data?.text ?? '');

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
    const role = row.querySelector<HTMLTextAreaElement>('.sc-role')?.value.trim() || undefined;
    const voiceNotes = row.querySelector<HTMLTextAreaElement>('.sc-voice')?.value.trim() || undefined;
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
    const surfaceRelation = row.querySelector<HTMLTextAreaElement>('.sr-relation')?.value.trim() ?? '';
    if (!characterAId || !characterBId || !surfaceRelation) continue;
    const addressNotes = row.querySelector<HTMLTextAreaElement>('.sr-notes')?.value.trim() || undefined;
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
    const notes = row.querySelector<HTMLTextAreaElement>('.sg-notes')?.value.trim() || undefined;
    const enforce = row.querySelector<HTMLInputElement>('.sg-enforce')?.checked === true;
    const variants = enforce ? row.querySelector<HTMLInputElement>('.sg-variants')?.value.trim() || undefined : undefined;
    out.push({ id: crypto.randomUUID(), term, translation, notes, ...(enforce ? { enforce, variants } : {}) });
  }
  return out;
}

function collectStoryContinuityNotes(): StoryContinuityNote[] {
  const out: StoryContinuityNote[] = [];
  for (const row of Array.from(storyContinuityNotesList.querySelectorAll<HTMLDivElement>('.story-continuity-note-row'))) {
    const text = row.querySelector<HTMLTextAreaElement>('.scn-text')?.value.trim() ?? '';
    if (!text) continue;
    const sourceLabel = row.querySelector<HTMLInputElement>('.scn-source')?.value.trim() || undefined;
    out.push({ id: crypto.randomUUID(), text, source_label: sourceLabel });
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────
// Help chat ("?" button, header) — answers "how do I use this" questions
// with the user's own configured LLM, grounded in the project's own docs
// (backend/endpoints/translate.py:support_chat). Persisted to
// chrome.storage.local so a conversation survives the popup being closed
// (a Chrome action popup is destroyed, not hidden, on blur), same
// reasoning as the Story DB draft/undo-redo work.
// ─────────────────────────────────────────────────────────────────────────
interface SupportChatEntry {
  role: 'user' | 'assistant';
  content: string;
}

const SUPPORT_CHAT_HISTORY_KEY = 'mtSupportChatHistory';
let supportChatHistory: SupportChatEntry[] = [];

async function loadSupportChatHistory(): Promise<void> {
  try {
    const raw = await chrome.storage.local.get(SUPPORT_CHAT_HISTORY_KEY);
    const stored = raw[SUPPORT_CHAT_HISTORY_KEY];
    if (Array.isArray(stored)) supportChatHistory = stored as SupportChatEntry[];
  } catch {
    // chrome.storage unavailable — start with an empty conversation.
  }
}

function saveSupportChatHistory(): void {
  void chrome.storage.local.set({ [SUPPORT_CHAT_HISTORY_KEY]: supportChatHistory });
}

function renderSupportChatMessages(): void {
  supportChatMessagesEl.innerHTML = '';
  if (supportChatHistory.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'support-chat-empty';
    empty.textContent = t(uiLanguage, 'supportChatEmptyHint');
    supportChatMessagesEl.appendChild(empty);
  } else {
    for (const entry of supportChatHistory) {
      const bubble = document.createElement('div');
      bubble.className = `support-chat-msg ${entry.role}`;
      if (entry.role === 'assistant') {
        bubble.classList.add('md');
        bubble.appendChild(renderMarkdown(entry.content));
      } else {
        bubble.textContent = entry.content;
      }
      supportChatMessagesEl.appendChild(bubble);
    }
  }
  supportChatMessagesEl.scrollTop = supportChatMessagesEl.scrollHeight;
}

function openSupportChat(): void {
  supportChatOverlay.classList.add('open');
  supportChatErrorEl.style.display = 'none';
  renderSupportChatMessages();
  supportChatInput.focus();
}

function closeSupportChat(): void {
  supportChatOverlay.classList.remove('open');
}

async function handleSupportChatClear(): Promise<void> {
  if (supportChatHistory.length === 0) return;
  if (!window.confirm(t(uiLanguage, 'confirmClearSupportChat'))) return;
  supportChatHistory = [];
  saveSupportChatHistory();
  renderSupportChatMessages();
}

async function handleSupportChatSend(): Promise<void> {
  const question = supportChatInput.value.trim();
  if (!question) return;
  supportChatErrorEl.style.display = 'none';

  const providerInfo = firstEnabledProvider();
  if (!providerInfo) {
    supportChatErrorEl.textContent = t(uiLanguage, 'errorNoProviderConfigured');
    supportChatErrorEl.style.display = '';
    return;
  }

  supportChatHistory.push({ role: 'user', content: question });
  saveSupportChatHistory();
  supportChatInput.value = '';
  renderSupportChatMessages();

  const pending = document.createElement('div');
  pending.className = 'support-chat-msg assistant pending';
  pending.textContent = t(uiLanguage, 'supportChatThinking');
  supportChatMessagesEl.appendChild(pending);
  supportChatMessagesEl.scrollTop = supportChatMessagesEl.scrollHeight;

  supportChatSendBtn.disabled = true;
  supportChatInput.disabled = true;
  try {
    const result = await storyMessage<{ reply?: string; error?: string }>('SUPPORT_CHAT', {
      body: {
        messages: supportChatHistory,
        ui_language: UI_LANGUAGES.find((l) => l.code === uiLanguage)?.name,
        provider: providerInfo.provider,
        model_name: providerInfo.modelName,
        api_key: providerInfo.apiKey,
        base_url: providerInfo.baseUrl,
      },
    });
    if (!result.reply) {
      supportChatErrorEl.textContent = `${t(uiLanguage, 'errorSupportChatFailed')}: ${result.error ?? ''}`;
      supportChatErrorEl.style.display = '';
      return;
    }
    supportChatHistory.push({ role: 'assistant', content: result.reply });
    saveSupportChatHistory();
    renderSupportChatMessages();
  } catch (e) {
    supportChatErrorEl.textContent = e instanceof Error ? e.message : String(e);
    supportChatErrorEl.style.display = '';
  } finally {
    pending.remove();
    supportChatSendBtn.disabled = false;
    supportChatInput.disabled = false;
    supportChatInput.focus();
  }
}

async function initSupportChat(): Promise<void> {
  await loadSupportChatHistory();
  helpChatBtn.addEventListener('click', openSupportChat);
  supportChatCloseBtn.addEventListener('click', closeSupportChat);
  supportChatClearBtn.addEventListener('click', () => { void handleSupportChatClear(); });
  supportChatSendBtn.addEventListener('click', () => { void handleSupportChatSend(); });
  supportChatInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      void handleSupportChatSend();
    }
  });
}

void init();
