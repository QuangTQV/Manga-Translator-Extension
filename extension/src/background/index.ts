import { DEFAULT_SETTINGS, normalizeProviderGroups, stripLegacyProviderFields, type AppSettings } from '../shared/types.js';
import type { LiveAiLogEntry, LiveAiLogResult, TranslateRequest, TranslateResponse, StoryDetail, StorySummary, StoryCharacter, StoryRelationship, StoryContinuityNote } from '../shared/types.js';
import { normalizeUiLanguage, t } from '../shared/i18n.js';

const STORAGE_KEY = 'manga_translator_settings';

// The Story DB's "active story" (settings.activeStoryId) is one global
// selection, not per-site — nothing stops a user from forgetting to switch it
// when they move from reading one manga to another. We can't safely
// auto-switch it for them (a translate request already in flight, or a tab
// with a story deliberately different from what a domain "usually" uses,
// would silently get overridden), so instead we just remember the last
// story actually used per hostname here, and the popup (popup/index.ts's
// checkStoryDomainMismatch) warns if the currently selected story doesn't
// match what this site was last translated with.
const STORY_DOMAIN_MAP_KEY = 'mtStoryDomainMap';

async function recordStoryDomainUsage(pageUrl: string | undefined, storyId: string | undefined): Promise<void> {
  if (!storyId || !pageUrl) return;
  let hostname: string;
  try {
    hostname = new URL(pageUrl).hostname;
  } catch {
    return;
  }
  if (!hostname) return;
  try {
    const raw = await chrome.storage.local.get(STORY_DOMAIN_MAP_KEY);
    const map = (raw[STORY_DOMAIN_MAP_KEY] as Record<string, string> | undefined) ?? {};
    if (map[hostname] === storyId) return;
    map[hostname] = storyId;
    await chrome.storage.local.set({ [STORY_DOMAIN_MAP_KEY]: map });
  } catch {
    // Best-effort only — must never affect the actual translate request.
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const current = await chrome.storage.local.get(STORAGE_KEY);
  if (!current[STORAGE_KEY]) {
    await chrome.storage.local.set({ [STORAGE_KEY]: DEFAULT_SETTINGS });
  } else {
    await chrome.storage.local.set({ [STORAGE_KEY]: normalizeSettings(current[STORAGE_KEY] as Partial<AppSettings>) });
  }
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command !== 'toggle-auto-translate') return;
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  try {
    await ensureContentScript(tab.id);
    const status = await chrome.tabs.sendMessage(tab.id, { type: 'GET_AUTO_TRANSLATE_STATUS' });
    await chrome.tabs.sendMessage(tab.id, { type: status?.active ? 'STOP_AUTO_TRANSLATE' : 'START_AUTO_TRANSLATE' });
  } catch {
    // No content script on this page (e.g. chrome:// or an extension gallery
    // page) — nothing to toggle, and no popup open to surface an error to.
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void (async () => {
    if (message.type === 'GET_SETTINGS') {
      sendResponse({ settings: await getSettings() });
      return;
    }

    if (message.type === 'SAVE_SETTINGS') {
      await chrome.storage.local.set({ [STORAGE_KEY]: message.settings as AppSettings });
      sendResponse({ ok: true });
      return;
    }

    if (message.type === 'CHECK_HEALTH') {
      const settings = await getSettings();
      sendResponse(await checkHealth(settings.backendUrl));
      return;
    }

    if (message.type === 'OPEN_SCANNER') {
      const tabId = message.tabId as number | undefined;
      if (!tabId) {
        sendResponse({ ok: false, error: 'Missing tab id' });
        return;
      }

      try {
        await ensureContentScript(tabId);
        await chrome.tabs.sendMessage(tabId, { type: 'OPEN_SCANNER' });
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === 'OPEN_POPUP') {
      try {
        await chrome.action.openPopup();
        sendResponse({ ok: true });
      } catch (error) {
        sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === 'FETCH_IMAGE') {
      const url = message.url as string;
      const pageUrl: string = message.pageUrl as string || '';
      const referer = pageUrl ? pageUrl.split('/').slice(0, 3).join('/') : '';
      console.log('[BG] FETCH_IMAGE url:', url, 'referer:', referer);
      try {
        const res = await fetch(url, {
          headers: {
            'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': referer,
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          },
        });
        console.log('[BG] FETCH_IMAGE response status:', res.status, res.statusText);
        if (!res.ok) {
          console.log('[BG] FETCH_IMAGE failed with', res.status, 'for url:', url);
          sendResponse({ error: `Image fetch failed: HTTP ${res.status} for ${url}` });
          return;
        }
        const blob = await res.blob();
        const reader = new FileReader();
        reader.onloadend = () => {
          const dataUrl = reader.result as string;
          const base64 = dataUrl.replace(/^data:image\/\w+;base64,/, '');
          sendResponse({ base64 });
        };
        reader.onerror = () => {
          console.log('[BG] FETCH_IMAGE FileReader error');
          sendResponse({ error: 'FileReader failed' });
        };
        reader.readAsDataURL(blob);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.log('[BG] FETCH_IMAGE exception:', msg);
        sendResponse({ error: `Fetch exception: ${msg}` });
      }
      return;
    }

    if (message.type === 'FETCH_CHAPTER') {
      const url = message.url as string;
      try {
        const result = await fetchChapterHTML(url);
        sendResponse(result);
      } catch (error) {
        sendResponse({ error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === 'LIST_MODELS') {
      const { baseUrl, apiKey, provider } = message as { type: string; baseUrl: string; apiKey: string; provider?: string };
      console.log('[BG] LIST_MODELS:', baseUrl);
      try {
        const models = await fetchModelList(baseUrl, apiKey, provider);
        console.log('[BG] LIST_MODELS result:', models.length, 'models');
        sendResponse({ models });
      } catch (error) {
        console.log('[BG] LIST_MODELS error:', error);
        sendResponse({ error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === 'TRANSLATE_IMAGE_WITH_BODY') {
      const { imageUrl, pageUrl, body } = message as { type: string; imageUrl: string; pageUrl?: string; body: TranslateRequest };
      console.log('[BG] TRANSLATE_IMAGE_WITH_BODY:', imageUrl, 'pageUrl:', pageUrl);
      try {
        const result = await fetchAndTranslateWithBody(imageUrl, pageUrl, body, sender.tab?.id);
        console.log('[BG] fetchAndTranslateWithBody result:', result);
        sendResponse(result);
      } catch (error) {
        console.log('[BG] fetchAndTranslateWithBody error:', error);
        sendResponse({ error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === 'SUGGEST_INSTRUCTIONS') {
      const { body } = message as { type: string; body: SuggestInstructionsBody };
      try {
        const result = await fetchSuggestInstructions(body);
        sendResponse(result);
      } catch (error) {
        sendResponse({ error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === 'SUPPORT_CHAT') {
      const { body } = message as { type: string; body: SupportChatBody };
      try {
        const result = await fetchSupportChat(body);
        sendResponse(result);
      } catch (error) {
        sendResponse({ error: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    if (message.type === 'TEST_API_KEY') {
      const { body } = message as { type: string; body: TestApiKeyBody };
      sendResponse(await fetchTestApiKey(body));
      return;
    }

    if (message.type === 'TEST_FLUX_REMOTE') {
      const { url, token } = message as { type: string; url: string; token?: string };
      sendResponse(await testFluxRemoteConnection(url, token));
      return;
    }

    if (message.type === 'ACCOUNT_REGISTER') {
      const { email } = message as { type: string; email: string };
      sendResponse(await accountRegister(email));
      return;
    }

    if (message.type === 'ACCOUNT_ME') {
      const { token } = message as { type: string; token?: string };
      sendResponse(await accountMe(token));
      return;
    }

    if (message.type === 'ACCOUNT_SET_PLAN') {
      const { token, plan } = message as { type: string; token: string; plan: string };
      sendResponse(await accountSetPlan(token, plan));
      return;
    }

    if (message.type === 'ACCOUNT_LOGOUT') {
      const { token } = message as { type: string; token: string };
      sendResponse(await accountLogout(token));
      return;
    }

    if (message.type === 'ACCOUNT_GOOGLE_LOGIN') {
      sendResponse(await accountGoogleLogin());
      return;
    }

    if (message.type === 'ADMIN_GET_LLM_CONFIG') {
      sendResponse(await adminGetLlmConfig());
      return;
    }

    if (message.type === 'ADMIN_SET_LLM_CONFIG') {
      const { body } = message as { type: string; body: { provider: string; model_name?: string; api_key?: string; base_url?: string } };
      sendResponse(await adminSetLlmConfig(body));
      return;
    }

    if (message.type === 'LIVE_AI_LOG') {
      const { limit, since } = message as { type: string; limit: number; since?: number };
      sendResponse(await fetchLiveAiLog(limit, since));
      return;
    }

    if (message.type === 'REGION_API') {
      const { path, body } = message as { type: string; path: string; body: Record<string, unknown> };
      sendResponse(await regionApiCall(path, body, sender.tab?.id));
      return;
    }

    if (message.type === 'STORY_LIST') {
      sendResponse(await storiesList());
      return;
    }

    if (message.type === 'STORY_GET') {
      const { id } = message as { type: string; id: string };
      sendResponse(await storyGet(id));
      return;
    }

    if (message.type === 'STORY_CREATE') {
      const { name } = message as { type: string; name: string };
      sendResponse(await storyCreate(name));
      return;
    }

    if (message.type === 'STORY_SAVE') {
      const { id, payload } = message as { type: string; id: string; payload: StoryContextPayload };
      sendResponse(await storySave(id, payload));
      return;
    }

    if (message.type === 'STORY_DELETE') {
      const { id } = message as { type: string; id: string };
      sendResponse(await storyDelete(id));
      return;
    }

    if (message.type === 'STORY_UPDATE_FROM_DESCRIPTION') {
      const { body } = message as { type: string; body: Record<string, unknown> };
      sendResponse(await storyUpdateFromDescription(body));
      return;
    }
  })();

  return true;
});

// ─────────────────────────────────────────────────────────────────────────────
// Fetch model list from OpenAI-compatible endpoint (runs in background — no CORS)
// ─────────────────────────────────────────────────────────────────────────────

// Keep in sync with DEFAULT_AZURE_OPENAI_API_VERSION in backend/utils/endpoints/azure_openai.py
const DEFAULT_AZURE_OPENAI_API_VERSION = '2025-04-01-preview';

async function fetchModelList(baseUrl: string, apiKey: string, provider?: string): Promise<string[]> {
  let endpoint: string;
  const headers: Record<string, string> = { 'Accept': 'application/json' };

  if (provider === 'Azure OpenAI' && /\/openai\/v1\b/i.test(baseUrl)) {
    // Azure AI Foundry "v1" surface — wire-compatible with OpenAI's own API
    // (Bearer auth, GET {base}/models lists the project's deployments).
    const v1Base = baseUrl.replace(/(\/openai\/v1)\/?.*$/i, '$1');
    endpoint = `${v1Base}/models`;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  } else if (provider === 'Azure OpenAI') {
    let origin: string;
    let apiVersion = DEFAULT_AZURE_OPENAI_API_VERSION;
    try {
      const parsed = new URL(baseUrl.trim());
      origin = parsed.origin;
      apiVersion = parsed.searchParams.get('api-version') || apiVersion;
    } catch {
      origin = baseUrl.replace(/\/$/, '');
    }
    endpoint = `${origin}/openai/deployments?api-version=${apiVersion}`;
    if (apiKey) headers['api-key'] = apiKey;
  } else {
    endpoint = `${baseUrl.replace(/\/$/, '')}/models`;
    if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
  }

  const res = await fetch(endpoint, { method: 'GET', headers });
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = await res.json() as Record<string, unknown>;
      const err = body['error'];
      if (typeof err === 'object' && err !== null && 'message' in err) {
        detail = String((err as { message?: string }).message);
      } else if (typeof err === 'string') {
        detail = err;
      } else if (typeof body['message'] === 'string') {
        detail = String(body['message']);
      }
    } catch { /* ignore parse errors */ }
    throw new Error(detail);
  }

  const data = await res.json() as { data?: Array<{ id?: string }> };
  if (Array.isArray(data)) {
    return data.map((m) => m.id).filter(Boolean) as string[];
  }
  if (data?.data && Array.isArray(data.data)) {
    return data.data.map((m) => m.id).filter(Boolean) as string[];
  }
  return [];
}

// Only meaningful against a centrally-hosted backend (MT_REQUIRE_AUTH=true
// server-side) — the normal local/self-hosted backend ignores this header
// entirely, and accountToken is unset for anyone who hasn't used the
// popup's Account tab, so this is a no-op for the default setup.
function authHeaders(settings: AppSettings): Record<string, string> {
  return settings.accountToken ? { Authorization: `Bearer ${settings.accountToken}` } : {};
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch image + translate via backend (runs in background — no CORS)
// ─────────────────────────────────────────────────────────────────────────────

async function fetchAndTranslateWithBody(imageUrl: string, pageUrl: string | undefined, body: TranslateRequest, tabId?: number): Promise<TranslateResult> {
  // Image is already fetched and base64-encoded by content script (with page cookies/auth).
  // Background only calls the backend API — no image fetching here.
  void imageUrl;
  // Awaited, not fire-and-forget: an MV3 service worker can be torn down the
  // instant the message handler that woke it up resolves, which would cut
  // an un-awaited storage write off mid-flight more often than not.
  await recordStoryDomainUsage(pageUrl, body.story_id);

  const settings = await getSettings();
  // Master kill switch — every translate path (scan, auto-translate, batch
  // scanner) routes through here, so this is the single place that
  // guarantees no API call goes out while the extension is disabled.
  if (settings.extensionEnabled === false) {
    console.log('[BG] fetchAndTranslateWithBody skipped: extension disabled');
    return { error: 'Extension is disabled' };
  }
  const backendUrl = settings.backendUrl || 'http://localhost:7677';
  const endpoint = `${backendUrl.replace(/\/$/, '')}/translate`;

  const stopDownloadWatch = watchModelDownloads(tabId, backendUrl);
  try {
    console.log('[BG] fetchAndTranslateWithBody calling backend:', endpoint);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(settings) },
      body: JSON.stringify(body),
    });
    console.log('[BG] fetchAndTranslateWithBody backend status:', res.status, res.statusText);
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const errBody = await res.json() as Record<string, unknown>;
        if (typeof errBody['detail'] === 'string') detail = errBody['detail'];
        else detail = JSON.stringify(errBody).slice(0, 200);
      } catch { /* ignore */ }
      return { error: `Translate failed: ${detail}` };
    }
    const data = (await res.json()) as TranslateResponse;
    console.log('[BG] fetchAndTranslateWithBody success');
    return {
      translated_image: data.translated_image,
      bubbles: data.bubbles,
      processing_time_seconds: data.processing_time_seconds,
      ocr_texts: data.ocr_texts,
      memory_note: data.memory_note,
      warnings: data.warnings,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log('[BG] fetchAndTranslateWithBody backend exception:', msg);
    return { error: `Translate error: ${msg}` };
  } finally {
    stopDownloadWatch();
  }
}

interface SuggestInstructionsBody {
  images: string[];
  output_language: string;
  provider: string;
  base_url?: string;
  model_name?: string;
  api_key?: string;
  temperature: number;
  top_p: number;
  top_k: number;
  reasoning_effort?: string;
  backup_api_keys?: string[];
  fallback_providers?: { provider: string; model_name?: string; api_keys: string[]; base_url?: string; reasoning_effort?: string }[];
  rotation_strategy?: string;
  cooldown_seconds?: number;
  enable_web_search?: boolean;
  story_title?: string;
}

async function fetchSuggestInstructions(body: SuggestInstructionsBody): Promise<{ suggestion?: string; error?: string }> {
  const settings = await getSettings();
  if (settings.extensionEnabled === false) {
    return { error: 'Extension is disabled' };
  }
  const backendUrl = settings.backendUrl || 'http://localhost:7677';
  const endpoint = `${backendUrl.replace(/\/$/, '')}/suggest-instructions`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(settings) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const errBody = await res.json() as Record<string, unknown>;
        if (typeof errBody['detail'] === 'string') detail = errBody['detail'];
        else detail = JSON.stringify(errBody).slice(0, 200);
      } catch { /* ignore */ }
      return { error: `Suggest instructions failed: ${detail}` };
    }
    const data = (await res.json()) as { suggestion: string };
    return { suggestion: data.suggestion };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Suggest instructions error: ${msg}` };
  }
}

interface SupportChatBody {
  messages: { role: 'user' | 'assistant'; content: string }[];
  ui_language?: string;
  provider: string;
  base_url?: string;
  model_name?: string;
  api_key?: string;
  temperature?: number;
  top_p?: number;
  top_k?: number;
  reasoning_effort?: string;
  backup_api_keys?: string[];
  fallback_providers?: { provider: string; model_name?: string; api_keys: string[]; base_url?: string; reasoning_effort?: string }[];
  rotation_strategy?: string;
  cooldown_seconds?: number;
}

// Popup "?" help chat (see popup/index.ts:initSupportChat) — a one-off LLM
// helper answering "how do I use this project" questions, same gating
// family as /suggest-instructions (no account/login required for the
// normal self-hosted setup).
async function fetchSupportChat(body: SupportChatBody): Promise<{ reply?: string; error?: string }> {
  const settings = await getSettings();
  if (settings.extensionEnabled === false) {
    return { error: 'Extension is disabled' };
  }
  const backendUrl = settings.backendUrl || 'http://localhost:7677';
  const endpoint = `${backendUrl.replace(/\/$/, '')}/support-chat`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(settings) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const errBody = await res.json() as Record<string, unknown>;
        if (typeof errBody['detail'] === 'string') detail = errBody['detail'];
        else detail = JSON.stringify(errBody).slice(0, 200);
      } catch { /* ignore */ }
      return { error: `Support chat failed: ${detail}` };
    }
    const data = (await res.json()) as { reply: string };
    return { reply: data.reply };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Support chat error: ${msg}` };
  }
}

interface TestApiKeyBody {
  provider: string;
  model_name?: string;
  api_key?: string;
  base_url?: string;
  reasoning_effort?: string;
}

interface TestApiKeyResult {
  ok: boolean;
  error?: string;
  latency_ms?: number;
}

async function fetchTestApiKey(body: TestApiKeyBody): Promise<TestApiKeyResult> {
  const settings = await getSettings();
  const backendUrl = settings.backendUrl || 'http://localhost:7677';
  const endpoint = `${backendUrl.replace(/\/$/, '')}/test-key`;

  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(settings) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const errBody = await res.json() as Record<string, unknown>;
        if (typeof errBody['detail'] === 'string') detail = errBody['detail'];
        else detail = JSON.stringify(errBody).slice(0, 200);
      } catch { /* ignore */ }
      return { ok: false, error: detail };
    }
    return (await res.json()) as TestApiKeyResult;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: t(settings.uiLanguage, 'errorBackendUnreachable', { msg }) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Flux remote worker (backend/flux_worker.py) — a user-run server (e.g. a
// Kaggle notebook GPU tunneled out via cloudflared) that FluxKleinInpainter
// calls instead of loading Flux locally. Checked directly from here (not
// proxied through the main backend) since a background service worker can
// fetch cross-origin without CORS issues, same reason it already talks to
// LLM providers/backend directly.
// ─────────────────────────────────────────────────────────────────────────────

async function testFluxRemoteConnection(url: string, token?: string): Promise<{ ok: boolean; error?: string }> {
  const trimmed = url.trim();
  if (!trimmed) return { ok: false, error: 'No URL provided' };
  const endpoint = `${trimmed.replace(/\/$/, '')}/health`;
  try {
    const res = await fetch(endpoint, { method: 'GET', headers: token ? { 'X-Flux-Worker-Token': token } : {} });
    if (res.status === 401) return { ok: false, error: 'Token rejected (401) — check the Token field' };
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    const body = await res.json() as { status?: string };
    if (body.status !== 'ok') return { ok: false, error: 'Unexpected response from worker' };
    return { ok: true };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Could not reach Flux worker: ${msg}` };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Account (only relevant against a centrally-hosted backend — see
// backend/auth.py and the popup's Account tab)
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

interface AccountResult {
  ok: boolean;
  account?: AccountInfo;
  error?: string;
}

async function accountApiCall(path: string, init: RequestInit): Promise<AccountResult> {
  const settings = await getSettings();
  const backendUrl = settings.backendUrl || 'http://localhost:7677';
  const endpoint = `${backendUrl.replace(/\/$/, '')}${path}`;
  try {
    const res = await fetch(endpoint, init);
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const errBody = await res.json() as Record<string, unknown>;
        if (typeof errBody['detail'] === 'string') detail = errBody['detail'];
        else detail = JSON.stringify(errBody).slice(0, 200);
      } catch { /* ignore */ }
      return { ok: false, error: detail };
    }
    return { ok: true, account: (await res.json()) as AccountInfo };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: t(settings.uiLanguage, 'errorBackendUnreachable', { msg }) };
  }
}

async function accountRegister(email: string): Promise<AccountResult> {
  return accountApiCall('/account/register', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email }),
  });
}

// token is explicit here (not read from settings) because this doubles as
// the "log in with an existing token" verification step, run BEFORE that
// token is saved to settings — the popup only persists it once this
// confirms it's actually valid.
async function accountMe(token?: string): Promise<AccountResult> {
  const settings = await getSettings();
  const effectiveToken = token ?? settings.accountToken;
  if (!effectiveToken) return { ok: false, error: 'No account token' };
  return accountApiCall('/account/me', {
    headers: { Authorization: `Bearer ${effectiveToken}` },
  });
}

async function accountSetPlan(token: string, plan: string): Promise<AccountResult> {
  return accountApiCall('/account/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ plan }),
  });
}

// Revokes the token server-side (core/accounts.py:revoke_token) so a
// "logout" actually invalidates the credential, not just clears it out of
// local extension storage — best-effort from the popup's point of view
// (it clears local state regardless of whether this succeeds).
async function accountLogout(token: string): Promise<AccountResult> {
  return accountApiCall('/account/logout', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  });
}

// "Owner" section (Account tab, only shown when is_admin) — lets the
// deployment operator configure the LLM provider/model/key every hosted
// user's request falls back to, from the popup instead of setting
// GOOGLE_API_KEY/etc. env vars on the server by hand. See
// backend/auth.py:require_admin and core/server_config.py.
interface SharedLlmConfigInfo {
  provider: string;
  model_name?: string | null;
  api_key_set: boolean;
  base_url?: string | null;
}

interface AdminLlmConfigResult {
  ok: boolean;
  config?: SharedLlmConfigInfo;
  error?: string;
}

async function adminApiCall(init: RequestInit): Promise<AdminLlmConfigResult> {
  const settings = await getSettings();
  if (!settings.accountToken) return { ok: false, error: 'No account token' };
  const backendUrl = settings.backendUrl || 'http://localhost:7677';
  const endpoint = `${backendUrl.replace(/\/$/, '')}/admin/llm-config`;
  try {
    const res = await fetch(endpoint, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${settings.accountToken}` },
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const errBody = await res.json() as Record<string, unknown>;
        if (typeof errBody['detail'] === 'string') detail = errBody['detail'];
        else detail = JSON.stringify(errBody).slice(0, 200);
      } catch { /* ignore */ }
      return { ok: false, error: detail };
    }
    return { ok: true, config: (await res.json()) as SharedLlmConfigInfo };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: t(settings.uiLanguage, 'errorBackendUnreachable', { msg }) };
  }
}

async function adminGetLlmConfig(): Promise<AdminLlmConfigResult> {
  return adminApiCall({});
}

async function adminSetLlmConfig(body: { provider: string; model_name?: string; api_key?: string; base_url?: string }): Promise<AdminLlmConfigResult> {
  return adminApiCall({
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Story DB (character database / relationships / glossary) — the popup's
// "Story DB" tab. Opt-in per logged-in account, independent of whether the
// deployment enforces MT_REQUIRE_AUTH — see backend/auth.py:require_login
// and backend/core/story_context.py.
// ─────────────────────────────────────────────────────────────────────────────

export interface StoryContextPayload {
  name: string;
  characters: StoryDetail['characters'];
  relationships: StoryDetail['relationships'];
  glossary: StoryDetail['glossary'];
}

interface StoryListResult { ok: boolean; stories?: StorySummary[]; error?: string; }
interface StoryDetailResult { ok: boolean; story?: StoryDetail; error?: string; }
interface StoryOkResult { ok: boolean; error?: string; }

async function storiesApiCall<T>(path: string, init: RequestInit): Promise<{ ok: boolean; data?: T; error?: string }> {
  const settings = await getSettings();
  if (!settings.accountToken) return { ok: false, error: 'No account token' };
  const backendUrl = settings.backendUrl || 'http://localhost:7677';
  const endpoint = `${backendUrl.replace(/\/$/, '')}${path}`;
  try {
    const res = await fetch(endpoint, {
      ...init,
      headers: { ...(init.headers ?? {}), Authorization: `Bearer ${settings.accountToken}` },
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const errBody = await res.json() as Record<string, unknown>;
        if (typeof errBody['detail'] === 'string') detail = errBody['detail'];
        else detail = JSON.stringify(errBody).slice(0, 200);
      } catch { /* ignore */ }
      return { ok: false, error: detail };
    }
    return { ok: true, data: (await res.json()) as T };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: t(settings.uiLanguage, 'errorBackendUnreachable', { msg }) };
  }
}

// The "Live AI" debug log viewer page (extension/src/live-ai/). `since` makes
// the auto-refresh transfer only what is new. Admin-gated on a hosted
// backend, so the stored account token rides along like everywhere else.
async function fetchLiveAiLog(limit: number, since?: number): Promise<LiveAiLogResult> {
  const settings = await getSettings();
  const backendUrl = settings.backendUrl || 'http://localhost:7677';
  const query = new URLSearchParams({ limit: String(limit) });
  if (since !== undefined) query.set('since', String(since));
  try {
    const res = await fetch(`${backendUrl.replace(/\/$/, '')}/admin/live-ai-log?${query}`, { headers: authHeaders(settings) });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const errBody = await res.json() as Record<string, unknown>;
        if (typeof errBody['detail'] === 'string') detail = errBody['detail'];
      } catch { /* ignore */ }
      return { ok: false, status: res.status, error: detail };
    }
    return { ok: true, entries: ((await res.json()) as { entries: LiveAiLogEntry[] }).entries };
  } catch (e) {
    return { ok: false, error: t(settings.uiLanguage, 'errorBackendUnreachable', { msg: e instanceof Error ? e.message : String(e) }) };
  }
}

// Manual region tools (backend /region/*): OCR a boxed area, translate its
// text, render text over it. Only these three paths are proxied.
const REGION_PATHS = new Set(['/region/ocr', '/region/translate', '/region/render', '/region/erase']);

async function regionApiCall(path: string, body: Record<string, unknown>, tabId?: number): Promise<{ ok: boolean; data?: unknown; error?: string }> {
  if (!REGION_PATHS.has(path)) return { ok: false, error: 'Unsupported region endpoint' };
  const settings = await getSettings();
  const backendUrl = settings.backendUrl || 'http://localhost:7677';
  const stopDownloadWatch = watchModelDownloads(tabId, backendUrl);
  try {
    const res = await fetch(`${backendUrl.replace(/\/$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(settings) },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const errBody = await res.json() as Record<string, unknown>;
        if (typeof errBody['detail'] === 'string') detail = errBody['detail'];
      } catch { /* ignore */ }
      return { ok: false, error: detail };
    }
    return { ok: true, data: await res.json() };
  } catch (e) {
    return { ok: false, error: t(settings.uiLanguage, 'errorBackendUnreachable', { msg: e instanceof Error ? e.message : String(e) }) };
  } finally {
    stopDownloadWatch();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// First-use model downloads
// ─────────────────────────────────────────────────────────────────────────────
//
// The backend fetches ML weights lazily the first time a feature needs them
// (LaMa ~0.2 GB, manga-ocr ~0.9 GB, PaddleOCR-VL ~1.9 GB). From the page that
// just looks like a translation that never finishes, so while a backend
// request to a tab is slow we ask GET /health whether the backend is
// downloading something and tell that tab (content-script MODEL_DOWNLOADS
// toast). One poller per tab no matter how many requests it has in flight
// (auto-translate runs several pages at once).

const DOWNLOAD_WATCH_DELAY_MS = 4_000; // quick requests never poll at all
const DOWNLOAD_WATCH_INTERVAL_MS = 2_500;
const DOWNLOAD_NOTICE_REPEAT_MS = 20_000; // the toast is short-lived; refresh it while the download runs

interface ModelDownload { name: string; approx_mb: number | null; elapsed_seconds: number }
interface DownloadWatcher { count: number; timer?: ReturnType<typeof setTimeout>; lastNoticeAt: number; lastNames: string }
const downloadWatchers = new Map<number, DownloadWatcher>();

// Returns the function that ends this request's watch. A no-op without a tab
// (requests made from the popup have nobody to tell).
function watchModelDownloads(tabId: number | undefined, backendUrl: string): () => void {
  if (tabId === undefined) return () => {};
  let watcher = downloadWatchers.get(tabId);
  if (!watcher) {
    watcher = { count: 0, lastNoticeAt: 0, lastNames: '' };
    downloadWatchers.set(tabId, watcher);
    const w = watcher;
    const poll = async (): Promise<void> => {
      try {
        const res = await fetch(`${backendUrl.replace(/\/$/, '')}/health`, { signal: AbortSignal.timeout(3_000) });
        const downloads = ((await res.json()) as { downloads?: ModelDownload[] }).downloads ?? [];
        const names = downloads.map((d) => d.name).join('|');
        if (downloads.length > 0 && (names !== w.lastNames || Date.now() - w.lastNoticeAt >= DOWNLOAD_NOTICE_REPEAT_MS)) {
          w.lastNames = names;
          w.lastNoticeAt = Date.now();
          await chrome.tabs.sendMessage(tabId, { type: 'MODEL_DOWNLOADS', downloads });
        } else if (downloads.length === 0) {
          w.lastNames = '';
        }
      } catch { /* backend busy/unreachable or tab gone: this is only a courtesy notice */ }
      if (downloadWatchers.get(tabId) === w) w.timer = setTimeout(() => { void poll(); }, DOWNLOAD_WATCH_INTERVAL_MS);
    };
    w.timer = setTimeout(() => { void poll(); }, DOWNLOAD_WATCH_DELAY_MS);
  }
  watcher.count += 1;
  const mine = watcher;
  return () => {
    mine.count -= 1;
    if (mine.count <= 0 && downloadWatchers.get(tabId) === mine) {
      clearTimeout(mine.timer);
      downloadWatchers.delete(tabId);
    }
  };
}

async function storiesList(): Promise<StoryListResult> {
  const result = await storiesApiCall<StorySummary[]>('/stories', {});
  return { ok: result.ok, stories: result.data, error: result.error };
}

async function storyGet(id: string): Promise<StoryDetailResult> {
  const result = await storiesApiCall<StoryDetail>(`/stories/${encodeURIComponent(id)}`, {});
  return { ok: result.ok, story: result.data, error: result.error };
}

async function storyCreate(name: string): Promise<StoryDetailResult> {
  const result = await storiesApiCall<StoryDetail>('/stories', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  return { ok: result.ok, story: result.data, error: result.error };
}

async function storySave(id: string, payload: StoryContextPayload): Promise<StoryDetailResult> {
  const result = await storiesApiCall<StoryDetail>(`/stories/${encodeURIComponent(id)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { ok: result.ok, story: result.data, error: result.error };
}

async function storyDelete(id: string): Promise<StoryOkResult> {
  const result = await storiesApiCall<{ ok: boolean }>(`/stories/${encodeURIComponent(id)}`, { method: 'DELETE' });
  return { ok: result.ok, error: result.error };
}

interface StoryUpdateResult {
  ok: boolean;
  characters?: StoryCharacter[];
  relationships?: StoryRelationship[];
  continuityNote?: StoryContinuityNote | null;
  error?: string;
}

// "Update Story DB from a description" (popup Story DB tab) — a stateless
// LLM helper, not part of the story_id CRUD family above; see
// backend/endpoints/stories.py:update_story_from_description.
async function storyUpdateFromDescription(body: Record<string, unknown>): Promise<StoryUpdateResult> {
  const result = await storiesApiCall<{
    characters: StoryCharacter[]; relationships: StoryRelationship[]; continuity_note: StoryContinuityNote | null;
  }>('/stories/update-from-description', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return {
    ok: result.ok,
    characters: result.data?.characters,
    relationships: result.data?.relationships,
    continuityNote: result.data?.continuity_note,
    error: result.error,
  };
}

// "Sign in with Google" — chrome.identity.getAuthToken() needs manifest.json's
// oauth2.client_id to be a real Google Cloud OAuth client registered for
// this extension's (published) ID; with the placeholder client_id this
// ships with, Chrome will reject the request, which surfaces here as a
// rejected promise, not a hang.
// With a misconfigured/placeholder oauth2.client_id, getAuthToken({interactive:
// true}) has been observed to neither resolve nor reject — it just hangs,
// presumably stuck trying to open a consent flow Google's servers never
// actually complete for an invalid client — leaving the popup spinning on
// "Signing in..." forever with no feedback. Race it against a timeout so a
// bad client_id always surfaces as a clear error instead.
const GOOGLE_SIGN_IN_TIMEOUT_MS = 30_000;

async function accountGoogleLogin(): Promise<AccountResult> {
  let token: string | undefined;
  try {
    const result = await Promise.race([
      chrome.identity.getAuthToken({ interactive: true }),
      new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Timed out waiting for Google — check that manifest.json\'s oauth2.client_id is a real, valid Google OAuth client for this extension.')), GOOGLE_SIGN_IN_TIMEOUT_MS);
      }),
    ]);
    token = result.token;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Google sign-in failed: ${msg}` };
  }
  if (!token) return { ok: false, error: 'Google sign-in did not return a token' };

  return accountApiCall('/account/google-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ access_token: token }),
  });
}

interface TranslateResult {
  translated_image?: string;
  bubbles?: unknown[];
  processing_time_seconds?: number;
  ocr_texts?: string[];
  memory_note?: string;
  warnings?: string[];
  error?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fetch chapter HTML and extract page info
// ─────────────────────────────────────────────────────────────────────────────

interface ChapterInfo {
  totalPages: number;
  pageUrls: string[];       // direct image URLs if found
  pattern?: { baseUrl: string; pageNumber: number; padding: number; extension: string } | null;
  error?: string;
}

async function fetchChapterHTML(url: string): Promise<ChapterInfo> {
  const res = await fetch(url, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });

  if (!res.ok) {
    return { totalPages: 0, pageUrls: [], error: `HTTP ${res.status}` };
  }

  const html = await res.text();
  return parseChapterHTML(html, url);
}

function parseChapterHTML(html: string, _pageUrl: string): ChapterInfo {
  const result: ChapterInfo = { totalPages: 0, pageUrls: [] };

  // Strategy A: JSON data embedded in <script>
  const jsonMatch = html.match(/"(?:total_pages|totalPages|pageCount|page_count|total)":\s*(\d+)/i);
  if (jsonMatch) result.totalPages = parseInt(jsonMatch[1], 10);

  // Strategy B: data-* attributes
  if (!result.totalPages) {
    const dataMatch = html.match(/data-(?:pages|total|pages_count)\s*=\s*["']?(\d+)/i);
    if (dataMatch) result.totalPages = parseInt(dataMatch[1], 10);
  }

  // Strategy C: URL array in script
  const arrayMatch = html.match(/\[\s*"([^"]+\.(?:jpg|jpeg|png|webp|gif|avif)[^"]*)"/);
  if (arrayMatch) {
    const urls = extractArrayUrls(html);
    if (urls.length > 0) { result.pageUrls = urls; result.totalPages = urls.length; }
  }

  // Strategy D: image URLs in JS script blocks
  if (result.pageUrls.length === 0) {
    result.pageUrls = extractImageUrlsFromScript(html);
  }

  // Strategy E: option values with image URLs
  const optionMatches = [...html.matchAll(/<option[^>]*value=["']?([^"'>]+)["']?[^>]*>/gi)];
  if (optionMatches.length > 1) {
    const uniqueValues = new Set(optionMatches.map((m) => m[1]).filter((v) => v.includes('/') || v.includes('.')));
    if (uniqueValues.size > 2) {
      result.pageUrls = [...uniqueValues].filter((u) => /\.(jpg|jpeg|png|webp|gif|avif)/i.test(u));
      if (result.pageUrls.length > 0) result.totalPages = result.pageUrls.length;
    }
  }

  // Strategy F: "Page X of Y" text
  if (!result.totalPages) {
    const pageTextMatch = html.match(/(\d+)\s*[/\-–|]\s*(\d+)/);
    if (pageTextMatch) {
      const second = parseInt(pageTextMatch[2], 10);
      const first = parseInt(pageTextMatch[1], 10);
      if (second > first) result.totalPages = second;
    }
  }

  // Extract URL pattern
  if (result.pageUrls.length > 0) {
    result.pattern = detectUrlPattern(result.pageUrls);
  } else if (result.totalPages > 0) {
    const imgUrls = extractImageUrlsFromHTML(html);
    if (imgUrls.length > 0) result.pattern = detectUrlPattern(imgUrls);
  }

  return result;
}

function extractArrayUrls(html: string): string[] {
  const results: string[] = [];
  const matches = html.match(/"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp|gif|avif)[^"]*)"/gi);
  if (matches) {
    for (const m of matches) {
      const url = m.replace(/^"|"$/g, '');
      if (!results.includes(url)) results.push(url);
    }
  }
  return results;
}

function extractImageUrlsFromScript(html: string): string[] {
  const results: string[] = [];
  const srcMatches = html.matchAll(/(?:src|image|img|page_url|url)\s*:\s*["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif|avif)[^"']*)["']/gi);
  for (const m of srcMatches) {
    if (!results.includes(m[1])) results.push(m[1]);
  }
  return results;
}

function extractImageUrlsFromHTML(html: string): string[] {
  const results: string[] = [];
  const srcMatches = html.matchAll(/(?:src|data-src|data-lazy|data-original|data-image)\s*=\s*["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp|gif|avif)[^"']*)["']/gi);
  for (const m of srcMatches) {
    if (!results.includes(m[1])) results.push(m[1]);
  }
  return results;
}

interface UrlPattern {
  baseUrl: string;
  pageNumber: number;
  padding: number;
  extension: string;
}

function detectUrlPattern(urls: string[]): UrlPattern | null {
  if (urls.length < 1) return null;
  const url = urls[urls.length - 1];
  const numbers = [...url.matchAll(/\d+/g)].map((m) => ({ value: +m[0], index: m.index! }));
  if (numbers.length === 0) return null;
  const lastNum = numbers[numbers.length - 1];
  return {
    baseUrl: url.substring(0, lastNum.index),
    pageNumber: lastNum.value,
    padding: String(lastNum.value).length,
    extension: url.substring(lastNum.index + String(lastNum.value).length),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function getSettings(): Promise<AppSettings> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  return normalizeSettings(result[STORAGE_KEY] as Partial<AppSettings> | undefined);
}

function normalizeSettings(raw?: Partial<AppSettings>): AppSettings {
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

async function ensureContentScript(tabId: number): Promise<void> {
  const pingContentScript = async (): Promise<boolean> => {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: 'PING' });
      return Boolean(response?.ok);
    } catch {
      return false;
    }
  };

  if (await pingContentScript()) return;

  await chrome.scripting.executeScript({
    target: { tabId },
    files: ['content-script/index.js'],
  });
  if (!(await pingContentScript())) {
    throw new Error('Content script did not start on this page');
  }
}

async function checkHealth(backendUrl: string): Promise<{ ok: boolean; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(`${backendUrl.replace(/\/$/, '')}/health`, {
      method: 'GET',
      signal: controller.signal,
    });
    clearTimeout(timeout);
    return { ok: response.ok };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

