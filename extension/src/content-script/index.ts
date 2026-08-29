import type { AppSettings, BubbleInfo, TranslateRequest } from '../shared/types.js';
import { normalizeProviderGroups, stripLegacyProviderFields } from '../shared/types.js';
import JSZip from 'jszip';

const ROOT_ID  = 'mt-scanner-root';
const STYLE_ID = 'mt-scanner-style';
const STORAGE_KEY = 'manga_translator_settings';
const TRANSLATED_CACHE_KEY = 'mt_translated_cache'; // rawUrl -> translated base64
const TRANSLATED_CACHE_PREFIX = 'mt_translated_cache:';
const DEFAULT_BACKEND_URL = 'http://localhost:7677';

type UiLanguage = 'en' | 'vi' | 'zh' | 'ja' | 'ko';

const EN_MESSAGES = {
  autoMt: 'Auto MT',
  autoMtDone: 'Auto MT Done',
  stop: 'Stop',
  translatedBadgeTitle: 'Translated by MangaTranslator',
  translatingBadgeTitle: 'Translating this page…',
  noMangaImagesPage: 'No manga images found on this page.',
  pageAlt: 'Page {page}',
  pagesLabel: 'pages',
  all: 'All',
  none: 'None',
  close: 'Close',
  foundImagesOnPage: 'Found {count} images on this page',
  autoCollect: 'Auto-collect',
  cancel: 'Cancel',
  translate: 'Translate',
  starting: 'Starting...',
  cancelledTranslated: 'Cancelled - {success}/{total} translated',
  allImagesTranslated: 'All {count} images translated!',
  partialTranslated: '{success}/{total} translated',
  scanningPage: 'Scanning page...',
  noImagesFoundOnPage: 'No images found on page',
  foundImages: 'Found {count} images...',
  foundMangaImages: 'Found {count} manga images',
  cached: 'Cached',
  loadError: 'Load error',
  sending: 'Sending...',
  translating: 'Translating...',
  noResult: 'No result',
  bubbles: '{count} bubbles - {time}s',
  doneWithTime: 'Done - {time}s',
  networkError: 'Network error',
  extensionDisabled: 'Extension is disabled',
  suggestInstructions: 'Suggest Notes',
  suggestInstructionsHint: 'Analyze selected pages and draft Story Notes (cast, relationships, tone)',
  suggesting: 'Analyzing...',
  suggestionSaved: 'Suggestion saved to Story Notes',
  suggestNoImagesReady: 'Selected pages are still loading, wait a moment and try again',
  retryBadgeTitle: 'Translation failed after several retries — click to try again',
  fixHintTooltip: "Click to fix this bubble's translation",
  zoomTooltip: 'Click to view full size',
  fixHintCurrentLabel: 'Current:',
  fixHintPlaceholder: 'Describe the correction, e.g. "wrong pronoun, should be anh/em" or "should be formal tone"',
  fixHintApply: 'Apply',
  fixHintApplying: 'Re-translating...',
  fixHintEmpty: 'Enter a correction first',
  fixHintError: 'Fix failed — try again',
  exportPageTitle: 'Download this translated page',
  btnExportAll: 'Export',
  exportingStatus: 'Exporting...',
  exportNoneTranslated: 'No translated pages to export yet',
  exportDone: 'Exported {count} page(s)',
  btnFixSelected: 'Fix Selected',
  fixSelectedTitle: 'Fix translation for {count} selected page(s)',
  fixSelectedPlaceholder: 'Describe the correction, e.g. "character name Yuki was mistranslated as Yuuki"',
  fixSelectedNoneTranslated: 'None of the selected pages are translated yet',
  fixSelectedDone: 'Fixed {success}/{total} page(s)',
  cacheTooLargeToLoad: 'Translated page cache is {mb}MB — too large to load, so previously translated pages won\'t show as translated this session. Use "Clear translated cache" in Config to reset it.',
  btnBackToTranslate: 'Translate',
};

type ContentMessageKey = keyof typeof EN_MESSAGES;

const CONTENT_MESSAGES: Record<UiLanguage, Record<ContentMessageKey, string>> = {
  en: EN_MESSAGES,
  vi: {
    autoMt: 'Auto MT',
    autoMtDone: 'Auto MT xong',
    stop: 'Dung',
    translatedBadgeTitle: 'Da dich bang MangaTranslator',
    translatingBadgeTitle: 'Dang dich trang nay...',
    noMangaImagesPage: 'Khong tim thay anh manga tren trang nay.',
    pageAlt: 'Trang {page}',
    pagesLabel: 'trang',
    all: 'Tat ca',
    none: 'Bo chon',
    close: 'Dong',
    foundImagesOnPage: 'Tim thay {count} anh tren trang nay',
    autoCollect: 'Tu thu thap',
    cancel: 'Huy',
    translate: 'Dich',
    starting: 'Dang bat dau...',
    cancelledTranslated: 'Da huy - da dich {success}/{total}',
    allImagesTranslated: 'Da dich toan bo {count} anh!',
    partialTranslated: 'Da dich {success}/{total}',
    scanningPage: 'Dang quet trang...',
    noImagesFoundOnPage: 'Khong tim thay anh tren trang',
    foundImages: 'Tim thay {count} anh...',
    foundMangaImages: 'Tim thay {count} anh manga',
    cached: 'Tu cache',
    loadError: 'Loi tai anh',
    sending: 'Dang gui...',
    translating: 'Dang dich...',
    noResult: 'Khong co ket qua',
    bubbles: '{count} bubble - {time}s',
    doneWithTime: 'Xong - {time}s',
    networkError: 'Loi mang',
    extensionDisabled: 'Tien ich dang tat',
    suggestInstructions: 'Goi y ghi chu',
    suggestInstructionsHint: 'Phan tich cac trang da chon va soan Ghi chu truyen (nhan vat, quan he, van phong)',
    suggesting: 'Dang phan tich...',
    suggestionSaved: 'Da luu goi y vao Ghi chu truyen',
    suggestNoImagesReady: 'Trang da chon van dang tai, doi chut roi thu lai',
    retryBadgeTitle: 'Dich that bai sau nhieu lan thu - bam de thu lai',
    fixHintTooltip: 'Bam de sua ban dich o bubble nay',
    zoomTooltip: 'Bam de xem anh phong to',
    fixHintCurrentLabel: 'Hien tai:',
    fixHintPlaceholder: 'Mo ta cach sua, vd "phai dung xung anh/em" hoac "giong dieu trang trong hon"',
    fixHintApply: 'Ap dung',
    fixHintApplying: 'Dang dich lai...',
    fixHintEmpty: 'Nhap noi dung can sua truoc',
    fixHintError: 'Sua that bai - thu lai',
    exportPageTitle: 'Tai anh da dich cua trang nay',
    btnExportAll: 'Xuat',
    exportingStatus: 'Dang xuat...',
    exportNoneTranslated: 'Chua co trang nao da dich de xuat',
    exportDone: 'Da xuat {count} trang',
    btnFixSelected: 'Sua trang da chon',
    fixSelectedTitle: 'Sua ban dich cho {count} trang da chon',
    fixSelectedPlaceholder: 'Mo ta cach sua, vd "ten nhan vat Yuki bi dich nham thanh Yuuki"',
    fixSelectedNoneTranslated: 'Chua co trang nao trong lua chon duoc dich',
    fixSelectedDone: 'Da sua {success}/{total} trang',
    cacheTooLargeToLoad: 'Cache trang da dich dang {mb}MB - qua lon de tai, nen cac trang da dich truoc do se khong hien la da dich trong phien nay. Dung "Clear translated cache" trong Config de reset.',
    btnBackToTranslate: 'Dich',
  },
  zh: {
    autoMt: '自动 MT',
    autoMtDone: '自动 MT 完成',
    stop: '停止',
    translatedBadgeTitle: '由 MangaTranslator 翻译',
    translatingBadgeTitle: '正在翻译此页…',
    noMangaImagesPage: '此页面没有找到漫画图片。',
    pageAlt: '第 {page} 页',
    pagesLabel: '页',
    all: '全选',
    none: '全不选',
    close: '关闭',
    foundImagesOnPage: '在此页面找到 {count} 张图片',
    autoCollect: '自动收集',
    cancel: '取消',
    translate: '翻译',
    starting: '正在开始...',
    cancelledTranslated: '已取消 - 已翻译 {success}/{total}',
    allImagesTranslated: '已翻译全部 {count} 张图片！',
    partialTranslated: '已翻译 {success}/{total}',
    scanningPage: '正在扫描页面...',
    noImagesFoundOnPage: '页面上没有找到图片',
    foundImages: '找到 {count} 张图片...',
    foundMangaImages: '找到 {count} 张漫画图片',
    cached: '缓存',
    loadError: '加载错误',
    sending: '正在发送...',
    translating: '正在翻译...',
    noResult: '无结果',
    bubbles: '{count} 个气泡 - {time}s',
    doneWithTime: '完成 - {time}s',
    networkError: '网络错误',
    extensionDisabled: '扩展已停用',
    suggestInstructions: '生成建议',
    suggestInstructionsHint: '分析已选页面并起草故事笔记（角色、关系、语气）',
    suggesting: '分析中...',
    suggestionSaved: '建议已保存到故事笔记',
    suggestNoImagesReady: '所选页面仍在加载，请稍后重试',
    retryBadgeTitle: '多次重试后翻译失败——点击重试',
    fixHintTooltip: '点击修正这个气泡的翻译',
    zoomTooltip: '点击查看大图',
    fixHintCurrentLabel: '当前:',
    fixHintPlaceholder: '描述修正内容，例如"应该用敬语"或"人称代词错了"',
    fixHintApply: '应用',
    fixHintApplying: '重新翻译中...',
    fixHintEmpty: '请先输入修正内容',
    fixHintError: '修正失败 - 请重试',
    exportPageTitle: '下载这一页的翻译图片',
    btnExportAll: '导出',
    exportingStatus: '正在导出...',
    exportNoneTranslated: '还没有已翻译的页面可导出',
    exportDone: '已导出 {count} 页',
    btnFixSelected: '修正所选页面',
    fixSelectedTitle: '为已选的 {count} 个页面修正翻译',
    fixSelectedPlaceholder: '描述修正内容，例如"角色名 Yuki 被误译为 Yuuki"',
    fixSelectedNoneTranslated: '所选页面中还没有已翻译的',
    fixSelectedDone: '已修正 {success}/{total} 页',
    cacheTooLargeToLoad: '已翻译页面缓存为 {mb}MB，太大无法加载，因此本次会话中之前翻译过的页面不会显示为已翻译。请在设置的 Config 中使用"Clear translated cache"重置。',
    btnBackToTranslate: '翻译',
  },
  ja: {
    autoMt: 'Auto MT',
    autoMtDone: 'Auto MT 完了',
    stop: '停止',
    translatedBadgeTitle: 'MangaTranslator で翻訳済み',
    translatingBadgeTitle: 'このページを翻訳中…',
    noMangaImagesPage: 'このページに漫画画像が見つかりません。',
    pageAlt: 'ページ {page}',
    pagesLabel: 'ページ',
    all: 'すべて',
    none: 'なし',
    close: '閉じる',
    foundImagesOnPage: 'このページで {count} 枚の画像を検出',
    autoCollect: '自動収集',
    cancel: 'キャンセル',
    translate: '翻訳',
    starting: '開始中...',
    cancelledTranslated: 'キャンセル - {success}/{total} 翻訳済み',
    allImagesTranslated: '{count} 枚すべて翻訳しました！',
    partialTranslated: '{success}/{total} 翻訳済み',
    scanningPage: 'ページをスキャン中...',
    noImagesFoundOnPage: 'ページに画像が見つかりません',
    foundImages: '{count} 枚の画像を検出...',
    foundMangaImages: '{count} 枚の漫画画像を検出',
    cached: 'キャッシュ',
    loadError: '読み込みエラー',
    sending: '送信中...',
    translating: '翻訳中...',
    noResult: '結果なし',
    bubbles: '{count} 吹き出し - {time}s',
    doneWithTime: '完了 - {time}s',
    networkError: 'ネットワークエラー',
    extensionDisabled: '拡張機能は無効です',
    suggestInstructions: 'ノートを提案',
    suggestInstructionsHint: '選択したページを分析し、ストーリーメモ（登場人物・関係・トーン）を作成します',
    suggesting: '分析中...',
    suggestionSaved: '提案をストーリーメモに保存しました',
    suggestNoImagesReady: '選択したページがまだ読み込み中です。しばらくしてから再試行してください',
    retryBadgeTitle: '数回再試行しましたが翻訳に失敗しました。クリックして再試行',
    fixHintTooltip: 'クリックしてこの吹き出しの翻訳を修正',
    zoomTooltip: 'クリックして拡大表示',
    fixHintCurrentLabel: '現在の訳:',
    fixHintPlaceholder: '修正内容を入力（例:「敬語にして」「代名詞が違う」など）',
    fixHintApply: '適用',
    fixHintApplying: '再翻訳中...',
    fixHintEmpty: '修正内容を入力してください',
    fixHintError: '修正に失敗しました - 再試行してください',
    exportPageTitle: 'このページの翻訳画像をダウンロード',
    btnExportAll: 'エクスポート',
    exportingStatus: 'エクスポート中...',
    exportNoneTranslated: 'まだエクスポートできる翻訳済みページがありません',
    exportDone: '{count} ページをエクスポートしました',
    btnFixSelected: '選択したページを修正',
    fixSelectedTitle: '選択した {count} ページの翻訳を修正',
    fixSelectedPlaceholder: '修正内容を入力（例:「キャラクター名 Yuki が Yuuki と誤訳されている」）',
    fixSelectedNoneTranslated: '選択したページの中に翻訳済みのものがありません',
    fixSelectedDone: '{success}/{total} ページを修正しました',
    cacheTooLargeToLoad: '翻訳済みページのキャッシュが {mb}MB あり、大きすぎて読み込めません。そのため今回のセッションでは以前翻訳したページが「翻訳済み」と表示されません。Config の「Clear translated cache」でリセットしてください。',
    btnBackToTranslate: '翻訳',
  },
  ko: {
    autoMt: 'Auto MT',
    autoMtDone: 'Auto MT 완료',
    stop: '중지',
    translatedBadgeTitle: 'MangaTranslator로 번역됨',
    translatingBadgeTitle: '이 페이지 번역 중…',
    noMangaImagesPage: '이 페이지에서 만화 이미지를 찾지 못했습니다.',
    pageAlt: '페이지 {page}',
    pagesLabel: '페이지',
    all: '전체',
    none: '선택 해제',
    close: '닫기',
    foundImagesOnPage: '이 페이지에서 이미지 {count}개 발견',
    autoCollect: '자동 수집',
    cancel: '취소',
    translate: '번역',
    starting: '시작 중...',
    cancelledTranslated: '취소됨 - {success}/{total} 번역됨',
    allImagesTranslated: '이미지 {count}개 모두 번역됨!',
    partialTranslated: '{success}/{total} 번역됨',
    scanningPage: '페이지 스캔 중...',
    noImagesFoundOnPage: '페이지에서 이미지를 찾지 못했습니다',
    foundImages: '이미지 {count}개 발견...',
    foundMangaImages: '만화 이미지 {count}개 발견',
    cached: '캐시',
    loadError: '로드 오류',
    sending: '전송 중...',
    translating: '번역 중...',
    noResult: '결과 없음',
    bubbles: '말풍선 {count}개 - {time}s',
    doneWithTime: '완료 - {time}s',
    networkError: '네트워크 오류',
    extensionDisabled: '확장 프로그램이 꺼져 있습니다',
    suggestInstructions: '메모 제안',
    suggestInstructionsHint: '선택한 페이지를 분석해 스토리 메모(등장인물, 관계, 어조)를 작성합니다',
    suggesting: '분석 중...',
    suggestionSaved: '제안이 스토리 메모에 저장되었습니다',
    suggestNoImagesReady: '선택한 페이지를 아직 불러오는 중입니다. 잠시 후 다시 시도하세요',
    retryBadgeTitle: '여러 번 재시도했지만 번역에 실패했습니다 - 클릭하여 다시 시도',
    fixHintTooltip: '클릭하여 이 말풍선의 번역 수정',
    zoomTooltip: '클릭하여 크게 보기',
    fixHintCurrentLabel: '현재:',
    fixHintPlaceholder: '수정 내용을 입력하세요 (예: "존댓말로", "대명사가 틀림")',
    fixHintApply: '적용',
    fixHintApplying: '다시 번역 중...',
    fixHintEmpty: '수정 내용을 먼저 입력하세요',
    fixHintError: '수정 실패 - 다시 시도하세요',
    exportPageTitle: '이 페이지의 번역 이미지 다운로드',
    btnExportAll: '내보내기',
    exportingStatus: '내보내는 중...',
    exportNoneTranslated: '아직 내보낼 번역된 페이지가 없습니다',
    exportDone: '{count}개 페이지를 내보냈습니다',
    btnFixSelected: '선택한 페이지 수정',
    fixSelectedTitle: '선택한 {count}개 페이지의 번역 수정',
    fixSelectedPlaceholder: '수정 내용을 입력하세요 (예: "캐릭터 이름 Yuki가 Yuuki로 잘못 번역됨")',
    fixSelectedNoneTranslated: '선택한 페이지 중 번역된 것이 없습니다',
    fixSelectedDone: '{success}/{total}개 페이지를 수정했습니다',
    cacheTooLargeToLoad: '번역된 페이지 캐시가 {mb}MB로 너무 커서 불러올 수 없습니다. 이번 세션에서는 이전에 번역한 페이지가 번역됨으로 표시되지 않습니다. Config의 "Clear translated cache"로 초기화하세요.',
    btnBackToTranslate: '번역',
  },
};

function normalizeUiLanguage(language: unknown): UiLanguage {
  return language === 'vi' || language === 'zh' || language === 'ja' || language === 'ko' ? language : 'en';
}

// ─────────────────────────────────────────────────────────────────────────────
// Extension message listener
// ─────────────────────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, send) => {
  if (msg.type === 'PING') { send({ ok: true }); return false; }
  if (msg.type === 'OPEN_SCANNER') {
    void openScanner().then(() => send({ ok: true })).catch((e) => send({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'START_AUTO_TRANSLATE') {
    void startAutoTranslate().then(() => send({ ok: true })).catch((e) => send({ ok: false, error: String(e) }));
    return true;
  }
  if (msg.type === 'STOP_AUTO_TRANSLATE') {
    stopAutoTranslate();
    send({ ok: true });
    return false;
  }
  if (msg.type === 'GET_AUTO_TRANSLATE_STATUS') {
    send({ active: autoTranslateActive });
    return false;
  }
  if (msg.type === 'CLEAR_CACHE') {
    void clearTranslatedCache();
    send({ ok: true });
    return false;
  }
  if (msg.type === 'SUGGEST_FROM_SCAN') {
    void (async () => {
      const { enableWebSearch, storyTitle } = msg as { enableWebSearch?: boolean; storyTitle?: string };
      const images = Array.from(imageCache.values())
        .map(extractBase64FromDataUrl)
        .filter((b64): b64 is string => Boolean(b64))
        .slice(0, SUGGEST_INSTRUCTIONS_MAX_IMAGES);
      const result = await runSuggestInstructions(images, enableWebSearch, storyTitle);
      send(result);
    })();
    return true;
  }
  return false;
});

// ─────────────────────────────────────────────────────────────────────────────
// Shared scanner state
// ─────────────────────────────────────────────────────────────────────────────

interface PageEntry {
  index: number;
  thumb: string;
  rawUrl: string;
  fetched: boolean;
}

let abortCollect = false;
let abortTranslate = false;
let currentPages: PageEntry[] = [];
let currentShadow: ShadowRoot | null = null;
let totalChapterPages = 0;
let seenUrls = new Set<string>();
let imageCache = new Map<string, string>();
let uiLanguage: UiLanguage = 'en';

function tr(key: ContentMessageKey, vars: Record<string, string | number> = {}): string {
  const template = CONTENT_MESSAGES[uiLanguage]?.[key] ?? EN_MESSAGES[key] ?? key;
  return Object.entries(vars).reduce((text, [name, value]) => text.replaceAll(`{${name}}`, String(value)), template);
}

async function refreshUiLanguage(): Promise<void> {
  const settings = await loadSettings();
  uiLanguage = normalizeUiLanguage(settings.uiLanguage);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-translate state
// ─────────────────────────────────────────────────────────────────────────────

let autoTranslateActive = false;
let autoTranslateObserver: MutationObserver | null = null;
let autoTranslateIntersectionObserver: IntersectionObserver | null = null;
let autoTranslateScanTimer: number | undefined;
let autoTranslatePeriodicTimer: number | undefined;
let autoTranslateRemoveUiTimer: number | undefined;
let autoTranslatePendingMutationNodes = new Set<Element>();
let autoTranslateMutationFlushScheduled = false;
let autoTranslateQueue: Array<{ img: HTMLImageElement; url: string; priority: boolean }> = [];
let autoTranslateQueuedUrls = new Set<string>();
const autoTranslateInFlightUrls = new Set<string>();
let autoTranslateProcessing = false;
let autoTranslateConcurrent = 0;
let scannerPausedAutoTranslate = false;
let translatedOverlayCounter = 0;
let preTranslateEnabled = false;
// When Context Memory is on and the user hasn't opted out of the sequential
// mode, cap auto-translate to 1 page in flight at a time — with several
// pages running in parallel (the normal case), a page routinely starts
// before an earlier one has written its Context Memory note, so it never
// sees it at all. See startAutoTranslate().
let autoTranslateSequentialForContextMemory = false;
// Rolling history of recently-translated pages' OCR transcripts, sent as
// narrative context so the model keeps character names, pronouns, and tone
// consistent across pages instead of translating each page in isolation.
// Keyed by the <img> element rather than a flat push-on-completion array —
// with AUTO_MAX_CONCURRENT pages in flight at once, completion order can
// differ from reading order (a later page can finish first), so context is
// resolved per-request from actual DOM document order (see
// orderedPreviousContextTexts), not insertion order.
let autoTranslatePreviousPages: Array<{ img: HTMLImageElement; ocrTexts: string[] }> = [];
const PREVIOUS_CONTEXT_MAX_PAGES = 3;
// Stored entries are trimmed once they exceed this multiple of what any
// single request can use — bounds memory on long infinite-scroll sessions
// without needing a precise "furthest from current page" eviction, since
// only the closest preceding pages are ever read anyway.
const PREVIOUS_CONTEXT_STORE_LIMIT = PREVIOUS_CONTEXT_MAX_PAGES * 6;

// Pages that come before `currentImg` in actual document order (i.e. reading
// order for a standard top-to-bottom manga reader), closest-preceding-first
// among the stored history, returned oldest-to-newest as the backend expects.
// Entries whose <img> was detached/replaced by the site (compareDocumentPosition
// can't place them) or that live in a different document (e.g. a Scanner
// grid's own <img>) are skipped rather than guessed at.
function orderedPreviousContextTexts(currentImg: HTMLImageElement): string[][] {
  const preceding = autoTranslatePreviousPages.filter(({ img }) => {
    if (img === currentImg || !img.isConnected) return false;
    const position = img.compareDocumentPosition(currentImg);
    return Boolean(position & Node.DOCUMENT_POSITION_FOLLOWING);
  });
  preceding.sort((a, b) => {
    const position = a.img.compareDocumentPosition(b.img);
    if (position & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (position & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
  return preceding.slice(-PREVIOUS_CONTEXT_MAX_PAGES).map((entry) => entry.ocrTexts);
}
const AUTO_MAX_CONCURRENT = 5;
const SUGGEST_INSTRUCTIONS_MAX_IMAGES = 8;

// imageCache can hold a plain (non-data:) URL when bgFetchImage's base64
// conversion failed or timed out — a fine fallback for <img src> thumbnail
// display, but never valid image bytes. It can also hold a "successfully
// fetched" data URL whose payload is actually a placeholder (some lazy
// readers serve an inline SVG placeholder that ends up base64-wrapped
// here instead of the real page). Requiring the captured portion to be
// pure base64 alphabet rejects both cases instead of forwarding garbage
// to the backend.
function extractBase64FromDataUrl(src: string): string | null {
  const match = /^data:image\/[\w+.-]+;base64,([A-Za-z0-9+/]+=*)$/.exec(src);
  return match ? match[1] : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Export: download translated page(s) as PNG (single page) or a ZIP (batch)
// ─────────────────────────────────────────────────────────────────────────────

function base64ToBlob(base64: string, mimeType = 'image/png'): Blob {
  const byteChars = atob(base64);
  const byteNumbers = new Array(byteChars.length);
  for (let i = 0; i < byteChars.length; i++) byteNumbers[i] = byteChars.charCodeAt(i);
  return new Blob([new Uint8Array(byteNumbers)], { type: mimeType });
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// Best-effort readable filename from the source image URL — falls back to a
// generic name if the URL has no usable path segment (e.g. a blob: URL).
function filenameFromUrl(url: string, index?: number): string {
  let base = '';
  try {
    const parsed = new URL(url);
    const last = parsed.pathname.split('/').filter(Boolean).pop();
    if (last) base = last.replace(/\.[a-zA-Z0-9]+$/, '');
  } catch { /* not a parseable absolute URL (e.g. blob:) */ }
  if (!base) base = index !== undefined ? `page_${String(index + 1).padStart(3, '0')}` : 'page';
  return `${base}-translated.png`;
}

function downloadTranslatedPage(base64: string, url: string, index?: number): void {
  triggerDownload(base64ToBlob(base64), filenameFromUrl(url, index));
}

async function exportTranslatedPagesAsZip(
  entries: Array<{ url: string; base64: string; index: number }>,
  onStatus?: (text: string) => void,
): Promise<void> {
  const zip = new JSZip();
  entries.forEach(({ url, base64, index }) => {
    zip.file(filenameFromUrl(url, index).replace(/-translated\.png$/, '.png'), base64, { base64: true });
  });
  onStatus?.(tr('exportingStatus'));
  const blob = await zip.generateAsync({ type: 'blob' });
  const stamp = new Date().toISOString().slice(0, 10);
  triggerDownload(blob, `manga-translated-${stamp}.zip`);
}

const AUTO_VIEWPORT_MARGIN_PX = 250;
const AUTO_PREFETCH_PAGES = 3;
// Pre-translate mode: how many pages can be queued/in-flight ahead of the
// viewport at once. Caps API spend/backend load instead of eagerly
// translating an entire long feed the moment its images hit the DOM.
const PRE_TRANSLATE_MAX_LOOKAHEAD = 15;
const AUTO_SCAN_LIMIT = 250;
const LAZY_IMAGE_ATTRS = ['data-src', 'data-lazy-src', 'data-original', 'data-srcset', 'data-lazy', 'data-image'] as const;
const AUTO_RETRY_MAP = new Map<string, number>(); // url -> retry count
const AUTO_RETRY_MAX = 3;

// Per-image bubble/request context from the most recent successful translate
// in this session — powers the "click a bubble to fix its translation"
// affordance. Cache-hit paths don't repopulate this (no bubbles data comes
// back from a cache hit), so the affordance is only available for pages
// translated fresh in this session.
const lastTranslateInfo = new WeakMap<HTMLImageElement, { bubbles: BubbleInfo[]; body: TranslateRequest; url: string }>();
let activeFixPopover: HTMLElement | null = null;
let activeBubbleMagnifier: HTMLElement | null = null;
// While a fix-hint re-translate is in flight, don't let auto-translate start
// new pages — they'd compete for the same backend/GPU capacity and make the
// fix the user is actively waiting on feel stuck behind background work.
// Already in-flight auto-translate calls are left alone (not cancelled).
let fixHintPending = 0;

// Records a failed auto-translate attempt. Once retries are exhausted the
// image would otherwise just sit untranslated forever with nothing but a
// console.log to show for it (queueAutoTranslateImage refuses to queue it
// again past AUTO_RETRY_MAX) — so surface it visibly instead, with a badge
// the user can click to force one more attempt.
//
// Rate-limit/cooling-down/out-of-credit errors used to be exempted from
// counting toward this at all, on the assumption the backend's own key/
// provider rotation and cooldown would always resolve them before the user
// needed to do anything — but if every configured key/provider is
// exhausted at once (e.g. a shared daily quota, not just a per-minute rate
// limit), the periodic re-scan just keeps retrying forever with nothing
// ever shown, and the page sits blank with no visible sign anything is
// wrong. Counting every failure the same way means it still gets several
// automatic attempts (AUTO_RETRY_MAX), but is guaranteed to eventually
// surface the retry badge either way.
function markAutoTranslateFailure(img: HTMLImageElement, url: string, retries: number): void {
  const nextRetries = retries + 1;
  AUTO_RETRY_MAP.set(url, nextRetries);
  if (nextRetries >= AUTO_RETRY_MAX) {
    addRetryNeededBadge(img, url);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-translate: start / stop
// ─────────────────────────────────────────────────────────────────────────────

async function startAutoTranslate(): Promise<void> {
  if (autoTranslateActive) return;
  await refreshUiLanguage();

  const settings = await loadSettings();
  if (settings.extensionEnabled === false) {
    toast(tr('extensionDisabled'), true);
    throw new Error(tr('extensionDisabled'));
  }

  autoTranslateActive = true;
  if (autoTranslateRemoveUiTimer !== undefined) {
    clearTimeout(autoTranslateRemoveUiTimer);
    autoTranslateRemoveUiTimer = undefined;
  }

  preTranslateEnabled = settings.config.preTranslate ?? false;
  autoTranslateSequentialForContextMemory =
    (settings.config.contextMemoryEnabled ?? false) && (settings.config.contextMemorySequential ?? true);
  autoTranslatePreviousPages = [];

  // Load already-translated URLs from cache
  await loadTranslatedCache();

  // Inject floating indicator
  injectAutoTranslateUI();
  autoTranslateIntersectionObserver = new IntersectionObserver(
    (entries) => {
      if (!autoTranslateActive) return;
      for (const entry of entries) {
        if (!entry.isIntersecting || !(entry.target instanceof HTMLImageElement)) continue;
        handleAutoTranslateImage(entry.target, true);
      }
      void processAutoTranslateQueue();
    },
    { rootMargin: `${AUTO_VIEWPORT_MARGIN_PX}px 0px ${AUTO_VIEWPORT_MARGIN_PX}px 0px`, threshold: 0.01 },
  );

  scanAutoTranslateImages(document);

  void processAutoTranslateQueue();

  // Watch for new images and lazy-loader attribute changes. Mutation
  // callbacks can fire in rapid bursts (infinite-scroll sites lazy-loading
  // many images at once) — collecting nodes into a shared Set and only
  // actually scanning them once per animation frame avoids a forced-layout
  // storm (handleAutoTranslateImage/scanAutoTranslateImages call
  // getBoundingClientRect) from running once per node per burst.
  autoTranslateObserver = new MutationObserver((mutations) => {
    if (!autoTranslateActive) return;
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        autoTranslatePendingMutationNodes.add(node as Element);
      }
    }
    scheduleAutoTranslateMutationFlush();
  });

  autoTranslateObserver.observe(document.body, {
    childList: true,
    subtree: true,
  });

  window.addEventListener('scroll', scheduleAutoTranslateScan, { passive: true });
  window.addEventListener('resize', scheduleAutoTranslateScan, { passive: true });
  document.addEventListener('visibilitychange', handleAutoTranslateVisibilityChange);
  restartAutoTranslatePeriodicTimer();

  updateAutoTranslateIndicator('active');
}

function scheduleAutoTranslateMutationFlush(): void {
  if (autoTranslateMutationFlushScheduled) return;
  autoTranslateMutationFlushScheduled = true;
  window.requestAnimationFrame(() => {
    autoTranslateMutationFlushScheduled = false;
    const nodes = autoTranslatePendingMutationNodes;
    autoTranslatePendingMutationNodes = new Set();
    if (!autoTranslateActive) return;
    for (const el of nodes) {
      if (el.tagName === 'IMG') {
        handleAutoTranslateImage(el as HTMLImageElement);
      }
      scanAutoTranslateImages(el);
    }
    void processAutoTranslateQueue();
  });
}

// The periodic DOM rescan (fallback for lazy-loaders that swap an existing
// <img>'s src/data-src attribute in place, which the MutationObserver above
// — watching childList/subtree, not attributes — doesn't catch) has nothing
// useful to look at while the tab isn't visible: nothing the reader isn't
// looking at can lazy-load via scroll, and any already-queued/in-flight
// translation keeps running regardless (processAutoTranslateQueue is a
// self-sustaining loop, not gated by this timer). Slow it down instead of
// fully stopping it, so a site's own background JS inserting/swapping images
// while hidden still gets picked up within half a minute rather than only on
// return — and do an immediate scan on return either way to catch up fast.
const AUTO_PERIODIC_SCAN_INTERVAL_MS = 4000;
const AUTO_PERIODIC_SCAN_INTERVAL_HIDDEN_MS = 25000;

function restartAutoTranslatePeriodicTimer(): void {
  if (autoTranslatePeriodicTimer !== undefined) {
    window.clearInterval(autoTranslatePeriodicTimer);
  }
  const interval = document.hidden ? AUTO_PERIODIC_SCAN_INTERVAL_HIDDEN_MS : AUTO_PERIODIC_SCAN_INTERVAL_MS;
  autoTranslatePeriodicTimer = window.setInterval(scheduleAutoTranslateScan, interval);
}

function handleAutoTranslateVisibilityChange(): void {
  if (!autoTranslateActive) return;
  restartAutoTranslatePeriodicTimer();
  if (!document.hidden) scheduleAutoTranslateScan();
}

function scheduleAutoTranslateScan(): void {
  if (!autoTranslateActive) return;
  if (autoTranslateScanTimer !== undefined) return;
  autoTranslateScanTimer = window.setTimeout(() => {
    autoTranslateScanTimer = undefined;
    scanAutoTranslateImages(document);
    promoteCurrentPageToFront();
    void processAutoTranslateQueue();
  }, 350);
}

function scanAutoTranslateImages(root: ParentNode): void {
  const imgs = root instanceof HTMLImageElement
    ? [root]
    : Array.from(root.querySelectorAll<HTMLImageElement>('img'));
  let handled = 0;
  for (const img of imgs) {
    handleAutoTranslateImage(img);
    handled++;
    if (handled >= AUTO_SCAN_LIMIT) break;
  }
}

function isNearViewport(el: Element): boolean {
  const rect = el.getBoundingClientRect();
  const viewportH = window.innerHeight || document.documentElement.clientHeight;
  const viewportW = window.innerWidth || document.documentElement.clientWidth;
  return rect.bottom >= -AUTO_VIEWPORT_MARGIN_PX
    && rect.top <= viewportH + AUTO_VIEWPORT_MARGIN_PX
    && rect.right >= -200
    && rect.left <= viewportW + 200;
}

// The image whose vertical center is closest to the viewport's vertical
// center — a proxy for "the page the reader is actually looking at right
// now", as distinct from "somewhere in the near-viewport margin" (which
// isNearViewport uses and can include the page just above/below it too).
function getCurrentCenterImg(): HTMLImageElement | null {
  const viewportCenter = (window.innerHeight || document.documentElement.clientHeight) / 2;
  let best: HTMLImageElement | null = null;
  let bestDist = Infinity;
  for (const img of document.querySelectorAll<HTMLImageElement>('img')) {
    if (img.classList.contains('mt-page-overlay')) continue;
    const rect = img.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    if (rect.bottom < 0 || rect.top > (window.innerHeight || document.documentElement.clientHeight)) continue;
    const elCenter = rect.top + rect.height / 2;
    const dist = Math.abs(elCenter - viewportCenter);
    if (dist < bestDist) {
      bestDist = dist;
      best = img;
    }
  }
  return best;
}

// Always keep the page closest to viewport center at the true front of the
// queue — plain unshift-on-discovery order can put a page that just barely
// entered the margin ahead of the one actually centered on screen (whichever
// gets scanned last wins), so this re-asserts the invariant every tick.
function promoteCurrentPageToFront(): void {
  const current = getCurrentCenterImg();
  if (!current) return;
  const url = current.getAttribute('data-mt-raw') ?? resolveMangaUrl(current);
  if (!url) return;
  if (translatedCache.has(url) || autoTranslateInFlightUrls.has(url)) return;

  const idx = autoTranslateQueue.findIndex((entry) => entry.url === url);
  if (idx > 0) {
    const [entry] = autoTranslateQueue.splice(idx, 1);
    entry.priority = true;
    autoTranslateQueue.unshift(entry);
  } else if (idx === -1) {
    handleAutoTranslateImage(current, true);
  }
}

function isUsableImageUrl(url: string | null | undefined): url is string {
  // blob: URLs are how sites like MangaDex serve reader pages (fetched via JS,
  // no plain <img src="https://...">) — they're still usable since we capture
  // the already-loaded <img> element straight to canvas (see captureImgElement),
  // which doesn't care what scheme populated it. data: is excluded because it's
  // either a placeholder/spacer or our own already-translated overlay output.
  return !!url && url !== window.location.href && !url.startsWith('data:');
}

function firstSrcsetUrl(value: string): string | null {
  return value.split(',')[0]?.trim().split(/\s+/)[0] || null;
}

function resolveLazyAttributeSrc(img: HTMLImageElement): string | null {
  for (const attr of LAZY_IMAGE_ATTRS) {
    const val = img.getAttribute(attr);
    if (!val) continue;

    const candidate = attr === 'data-srcset' ? firstSrcsetUrl(val) : val;
    if (isUsableImageUrl(candidate)) return candidate;
  }

  return null;
}

function handleAutoTranslateImage(img: HTMLImageElement, force = false): void {
  // The translated overlay is a separate <img> stacked on top (see
  // applyTranslatedOverlay) — the original element's own src/currentSrc is
  // never rewritten to a data: URL, so a check requiring that was dead code
  // that never matched. Without this early return, every already-translated
  // image got fully re-applied — overlay src reset, badge element recreated —
  // on every periodic auto-translate scan (~4s) and every scroll/resize event,
  // for as long as auto-translate stayed on. That's harmless in isolation
  // (same src re-assigned) but caused visible flicker/jank whenever other
  // pages were translating concurrently and the main thread was already busy
  // decoding/painting their large base64 overlays.
  // Position still needs to stay in sync as the page reflows (infinite-scroll
  // readers shift layout as more images load below), so keep that part —
  // just skip the src/badge recreation.
  if (img.getAttribute('data-mt-translated') === 'true') {
    syncTranslatedDecorations(img);
    return;
  }

  const url = resolveMangaUrl(img);
  if (!url) return;
  img.setAttribute('data-mt-raw', url);

  const withinPreTranslateBudget = preTranslateEnabled
    && !translatedCache.has(url)
    && (autoTranslateQueue.length + autoTranslateInFlightUrls.size) < PRE_TRANSLATE_MAX_LOOKAHEAD;

  if (!force && !withinPreTranslateBudget && !isNearViewport(img)) {
    autoTranslateIntersectionObserver?.observe(img);
    return;
  }

  autoTranslateIntersectionObserver?.unobserve(img);

  const cached = translatedCache.get(url);
  if (cached) {
    applyTranslatedImage(img, `data:image/png;base64,${cached}`, url);
    if (isNearViewport(img)) queueAutoTranslateLookahead(img);
    return;
  }

  // Near-viewport (or force-triggered) images are what the reader is actually
  // looking at right now — jump them to the front of the queue so eager
  // pre-translate work queued for pages further ahead never delays them.
  queueAutoTranslateImage(img, url, force || isNearViewport(img));
  queueAutoTranslateLookahead(img);
}

function queueAutoTranslateImage(img: HTMLImageElement, url: string, priority = false): boolean {
  if (translatedCache.has(url)) {
    applyTranslatedImage(img, `data:image/png;base64,${translatedCache.get(url)!}`, url);
    return false;
  }

  if (autoTranslateQueuedUrls.has(url) || autoTranslateInFlightUrls.has(url)) return false;
  if ((AUTO_RETRY_MAP.get(url) ?? 0) >= AUTO_RETRY_MAX) return false;

  autoTranslateQueuedUrls.add(url);
  if (priority) {
    autoTranslateQueue.unshift({ img, url, priority });
  } else {
    autoTranslateQueue.push({ img, url, priority });
  }
  autoTranslateIntersectionObserver?.unobserve(img);
  return true;
}

function queueAutoTranslateLookahead(anchorImg: HTMLImageElement): number {
  const anchorUrl = anchorImg.getAttribute('data-mt-raw') ?? resolveMangaUrl(anchorImg);
  if (!anchorUrl) return 0;

  const entries = collectAutoTranslateImageEntries(document);
  const anchorIndex = entries.findIndex((entry) => entry.img === anchorImg || entry.url === anchorUrl);
  if (anchorIndex < 0) return 0;

  const seenUrls = new Set<string>([anchorUrl]);
  let aheadPages = 0;
  for (let i = anchorIndex + 1; i < entries.length && aheadPages < AUTO_PREFETCH_PAGES; i++) {
    const entry = entries[i];
    if (seenUrls.has(entry.url)) continue;
    seenUrls.add(entry.url);
    aheadPages++;
    queueAutoTranslateImage(entry.img, entry.url);
  }

  return aheadPages;
}

function collectAutoTranslateImageEntries(root: ParentNode): Array<{ img: HTMLImageElement; url: string }> {
  const imgs = root instanceof HTMLImageElement
    ? [root]
    : Array.from(root.querySelectorAll<HTMLImageElement>('img'));
  const entries: Array<{ img: HTMLImageElement; url: string }> = [];

  for (const img of imgs) {
    if (img.classList.contains('mt-page-overlay')) continue;
    const url = resolveMangaUrl(img);
    if (!url) continue;
    img.setAttribute('data-mt-raw', url);
    entries.push({ img, url });
    if (entries.length >= AUTO_SCAN_LIMIT) break;
  }

  return entries;
}

function stopAutoTranslate(preserveScannerResume = false): void {
  autoTranslateActive = false;
  preTranslateEnabled = false;
  autoTranslateSequentialForContextMemory = false;
  autoTranslatePreviousPages = [];
  if (!preserveScannerResume) scannerPausedAutoTranslate = false;
  autoTranslateQueue = [];
  autoTranslateQueuedUrls = new Set();
  if (autoTranslateObserver) {
    autoTranslateObserver.disconnect();
    autoTranslateObserver = null;
  }
  if (autoTranslateIntersectionObserver) {
    autoTranslateIntersectionObserver.disconnect();
    autoTranslateIntersectionObserver = null;
  }
  if (autoTranslateScanTimer !== undefined) {
    clearTimeout(autoTranslateScanTimer);
    autoTranslateScanTimer = undefined;
  }
  if (autoTranslatePeriodicTimer !== undefined) {
    clearInterval(autoTranslatePeriodicTimer);
    autoTranslatePeriodicTimer = undefined;
  }
  autoTranslatePendingMutationNodes = new Set();
  autoTranslateMutationFlushScheduled = false;
  window.removeEventListener('scroll', scheduleAutoTranslateScan);
  window.removeEventListener('resize', scheduleAutoTranslateScan);
  document.removeEventListener('visibilitychange', handleAutoTranslateVisibilityChange);
  updateAutoTranslateIndicator('stopped');
  if (autoTranslateRemoveUiTimer !== undefined) clearTimeout(autoTranslateRemoveUiTimer);
  autoTranslateRemoveUiTimer = window.setTimeout(() => {
    autoTranslateRemoveUiTimer = undefined;
    removeAutoTranslateUI();
  }, 600);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-translate: resolve manga image URL
// ─────────────────────────────────────────────────────────────────────────────

function resolveMangaUrl(img: HTMLImageElement): string | null {
  const existingRaw = img.getAttribute('data-mt-raw');
  if (existingRaw && !existingRaw.startsWith('data:')) return existingRaw;

  // Skip icons, avatars, small images
  const w = img.naturalWidth || Number(img.getAttribute('width')) || 0;
  const h = img.naturalHeight || Number(img.getAttribute('height')) || 0;
  const renderedW = img.getBoundingClientRect().width;
  if (w > 0 && h > 0 && (w < 150 || h < 100)) return null;
  if (w === 0 && h === 0 && renderedW > 0 && renderedW < 150) return null;

  const src = resolveLazyAttributeSrc(img) ?? img.currentSrc ?? img.src;
  if (!isUsableImageUrl(src)) return null;

  // Skip common non-manga images
  if (/avatar|icon|logo|btn|nav|header|footer|banner|placeholder|loading/i.test(src)) return null;

  return src;
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-translate: queue processor
// ─────────────────────────────────────────────────────────────────────────────

async function processAutoTranslateQueue(): Promise<void> {
  if (!autoTranslateActive) return;
  if (autoTranslateProcessing) return;
  autoTranslateProcessing = true;

  while (autoTranslateQueue.length > 0 && fixHintPending === 0) {
    // Reserve at least one concurrency slot for priority (near-viewport)
    // work — pre-translate lookahead must never fill every slot, or the
    // page the reader is actually looking at can get stuck queued behind
    // several 45-85s speculative translations with no slot to run in.
    const nextIsPriority = autoTranslateQueue[0].priority;
    const effectiveLimit = autoTranslateSequentialForContextMemory
      ? 1
      : nextIsPriority
        ? AUTO_MAX_CONCURRENT
        : Math.max(1, AUTO_MAX_CONCURRENT - 1);
    if (autoTranslateConcurrent >= effectiveLimit) break;

    const item = autoTranslateQueue.shift();
    if (!item) break;
    autoTranslateQueuedUrls.delete(item.url);
    if (!autoTranslateActive) break;

    // Skip if already being processed
    if (translatedCache.has(item.url)) {
      applyTranslatedImage(item.img, `data:image/png;base64,${translatedCache.get(item.url)!}`, item.url);
      if (isNearViewport(item.img)) queueAutoTranslateLookahead(item.img);
      console.log('[MT] apply from cache:', item.url);
      continue;
    }

    console.log('[MT] processing:', item.url);
    autoTranslateInFlightUrls.add(item.url);
    autoTranslateConcurrent++;
    void translateAndApply(item.img, item.url).finally(() => {
      autoTranslateInFlightUrls.delete(item.url);
      autoTranslateConcurrent--;
      autoTranslateProcessing = false;
      void processAutoTranslateQueue();
    });
  }

  autoTranslateProcessing = false;
}

async function translateAndApply(img: HTMLImageElement, url: string): Promise<void> {
  console.log('[MT] translateAndApply start:', url);
  if (!autoTranslateActive) { console.log('[MT] not active, returning'); return; }

  // Check retry count
  const retries = AUTO_RETRY_MAP.get(url) ?? 0;
  if (retries >= AUTO_RETRY_MAX) { console.log('[MT] max retries reached:', url); return; }

  updateAutoTranslateCounter();
  addInProgressBadge(img);

  try {
    const pageUrl = window.location.href;
    const imgData = await fetchImageData(url, pageUrl);
    if (!autoTranslateActive) return;
    if (!imgData) {
      console.log('[MT] image data unavailable:', url);
      markAutoTranslateFailure(img, url, retries);
      return;
    }

    const settings = await loadSettings();

    // Content-addressed cache: blob: URLs (e.g. MangaDex's reader) are
    // regenerated on every page load, so a URL-keyed cache never hits across
    // reloads/revisits even for pages already translated. Hash the actual
    // captured image bytes instead — stable across reloads regardless of URL.
    const contentKey = contentCacheKey(imgData, settings.config.outputLanguage);
    const contentCached = translatedContentCache.get(contentKey);
    if (contentCached) {
      console.log('[MT] content-cache hit:', url);
      rememberTranslated(url, contentCached);
      applyTranslatedImage(img, `data:image/png;base64,${contentCached}`, url);
      if (isNearViewport(img)) queueAutoTranslateLookahead(img);
      updateAutoTranslateCounter();
      return;
    }

    const contextMemoryEnabled = settings.config.contextMemoryEnabled ?? false;
    const storyKey = contextMemoryEnabled ? contextMemoryStoryKey(pageUrl) : '';
    const contextMemoryText = contextMemoryEnabled ? await loadContextMemoryText(storyKey) : '';

    const body = buildTranslateRequest(
      imgData,
      settings,
      settings.config.previousContextEnabled ?? false ? orderedPreviousContextTexts(img) : undefined,
      contextMemoryText,
    );

    console.log('[MT] routing translated body through background:', url);
    const result = await bgTranslateImageWithBody(url, pageUrl, body);
    if (!autoTranslateActive) return;

    if (result.error) {
      console.log('[MT] bgTranslateImage error:', result.error);
      markAutoTranslateFailure(img, url, retries);
      return;
    }

    if (!result.translated_image) {
      console.log('[MT] no translated_image in result');
      return;
    }

    const translatedB64 = result.translated_image;
    const dataUrl = `data:image/png;base64,${translatedB64}`;
    const bubbles = (result.bubbles as BubbleInfo[] | undefined) ?? [];
    lastTranslateInfo.set(img, { bubbles, body, url });

    // Cache it (both the fast within-session URL lookup and the persisted
    // content-addressed lookup that survives reloads/URL changes)
    rememberTranslated(url, translatedB64);
    rememberTranslatedContent(contentKey, translatedB64);
    await saveTranslatedCacheEntry(url, translatedB64);
    await saveTranslatedContentCacheEntry(contentKey, translatedB64);

    if (result.ocr_texts?.length) {
      autoTranslatePreviousPages.push({ img, ocrTexts: result.ocr_texts });
      if (autoTranslatePreviousPages.length > PREVIOUS_CONTEXT_STORE_LIMIT) {
        autoTranslatePreviousPages.shift();
      }
    }

    if (contextMemoryEnabled && result.memory_note) {
      void appendContextMemoryNote(storyKey, result.memory_note);
    }

    // Apply to the image element on page
    applyTranslatedImage(img, dataUrl, url);
    renderBubbleFixTargets(img, bubbles);
    if (isNearViewport(img)) queueAutoTranslateLookahead(img);
    console.log('[MT] applied:', url);
    updateAutoTranslateCounter();
  } finally {
    removeInProgressBadge(img);
  }
}

// Tracks the most recent overlay id used for each source URL. Some manga
// readers replace/recreate the <img> element for a page as you scroll (e.g.
// lazy-load libraries reclaiming memory for off-screen pages) — when that
// happens the old element's overlay/badge/export-button/fix-hit-layer are
// still in the DOM but orphaned (nothing points at them for cleanup or
// future updates), so a later fix-hint or cache update only touches the
// NEW element's fresh overlay while the orphaned one keeps showing stale
// content at its last-known position. Depending on paint order that can
// look like the page flickering between the old and new translation.
const urlToOverlayId = new Map<string, string>();

function removeOrphanedOverlayFor(url: string, currentOverlayId: string): void {
  const previousOverlayId = urlToOverlayId.get(url);
  if (previousOverlayId && previousOverlayId !== currentOverlayId) {
    document
      .querySelectorAll(
        `.mt-page-overlay[data-mt-for="${previousOverlayId}"], `
        + `.mt-badge[data-mt-for="${previousOverlayId}"], `
        + `.mt-export-btn[data-mt-for="${previousOverlayId}"], `
        + `.mt-fix-hit-layer[data-mt-for="${previousOverlayId}"], `
        + `.mt-retry-badge[data-mt-for="${previousOverlayId}"], `
        + `.mt-progress-badge[data-mt-for="${previousOverlayId}"]`,
      )
      .forEach((el) => el.remove());
  }
  urlToOverlayId.set(url, currentOverlayId);
}

function applyTranslatedImage(img: HTMLImageElement, dataUrl: string, rawUrl?: string): void {
  // Add translated marker so we don't re-process
  img.setAttribute('data-mt-translated', 'true');
  removeRetryBadge(img);
  removeInProgressBadge(img);

  const originalUrl = rawUrl ?? resolveMangaUrl(img);
  if (originalUrl) {
    img.setAttribute('data-mt-raw', originalUrl);
    removeOrphanedOverlayFor(originalUrl, getTranslatedOverlayId(img));
  }

  applyTranslatedOverlay(img, dataUrl);

  // Add a subtle badge overlay
  addTranslatedBadge(img);
  addExportButton(img);
}

function applyTranslatedOverlay(img: HTMLImageElement, dataUrl: string): void {
  const parent = img.parentElement;
  if (!parent) {
    img.src = dataUrl;
    return;
  }

  const parentStyle = window.getComputedStyle(parent);
  if (parentStyle.position === 'static') {
    parent.style.position = 'relative';
  }

  const overlayId = getTranslatedOverlayId(img);
  let overlay = findTranslatedOverlay(parent, overlayId);
  if (!overlay) {
    overlay = document.createElement('img');
    overlay.className = 'mt-page-overlay';
    overlay.alt = '';
    overlay.setAttribute('data-mt-for', overlayId);
    overlay.setAttribute('aria-hidden', 'true');
    parent.appendChild(overlay);
  }

  overlay.src = dataUrl;
  overlay.style.position = 'absolute';
  overlay.style.zIndex = '9';
  overlay.style.pointerEvents = 'none';
  overlay.style.display = 'block';
  overlay.style.maxWidth = 'none';
  overlay.style.opacity = '1';
  syncTranslatedOverlayLayout(img, overlay);
  scheduleTranslatedDecorationSync(img);
}

function getTranslatedOverlayId(img: HTMLImageElement): string {
  const existing = img.getAttribute('data-mt-overlay-id');
  if (existing) return existing;
  translatedOverlayCounter++;
  const id = `mt-page-${translatedOverlayCounter}`;
  img.setAttribute('data-mt-overlay-id', id);
  return id;
}

function findTranslatedOverlay(parent: HTMLElement, overlayId: string): HTMLImageElement | null {
  for (const child of Array.from(parent.children)) {
    if (
      child instanceof HTMLImageElement
      && child.classList.contains('mt-page-overlay')
      && child.getAttribute('data-mt-for') === overlayId
    ) {
      return child;
    }
  }
  return null;
}

function findTranslatedBadge(parent: HTMLElement, overlayId: string): HTMLElement | null {
  for (const child of Array.from(parent.children)) {
    if (
      child instanceof HTMLElement
      && child.classList.contains('mt-badge')
      && child.getAttribute('data-mt-for') === overlayId
    ) {
      return child;
    }
  }
  return null;
}

function getImagePositionWithinParent(img: HTMLImageElement, parent: HTMLElement): DOMRect {
  const imgRect = img.getBoundingClientRect();
  const parentRect = parent.getBoundingClientRect();
  return new DOMRect(
    imgRect.left - parentRect.left + parent.scrollLeft,
    imgRect.top - parentRect.top + parent.scrollTop,
    imgRect.width,
    imgRect.height,
  );
}

function syncTranslatedOverlayLayout(img: HTMLImageElement, overlay?: HTMLImageElement | null): void {
  const parent = img.parentElement;
  if (!parent) return;

  const overlayId = getTranslatedOverlayId(img);
  const targetOverlay = overlay ?? findTranslatedOverlay(parent, overlayId);
  if (!targetOverlay) return;

  const pos = getImagePositionWithinParent(img, parent);
  const imgStyle = window.getComputedStyle(img);
  targetOverlay.style.inset = 'auto';
  targetOverlay.style.left = `${pos.x}px`;
  targetOverlay.style.top = `${pos.y}px`;
  targetOverlay.style.width = `${pos.width}px`;
  targetOverlay.style.height = `${pos.height}px`;
  targetOverlay.style.objectFit = imgStyle.objectFit || 'fill';
  targetOverlay.style.objectPosition = imgStyle.objectPosition || '50% 50%';
}

function syncTranslatedBadgeLayout(img: HTMLImageElement, badge?: HTMLElement | null): void {
  const parent = img.parentElement;
  if (!parent) return;

  const overlayId = getTranslatedOverlayId(img);
  const targetBadge = badge ?? findTranslatedBadge(parent, overlayId);
  if (!targetBadge) return;

  const pos = getImagePositionWithinParent(img, parent);
  targetBadge.style.left = `${pos.x + pos.width - 4}px`;
  targetBadge.style.top = `${pos.y + 4}px`;
  targetBadge.style.right = 'auto';
  targetBadge.style.transform = 'translateX(-100%)';
}

function findExportButton(parent: HTMLElement, overlayId: string): HTMLElement | null {
  for (const child of Array.from(parent.children)) {
    if (
      child instanceof HTMLElement
      && child.classList.contains('mt-export-btn')
      && child.getAttribute('data-mt-for') === overlayId
    ) {
      return child;
    }
  }
  return null;
}

function syncExportButtonLayout(img: HTMLImageElement, btn?: HTMLElement | null): void {
  const parent = img.parentElement;
  if (!parent) return;

  const overlayId = getTranslatedOverlayId(img);
  const targetBtn = btn ?? findExportButton(parent, overlayId);
  if (!targetBtn) return;

  const pos = getImagePositionWithinParent(img, parent);
  // Stacked directly below the "MT" badge — avoids needing to know the
  // badge's rendered width to sit beside it horizontally.
  targetBtn.style.left = `${pos.x + pos.width - 4}px`;
  targetBtn.style.top = `${pos.y + 22}px`;
  targetBtn.style.right = 'auto';
  targetBtn.style.transform = 'translateX(-100%)';
}

// A small per-page download button next to the "MT" badge — lets the
// reader save just this page's translated image without opening the
// scanner. Reads translatedCache at click time (not a captured dataUrl)
// so it always exports whatever is currently applied, including after a
// click-to-fix correction.
function addExportButton(img: HTMLImageElement): void {
  const parent = img.parentElement;
  if (!parent) return;

  const parentStyle = window.getComputedStyle(parent);
  if (parentStyle.position === 'static') parent.style.position = 'relative';

  const overlayId = getTranslatedOverlayId(img);
  let btn = findExportButton(parent, overlayId);
  if (!btn) {
    btn = document.createElement('div');
    btn.className = 'mt-export-btn';
    btn.setAttribute('data-mt-for', overlayId);
    parent.appendChild(btn);
  }

  btn.textContent = '⬇';
  btn.title = tr('exportPageTitle');
  btn.style.position = 'absolute';
  btn.style.background = 'rgba(15,23,42,0.85)';
  btn.style.color = 'white';
  btn.style.fontSize = '10px';
  btn.style.lineHeight = '1';
  btn.style.padding = '2px 5px';
  btn.style.borderRadius = '4px';
  btn.style.cursor = 'pointer';
  btn.style.pointerEvents = 'auto';
  btn.style.zIndex = '10';
  btn.style.fontFamily = 'Inter, system-ui, sans-serif';

  const exportBtn = btn;
  exportBtn.onclick = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    const url = img.getAttribute('data-mt-raw') ?? resolveMangaUrl(img);
    if (!url) return;
    const b64 = translatedCache.get(url);
    if (!b64) return;
    downloadTranslatedPage(b64, url);
  };

  syncExportButtonLayout(img, btn);
  scheduleTranslatedDecorationSync(img);
}

function syncTranslatedDecorations(img: HTMLImageElement): void {
  syncTranslatedOverlayLayout(img);
  syncTranslatedBadgeLayout(img);
  syncInProgressBadgeLayout(img);
  syncFixHitLayerLayout(img);
  syncExportButtonLayout(img);
}

function scheduleTranslatedDecorationSync(img: HTMLImageElement): void {
  window.requestAnimationFrame(() => syncTranslatedDecorations(img));
  window.setTimeout(() => syncTranslatedDecorations(img), 250);
  window.setTimeout(() => syncTranslatedDecorations(img), 1000);
}

function urlsMatch(a: string | null | undefined, b: string): boolean {
  if (!a) return false;
  try {
    return new URL(a, window.location.href).href === new URL(b, window.location.href).href;
  } catch {
    return a === b;
  }
}

// bubbles/body are optional: when the caller has fresh data from a translate
// response (not just a cache hit), passing them wires up lastTranslateInfo
// and renders clickable per-bubble fix targets — without this, pages
// translated via the scanner's "Translate" button or "Fix Selected" (as
// opposed to auto-translate, the only path that used to set this) never
// got click-to-fix working: clicking a bubble would open the popover fine,
// but Apply had nothing to send and returned immediately with no request
// ever reaching the backend.
function applyTranslatedImageToPage(
  rawUrl: string,
  dataUrl: string,
  bubbles?: BubbleInfo[],
  body?: TranslateRequest,
): boolean {
  let applied = false;

  for (const img of document.querySelectorAll<HTMLImageElement>('img')) {
    const candidates = [
      img.getAttribute('data-mt-raw'),
      img.currentSrc,
      img.src,
      img.getAttribute('data-src'),
      img.getAttribute('data-lazy-src'),
      img.getAttribute('data-original'),
      img.getAttribute('data-lazy'),
      img.getAttribute('data-image'),
    ];
    const srcset = img.getAttribute('data-srcset');
    if (srcset) candidates.push(srcset.split(',')[0]?.trim().split(' ')[0]);

    if (!candidates.some((candidate) => urlsMatch(candidate, rawUrl))) continue;

    applyTranslatedImage(img, dataUrl, rawUrl);
    applied = true;

    if (bubbles && body) {
      lastTranslateInfo.set(img, { bubbles, body, url: rawUrl });
      renderBubbleFixTargets(img, bubbles);
    }
  }

  for (const el of document.querySelectorAll<HTMLElement>('[style*="background-image"]')) {
    const style = el.getAttribute('style') ?? '';
    const match = style.match(/url\(["']?([^"')]+)["']?\)/);
    if (!match || !urlsMatch(match[1], rawUrl)) continue;

    el.setAttribute('data-mt-raw-bg', rawUrl);
    el.style.backgroundImage = `url("${dataUrl}")`;
    applied = true;
  }

  return applied;
}

function addTranslatedBadge(img: HTMLImageElement): void {
  const parent = img.parentElement;
  if (!parent) return;

  const parentStyle = window.getComputedStyle(parent);
  if (parentStyle.position === 'static') parent.style.position = 'relative';

  const overlayId = getTranslatedOverlayId(img);
  let badge = findTranslatedBadge(parent, overlayId);
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'mt-badge';
    badge.setAttribute('data-mt-for', overlayId);
    parent.appendChild(badge);
  }

  badge.textContent = 'MT';
  badge.title = tr('translatedBadgeTitle');
  badge.style.position = 'absolute';
  badge.style.background = 'rgba(34,197,94,0.85)';
  badge.style.color = 'white';
  badge.style.fontSize = '9px';
  badge.style.fontWeight = '900';
  badge.style.padding = '1px 5px';
  badge.style.borderRadius = '4px';
  badge.style.pointerEvents = 'none';
  badge.style.zIndex = '10';
  badge.style.fontFamily = 'Inter, system-ui, sans-serif';
  syncTranslatedBadgeLayout(img, badge);
  scheduleTranslatedDecorationSync(img);
}

function findInProgressBadge(parent: HTMLElement, overlayId: string): HTMLElement | null {
  for (const child of Array.from(parent.children)) {
    if (
      child instanceof HTMLElement
      && child.classList.contains('mt-progress-badge')
      && child.getAttribute('data-mt-for') === overlayId
    ) {
      return child;
    }
  }
  return null;
}

// Shown at the same corner as the "MT"/retry badges (mutually exclusive —
// a page is either not started, mid-translation, done, or failed) the
// moment a page actually starts its translate request, not just while
// queued — so with several pages in flight during auto-translate/batch,
// the reader can tell which page(s) are currently being worked on versus
// still waiting their turn in the queue.
function addInProgressBadge(img: HTMLImageElement): void {
  const parent = img.parentElement;
  if (!parent) return;

  const parentStyle = window.getComputedStyle(parent);
  if (parentStyle.position === 'static') parent.style.position = 'relative';

  const overlayId = getTranslatedOverlayId(img);
  let badge = findInProgressBadge(parent, overlayId);
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'mt-progress-badge';
    badge.setAttribute('data-mt-for', overlayId);
    parent.appendChild(badge);
  }

  badge.textContent = '···';
  badge.title = tr('translatingBadgeTitle');
  syncTranslatedBadgeLayout(img, badge);
  scheduleTranslatedDecorationSync(img);
}

function removeInProgressBadge(img: HTMLImageElement): void {
  const parent = img.parentElement;
  if (!parent) return;
  const overlayId = getTranslatedOverlayId(img);
  findInProgressBadge(parent, overlayId)?.remove();
}

function syncInProgressBadgeLayout(img: HTMLImageElement): void {
  const parent = img.parentElement;
  if (!parent) return;
  const overlayId = getTranslatedOverlayId(img);
  const badge = findInProgressBadge(parent, overlayId);
  if (badge) syncTranslatedBadgeLayout(img, badge);
}

function findRetryBadge(parent: HTMLElement, overlayId: string): HTMLElement | null {
  for (const child of Array.from(parent.children)) {
    if (
      child instanceof HTMLElement
      && child.classList.contains('mt-retry-badge')
      && child.getAttribute('data-mt-for') === overlayId
    ) {
      return child;
    }
  }
  return null;
}

function removeRetryBadge(img: HTMLImageElement): void {
  const parent = img.parentElement;
  if (!parent) return;
  const overlayId = getTranslatedOverlayId(img);
  findRetryBadge(parent, overlayId)?.remove();
}

function syncRetryBadgeLayout(img: HTMLImageElement, badge: HTMLElement): void {
  const parent = img.parentElement;
  if (!parent) return;
  const pos = getImagePositionWithinParent(img, parent);
  badge.style.left = `${pos.x + pos.width - 4}px`;
  badge.style.top = `${pos.y + 4}px`;
  badge.style.right = 'auto';
  badge.style.transform = 'translateX(-100%)';
}

// Shown when auto-translate has given up on an image after AUTO_RETRY_MAX
// failed attempts (rate limit exhausted across every configured key/
// provider, network error, etc.) — without this, a permanently failed page
// just silently stays untranslated with no visible sign anything went
// wrong (only a console.log). Clicking it resets the retry count and
// forces one more attempt.
function addRetryNeededBadge(img: HTMLImageElement, url: string): void {
  const parent = img.parentElement;
  if (!parent) return;

  const parentStyle = window.getComputedStyle(parent);
  if (parentStyle.position === 'static') parent.style.position = 'relative';

  const overlayId = getTranslatedOverlayId(img);
  let badge = findRetryBadge(parent, overlayId);
  if (!badge) {
    badge = document.createElement('div');
    badge.className = 'mt-retry-badge';
    badge.setAttribute('data-mt-for', overlayId);
    parent.appendChild(badge);
  }

  badge.textContent = '⟳';
  badge.title = tr('retryBadgeTitle');
  badge.style.position = 'absolute';
  badge.style.background = 'rgba(239,68,68,0.9)';
  badge.style.color = 'white';
  badge.style.fontSize = '13px';
  badge.style.fontWeight = '900';
  badge.style.padding = '1px 6px';
  badge.style.borderRadius = '4px';
  badge.style.cursor = 'pointer';
  badge.style.pointerEvents = 'auto';
  badge.style.zIndex = '11';
  badge.style.fontFamily = 'Inter, system-ui, sans-serif';

  const retryBadge = badge;
  retryBadge.onclick = (ev) => {
    ev.stopPropagation();
    ev.preventDefault();
    AUTO_RETRY_MAP.delete(url);
    retryBadge.remove();
    handleAutoTranslateImage(img, true);
  };

  syncRetryBadgeLayout(img, badge);
  window.requestAnimationFrame(() => syncRetryBadgeLayout(img, badge!));
  window.setTimeout(() => syncRetryBadgeLayout(img, badge!), 250);
  window.setTimeout(() => syncRetryBadgeLayout(img, badge!), 1000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Fix-hint: click a bubble to send the LLM a targeted correction and
// re-translate just that page with it. Cheap/easy version — re-runs the
// whole-page pipeline (same as any other translate call) rather than
// patching only the clicked bubble's pixels, since the backend has no
// per-bubble render cache to patch against.
// ─────────────────────────────────────────────────────────────────────────────

function findFixHitLayer(parent: HTMLElement, overlayId: string): HTMLElement | null {
  for (const child of Array.from(parent.children)) {
    if (
      child instanceof HTMLElement
      && child.classList.contains('mt-fix-hit-layer')
      && child.getAttribute('data-mt-for') === overlayId
    ) {
      return child;
    }
  }
  return null;
}

function syncFixHitLayerLayout(img: HTMLImageElement, layer?: HTMLElement | null): void {
  const parent = img.parentElement;
  if (!parent) return;
  const overlayId = getTranslatedOverlayId(img);
  const targetLayer = layer ?? findFixHitLayer(parent, overlayId);
  if (!targetLayer) return;
  const pos = getImagePositionWithinParent(img, parent);
  targetLayer.style.left = `${pos.x}px`;
  targetLayer.style.top = `${pos.y}px`;
  targetLayer.style.width = `${pos.width}px`;
  targetLayer.style.height = `${pos.height}px`;
}

// Reading-experience aid: hovering a bubble shows a zoomed crop of just that
// bubble, magnified relative to its CURRENT on-screen size (not the source
// image's raw resolution) — so it reads the same whether the page is shown
// full-width or shrunk into a small reader pane. Implemented as a CSS
// background-position "window" into the already-loaded translated overlay
// image, scaled up via background-size — no re-render, no extra request.
const MAGNIFIER_ZOOM = 2.5;
const MAGNIFIER_MAX_DIMENSION = 420;
const MAGNIFIER_MIN_DIMENSION = 140;
const MAGNIFIER_MAX_ZOOM = 6;

function showBubbleMagnifier(hitEl: HTMLElement, overlayImg: HTMLImageElement, bubble: BubbleInfo): void {
  const [x1, y1, x2, y2] = bubble.bbox ?? [0, 0, 0, 0];
  if (x2 <= x1 || y2 <= y1) return;

  const naturalWidth = overlayImg.naturalWidth || 1;
  const naturalHeight = overlayImg.naturalHeight || 1;
  const rect = hitEl.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return;

  // Zoom relative to on-screen size, then clamp: never so large it swallows
  // the viewport, never so small a tiny bubble is pointless to open.
  let scale = MAGNIFIER_ZOOM;
  const maxDim = Math.max(rect.width, rect.height) * scale;
  if (maxDim > MAGNIFIER_MAX_DIMENSION) scale *= MAGNIFIER_MAX_DIMENSION / maxDim;
  const minDim = Math.min(rect.width, rect.height) * scale;
  if (minDim < MAGNIFIER_MIN_DIMENSION) scale *= MAGNIFIER_MIN_DIMENSION / minDim;
  scale = Math.min(scale, MAGNIFIER_MAX_ZOOM);

  const boxWidth = rect.width * scale;
  const boxHeight = rect.height * scale;
  // Scale applied to the *source* image so the bubble's natural-pixel span
  // exactly fills the magnifier box.
  const bgScale = boxWidth / (x2 - x1);

  if (!activeBubbleMagnifier) {
    activeBubbleMagnifier = document.createElement('div');
    activeBubbleMagnifier.className = 'mt-bubble-magnifier';
    document.body.appendChild(activeBubbleMagnifier);
  }
  const magnifier = activeBubbleMagnifier;
  magnifier.style.width = `${boxWidth}px`;
  magnifier.style.height = `${boxHeight}px`;
  magnifier.style.backgroundImage = `url("${overlayImg.src}")`;
  magnifier.style.backgroundSize = `${naturalWidth * bgScale}px ${naturalHeight * bgScale}px`;
  magnifier.style.backgroundPosition = `-${x1 * bgScale}px -${y1 * bgScale}px`;

  // Centered above the bubble; flip below if that would clip off the top of
  // the viewport, and clamp horizontally so it never runs off either edge.
  const margin = 10;
  let left = rect.left + rect.width / 2 - boxWidth / 2;
  left = Math.max(margin, Math.min(left, window.innerWidth - boxWidth - margin));
  let top = rect.top - boxHeight - margin;
  if (top < margin) top = rect.bottom + margin;
  magnifier.style.left = `${left}px`;
  magnifier.style.top = `${top}px`;
  magnifier.style.display = 'block';
}

function hideBubbleMagnifier(): void {
  if (activeBubbleMagnifier) activeBubbleMagnifier.style.display = 'none';
}

// The magnifier is `position: fixed` relative to the bubble's on-screen
// rect at the moment the hover started — if the page (or an inner
// scrollable reader pane) scrolls without the mouse actually leaving the
// hit-target first, its position goes stale relative to whatever's now
// under the cursor. `capture: true` on window also catches scroll on any
// nested scrollable container, not just the window itself. Registered once,
// lazily, the first time any bubble targets are rendered.
let bubbleMagnifierScrollHandlerRegistered = false;
function ensureBubbleMagnifierScrollHandler(): void {
  if (bubbleMagnifierScrollHandlerRegistered) return;
  bubbleMagnifierScrollHandlerRegistered = true;
  window.addEventListener('scroll', hideBubbleMagnifier, { passive: true, capture: true });
}

// Renders one invisible, hoverable hit-target per bubble over the overlay
// image, positioned by percentage of the bubble's bbox (pixel coords in the
// source image) so it tracks the displayed size without recomputing pixel
// offsets on resize. bbox is [x1, y1, x2, y2].
function renderBubbleFixTargets(img: HTMLImageElement, bubbles: BubbleInfo[]): void {
  ensureBubbleMagnifierScrollHandler();

  const parent = img.parentElement;
  if (!parent) return;

  const parentStyle = window.getComputedStyle(parent);
  if (parentStyle.position === 'static') parent.style.position = 'relative';

  const overlayId = getTranslatedOverlayId(img);
  let layer = findFixHitLayer(parent, overlayId);

  if (!bubbles.length) {
    layer?.remove();
    return;
  }

  if (!layer) {
    layer = document.createElement('div');
    layer.className = 'mt-fix-hit-layer';
    layer.setAttribute('data-mt-for', overlayId);
    parent.appendChild(layer);
  }
  layer.style.position = 'absolute';
  layer.style.pointerEvents = 'none';
  layer.style.zIndex = '12';
  layer.innerHTML = '';

  const naturalWidth = img.naturalWidth || 1;
  const naturalHeight = img.naturalHeight || 1;
  const activeLayer = layer;

  bubbles.forEach((bubble, index) => {
    const [x1, y1, x2, y2] = bubble.bbox ?? [0, 0, 0, 0];
    if (x2 <= x1 || y2 <= y1) return;

    const hit = document.createElement('div');
    hit.className = 'mt-fix-hit';
    hit.style.position = 'absolute';
    hit.style.left = `${(x1 / naturalWidth) * 100}%`;
    hit.style.top = `${(y1 / naturalHeight) * 100}%`;
    hit.style.width = `${((x2 - x1) / naturalWidth) * 100}%`;
    hit.style.height = `${((y2 - y1) / naturalHeight) * 100}%`;
    hit.style.pointerEvents = 'auto';
    hit.style.cursor = 'pointer';
    hit.style.borderRadius = '4px';
    hit.style.transition = 'background 0.1s ease, outline 0.1s ease';
    hit.style.boxSizing = 'border-box';
    hit.title = tr('fixHintTooltip');

    hit.onmouseenter = () => {
      hit.style.background = 'rgba(59,130,246,0.18)';
      hit.style.outline = '2px solid rgba(59,130,246,0.7)';
      const overlay = findTranslatedOverlay(parent, overlayId);
      if (overlay) showBubbleMagnifier(hit, overlay, bubble);
    };
    hit.onmouseleave = () => {
      hit.style.background = 'transparent';
      hit.style.outline = 'none';
      hideBubbleMagnifier();
    };
    hit.onclick = (ev) => {
      ev.stopPropagation();
      ev.preventDefault();
      openFixHintPopover(img, index, bubble, hit);
    };

    activeLayer.appendChild(hit);
  });

  syncFixHitLayerLayout(img, layer);
  window.requestAnimationFrame(() => syncFixHitLayerLayout(img, activeLayer));
  window.setTimeout(() => syncFixHitLayerLayout(img, activeLayer), 250);
  window.setTimeout(() => syncFixHitLayerLayout(img, activeLayer), 1000);
}

function styleFixPopoverButton(btn: HTMLButtonElement, primary: boolean): void {
  btn.style.fontSize = '11px';
  btn.style.padding = '4px 10px';
  btn.style.borderRadius = '5px';
  btn.style.border = primary ? 'none' : '1px solid rgba(255,255,255,0.25)';
  btn.style.background = primary ? '#3b82f6' : 'transparent';
  btn.style.color = '#f9fafb';
  btn.style.cursor = 'pointer';
  btn.style.fontFamily = 'inherit';
}

function handleFixPopoverKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') closeFixHintPopover();
}

function handleFixPopoverOutsideClick(ev: MouseEvent): void {
  if (!activeFixPopover) return;
  if (ev.target instanceof Node && activeFixPopover.contains(ev.target)) return;
  closeFixHintPopover();
}

function closeFixHintPopover(): void {
  activeFixPopover?.remove();
  activeFixPopover = null;
  document.removeEventListener('keydown', handleFixPopoverKeydown, true);
  document.removeEventListener('click', handleFixPopoverOutsideClick, true);
}

function openFixHintPopover(img: HTMLImageElement, bubbleIndex: number, bubble: BubbleInfo, anchor: HTMLElement): void {
  closeFixHintPopover();

  const rect = anchor.getBoundingClientRect();
  const popover = document.createElement('div');
  popover.className = 'mt-fix-popover';
  popover.style.position = 'fixed';
  popover.style.zIndex = '2147483647';
  popover.style.background = '#1f2937';
  popover.style.color = '#f9fafb';
  popover.style.border = '1px solid rgba(255,255,255,0.15)';
  popover.style.borderRadius = '8px';
  popover.style.padding = '10px';
  popover.style.width = '260px';
  popover.style.boxShadow = '0 8px 24px rgba(0,0,0,0.35)';
  popover.style.fontFamily = 'Inter, system-ui, sans-serif';
  popover.style.fontSize = '12px';
  popover.style.lineHeight = '1.4';

  const top = Math.min(Math.max(8, window.innerHeight - 220), Math.max(8, rect.top));
  const left = Math.min(Math.max(8, window.innerWidth - 276), Math.max(8, rect.right + 8));
  popover.style.top = `${top}px`;
  popover.style.left = `${left}px`;

  if (bubble.translatedText) {
    const currentLabel = document.createElement('div');
    currentLabel.style.opacity = '0.75';
    currentLabel.style.marginBottom = '6px';
    currentLabel.style.wordBreak = 'break-word';
    currentLabel.textContent = `${tr('fixHintCurrentLabel')} ${bubble.translatedText}`;
    popover.appendChild(currentLabel);
  }

  const textarea = document.createElement('textarea');
  textarea.placeholder = tr('fixHintPlaceholder');
  textarea.rows = 3;
  textarea.style.width = '100%';
  textarea.style.boxSizing = 'border-box';
  textarea.style.resize = 'vertical';
  textarea.style.borderRadius = '6px';
  textarea.style.border = '1px solid rgba(255,255,255,0.2)';
  textarea.style.background = '#111827';
  textarea.style.color = '#f9fafb';
  textarea.style.padding = '6px';
  textarea.style.fontFamily = 'inherit';
  textarea.style.fontSize = '12px';
  popover.appendChild(textarea);

  const statusLine = document.createElement('div');
  statusLine.style.minHeight = '14px';
  statusLine.style.marginTop = '4px';
  statusLine.style.fontSize = '11px';
  popover.appendChild(statusLine);

  const btnRow = document.createElement('div');
  btnRow.style.display = 'flex';
  btnRow.style.justifyContent = 'flex-end';
  btnRow.style.gap = '6px';
  btnRow.style.marginTop = '6px';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = tr('cancel');
  styleFixPopoverButton(cancelBtn, false);
  cancelBtn.onclick = (ev) => { ev.stopPropagation(); closeFixHintPopover(); };

  const applyBtn = document.createElement('button');
  applyBtn.textContent = tr('fixHintApply');
  styleFixPopoverButton(applyBtn, true);
  applyBtn.onclick = (ev) => {
    ev.stopPropagation();
    const instruction = textarea.value.trim();
    if (!instruction) {
      statusLine.style.color = '#fca5a5';
      statusLine.textContent = tr('fixHintEmpty');
      return;
    }
    applyBtn.disabled = true;
    cancelBtn.disabled = true;
    textarea.disabled = true;
    applyBtn.textContent = tr('fixHintApplying');
    applyBtn.style.background = '#1e3a5f';
    applyBtn.style.cursor = 'wait';
    applyBtn.style.opacity = '0.8';
    statusLine.style.color = '#93c5fd';
    statusLine.textContent = tr('fixHintApplying');
    void submitFixHint(img, bubbleIndex, bubble, instruction).then((ok) => {
      if (ok) {
        closeFixHintPopover();
        return;
      }
      applyBtn.disabled = false;
      cancelBtn.disabled = false;
      textarea.disabled = false;
      applyBtn.textContent = tr('fixHintApply');
      styleFixPopoverButton(applyBtn, true);
      statusLine.style.color = '#fca5a5';
      statusLine.textContent = tr('fixHintError');
    });
  };

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(applyBtn);
  popover.appendChild(btnRow);

  document.body.appendChild(popover);
  activeFixPopover = popover;
  textarea.focus();

  document.addEventListener('keydown', handleFixPopoverKeydown, true);
  window.setTimeout(() => document.addEventListener('click', handleFixPopoverOutsideClick, true), 0);
}

async function submitFixHint(img: HTMLImageElement, bubbleIndex: number, bubble: BubbleInfo, instruction: string): Promise<boolean> {
  const info = lastTranslateInfo.get(img);
  if (!info) return false;

  fixHintPending++;
  try {
    const body: TranslateRequest = {
      ...info.body,
      fix_hint: {
        bubble_index: bubbleIndex,
        original_text: bubble.originalText,
        instruction,
      },
    };

    const result = await bgTranslateImageWithBody(info.url, window.location.href, body);
    if (result.error || !result.translated_image) return false;

    const translatedB64 = result.translated_image;
    const dataUrl = `data:image/png;base64,${translatedB64}`;
    const newBubbles = (result.bubbles as BubbleInfo[] | undefined) ?? info.bubbles;

    const settings = await loadSettings();
    const contentKey = contentCacheKey(info.body.image, settings.config.outputLanguage);
    rememberTranslated(info.url, translatedB64);
    rememberTranslatedContent(contentKey, translatedB64);
    await saveTranslatedCacheEntry(info.url, translatedB64);
    await saveTranslatedContentCacheEntry(contentKey, translatedB64);

    lastTranslateInfo.set(img, { bubbles: newBubbles, body: info.body, url: info.url });
    applyTranslatedOverlay(img, dataUrl);
    renderBubbleFixTargets(img, newBubbles);
    return true;
  } finally {
    fixHintPending--;
    if (fixHintPending === 0) void processAutoTranslateQueue();
  }
}

// Re-translates one already-translated scanner page with a general
// (not bubble-targeted) correction note attached. Used by the "Fix
// Selected" batch action — the same instruction is applied to every
// chosen page, e.g. a character name mistranslated the same way across
// several pages.
async function fixOnePage(page: PageEntry, instruction: string): Promise<boolean> {
  const settings = await loadSettings();
  const imgData = await fetchImageData(page.rawUrl, window.location.href);
  if (!imgData) return false;

  const contextMemoryEnabled = settings.config.contextMemoryEnabled ?? false;
  const storyKey = contextMemoryEnabled ? contextMemoryStoryKey(window.location.href) : '';
  const contextMemoryText = contextMemoryEnabled ? await loadContextMemoryText(storyKey) : '';

  const body: TranslateRequest = {
    ...buildTranslateRequest(imgData, settings, undefined, contextMemoryText),
    fix_hint: { instruction },
  };

  const result = await bgTranslateImageWithBody(page.rawUrl, window.location.href, body);
  if (result.error || !result.translated_image) return false;

  const translatedB64 = result.translated_image;
  const translatedDataUrl = `data:image/png;base64,${translatedB64}`;
  imageCache.set(page.rawUrl, translatedDataUrl);
  rememberTranslated(page.rawUrl, translatedB64);
  await saveTranslatedCacheEntry(page.rawUrl, translatedB64);

  if (contextMemoryEnabled && result.memory_note) {
    void appendContextMemoryNote(storyKey, result.memory_note);
  }

  // Update the overlay actually shown on the manga page itself, not just
  // the cache and the scanner's own thumbnail — without this the fix was
  // only visible after a full page reload re-applied the (now-updated)
  // cache from scratch.
  applyTranslatedImageToPage(page.rawUrl, translatedDataUrl, result.bubbles as BubbleInfo[] | undefined, body);

  if (currentShadow) {
    const card = currentShadow.querySelector<HTMLElement>(`.mts-card[data-index="${page.index}"]`);
    const imgEl = card?.querySelector<HTMLImageElement>('.mts-thumb');
    if (imgEl) imgEl.src = translatedDataUrl;
  }

  return true;
}

function openFixSelectedPopover(pages: PageEntry[]): void {
  closeFixHintPopover();

  const popover = document.createElement('div');
  popover.className = 'mt-fix-popover';
  popover.style.position = 'fixed';
  popover.style.zIndex = '2147483647';
  popover.style.background = '#1f2937';
  popover.style.color = '#f9fafb';
  popover.style.border = '1px solid rgba(255,255,255,0.15)';
  popover.style.borderRadius = '8px';
  popover.style.padding = '14px';
  popover.style.width = '320px';
  popover.style.boxShadow = '0 8px 24px rgba(0,0,0,0.35)';
  popover.style.fontFamily = 'Inter, system-ui, sans-serif';
  popover.style.fontSize = '12px';
  popover.style.lineHeight = '1.4';
  popover.style.top = '50%';
  popover.style.left = '50%';
  popover.style.margin = '0';
  popover.style.transform = 'translate(-50%, -50%)';

  const title = document.createElement('div');
  title.style.fontWeight = '700';
  title.style.marginBottom = '8px';
  title.textContent = tr('fixSelectedTitle', { count: pages.length });
  popover.appendChild(title);

  const textarea = document.createElement('textarea');
  textarea.placeholder = tr('fixSelectedPlaceholder');
  textarea.rows = 4;
  textarea.style.width = '100%';
  textarea.style.boxSizing = 'border-box';
  textarea.style.resize = 'vertical';
  textarea.style.borderRadius = '6px';
  textarea.style.border = '1px solid rgba(255,255,255,0.2)';
  textarea.style.background = '#111827';
  textarea.style.color = '#f9fafb';
  textarea.style.padding = '6px';
  textarea.style.fontFamily = 'inherit';
  textarea.style.fontSize = '12px';
  popover.appendChild(textarea);

  const statusLine = document.createElement('div');
  statusLine.style.minHeight = '14px';
  statusLine.style.marginTop = '6px';
  statusLine.style.fontSize = '11px';
  popover.appendChild(statusLine);

  const btnRow = document.createElement('div');
  btnRow.style.display = 'flex';
  btnRow.style.justifyContent = 'flex-end';
  btnRow.style.gap = '6px';
  btnRow.style.marginTop = '8px';

  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = tr('cancel');
  styleFixPopoverButton(cancelBtn, false);
  cancelBtn.onclick = (ev) => { ev.stopPropagation(); closeFixHintPopover(); };

  const applyBtn = document.createElement('button');
  applyBtn.textContent = tr('fixHintApply');
  styleFixPopoverButton(applyBtn, true);
  applyBtn.onclick = (ev) => {
    ev.stopPropagation();
    const instruction = textarea.value.trim();
    if (!instruction) {
      statusLine.style.color = '#fca5a5';
      statusLine.textContent = tr('fixHintEmpty');
      return;
    }
    applyBtn.disabled = true;
    cancelBtn.disabled = true;
    textarea.disabled = true;
    applyBtn.textContent = tr('fixHintApplying');
    applyBtn.style.background = '#1e3a5f';
    applyBtn.style.cursor = 'wait';
    applyBtn.style.opacity = '0.8';
    statusLine.style.color = '#93c5fd';
    statusLine.textContent = `0 / ${pages.length}`;

    void (async () => {
      let success = 0;
      let completed = 0;
      let nextIndex = 0;
      async function worker(): Promise<void> {
        while (nextIndex < pages.length) {
          const page = pages[nextIndex++];
          const ok = await fixOnePage(page, instruction);
          completed++;
          if (ok) success++;
          statusLine.style.color = '#93c5fd';
          statusLine.textContent = `${completed} / ${pages.length}`;
        }
      }
      const settings = await loadSettings();
      const sequentialForContextMemory =
        (settings.config.contextMemoryEnabled ?? false) && (settings.config.contextMemorySequential ?? true);
      const workerCount = sequentialForContextMemory ? 1 : Math.min(AUTO_MAX_CONCURRENT, pages.length);
      await Promise.all(Array.from({ length: workerCount }, () => worker()));
      closeFixHintPopover();
      toast(tr('fixSelectedDone', { success, total: pages.length }));
    })();
  };

  btnRow.appendChild(cancelBtn);
  btnRow.appendChild(applyBtn);
  popover.appendChild(btnRow);

  // The scanner root uses the native Popover API (see createScannerRoot),
  // which renders it in the browser's top layer — always above ANY
  // regularly-positioned element regardless of z-index. Without also
  // joining the top layer here, this popover was created and appended
  // correctly but rendered fully hidden behind the scanner panel: it
  // existed in the DOM (so a DOM-only check reported it as present) but
  // was never actually visible, so clicking "Fix Selected" looked like it
  // did nothing. Top-layer elements stack by show order, so showing this
  // one after the already-open scanner puts it above.
  popover.setAttribute('popover', 'manual');
  document.body.appendChild(popover);
  popover.showPopover();
  activeFixPopover = popover;
  textarea.focus();

  document.addEventListener('keydown', handleFixPopoverKeydown, true);
  window.setTimeout(() => document.addEventListener('click', handleFixPopoverOutsideClick, true), 0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-translate: translated cache persistence
// ─────────────────────────────────────────────────────────────────────────────

let translatedCache = new Map<string, string>(); // rawUrl -> base64 (no prefix), fast within-session lookup
let translatedContentCache = new Map<string, string>(); // contentKey -> base64, persisted, survives URL changes/reloads

// Each entry is a full translated page image (often several MB of base64),
// so both the in-memory maps and their chrome.storage.local backing must
// stay bounded — otherwise a long browsing/auto-translate session (or
// unlimitedStorage accumulating across many days) can balloon to gigabytes
// and crash the tab/browser when loadTranslatedCache() reads it all back in.
//
// Budgeted by actual bytes, not entry count — a fixed entry cap doesn't
// track real size when each entry can be anywhere from under 1MB to several
// MB, so it either evicts way too early or lets storage balloon well past
// what's safe to load back in. Each map gets its own budget (evicting the
// oldest entries once its own total crosses it) so normal use never has to
// wait for the read-time safety net below.
const MAX_CACHE_BYTES_PER_MAP = 80 * 1024 * 1024; // ~160MB combined ceiling across both maps

function mapByteSize(map: Map<string, string>): number {
  let total = 0;
  for (const value of map.values()) total += value.length;
  return total;
}

// Map preserves insertion order, so the oldest entry is always first —
// evicts oldest-first until the map's total value size is back under
// maxBytes, returning the evicted keys so callers can also drop the
// matching chrome.storage.local record.
function evictToByteBudget(map: Map<string, string>, maxBytes: number): string[] {
  const evicted: string[] = [];
  let total = mapByteSize(map);
  while (total > maxBytes && map.size > 0) {
    const oldestKey = map.keys().next().value;
    if (oldestKey === undefined) break;
    const oldestValue = map.get(oldestKey);
    map.delete(oldestKey);
    evicted.push(oldestKey);
    total -= oldestValue?.length ?? 0;
  }
  return evicted;
}

function rememberTranslated(url: string, b64: string): void {
  translatedCache.set(url, b64);
  for (const evictedUrl of evictToByteBudget(translatedCache, MAX_CACHE_BYTES_PER_MAP)) {
    void chrome.storage.local.remove(cacheStorageKey(evictedUrl)).catch(() => {});
  }
}

function rememberTranslatedContent(contentKey: string, b64: string): void {
  translatedContentCache.set(contentKey, b64);
  for (const evictedKey of evictToByteBudget(translatedContentCache, MAX_CACHE_BYTES_PER_MAP)) {
    void chrome.storage.local.remove(`${TRANSLATED_CACHE_PREFIX}${evictedKey}`).catch(() => {});
  }
}

function cacheStorageKey(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
  }
  return `${TRANSLATED_CACHE_PREFIX}${Math.abs(hash).toString(36)}:${url.slice(-80)}`;
}

// Hashes the actual translated image bytes (plus target language) rather
// than its URL, so sites that mint a new blob: URL on every page load
// (e.g. MangaDex's reader) still get cache hits when revisiting a page
// already translated in an earlier session.
function contentCacheKey(base64: string, outputLanguage: string): string {
  let hash = 0;
  for (let i = 0; i < base64.length; i++) {
    hash = ((hash << 5) - hash + base64.charCodeAt(i)) | 0;
  }
  return `content_${base64.length}_${outputLanguage}_${Math.abs(hash).toString(36)}`;
}

// Byte-count-only check (no values pulled into memory) before the eager
// chrome.storage.local.get(null) load below — the write-time budget
// (MAX_CACHE_BYTES_PER_MAP, evicted on every save) keeps normal usage well
// under this, so this is really a last-resort guard for legacy data left
// over from before that budget existed. If it's ever actually hit, skip
// the risky full load rather than risk the same out-of-memory crash
// "Clear translated cache" used to cause — set comfortably above the
// ~160MB combined ceiling the write-time budget already enforces.
const MAX_CACHE_STORAGE_BYTES = 250 * 1024 * 1024;

async function loadTranslatedCache(): Promise<void> {
  try {
    const bytesInUse = await chrome.storage.local.getBytesInUse(null);
    if (bytesInUse > MAX_CACHE_STORAGE_BYTES) {
      const mb = Math.round(bytesInUse / 1024 / 1024);
      console.warn(
        `[MT] Translated cache storage is ${mb}MB, ` +
        'skipping eager load to avoid memory pressure. Use "Clear translated cache" in the popup.',
      );
      toast(tr('cacheTooLargeToLoad', { mb }), true);
      return;
    }

    const result = await chrome.storage.local.get(null);
    const keysToPrune: string[] = [];

    const legacy = result[TRANSLATED_CACHE_KEY] as Record<string, string> | undefined;
    if (legacy) {
      for (const [url, b64] of Object.entries(legacy)) {
        translatedCache.set(url, b64);
      }
      keysToPrune.push(TRANSLATED_CACHE_KEY);
    }

    for (const [key, value] of Object.entries(result)) {
      if (!key.startsWith(TRANSLATED_CACHE_PREFIX)) continue;
      const entry = value as { url?: string; contentKey?: string; b64?: string };
      if (entry?.url && entry?.b64) {
        translatedCache.set(entry.url, entry.b64);
      } else if (entry?.contentKey && entry?.b64) {
        translatedContentCache.set(entry.contentKey, entry.b64);
      }
    }

    // A long testing/browsing history (or storage accumulated before this
    // byte budget existed) can leave far more than MAX_CACHE_BYTES_PER_MAP
    // persisted — trim both the in-memory maps and their storage records
    // back down in one batched cleanup instead of holding it all in memory
    // forever.
    for (const evictedUrl of evictToByteBudget(translatedCache, MAX_CACHE_BYTES_PER_MAP)) {
      keysToPrune.push(cacheStorageKey(evictedUrl));
    }
    for (const evictedKey of evictToByteBudget(translatedContentCache, MAX_CACHE_BYTES_PER_MAP)) {
      keysToPrune.push(`${TRANSLATED_CACHE_PREFIX}${evictedKey}`);
    }
    if (keysToPrune.length > 0) {
      await chrome.storage.local.remove(keysToPrune);
    }
  } catch { /* ignore */ }
}

async function saveTranslatedCacheEntry(url: string, b64: string): Promise<void> {
  try {
    await chrome.storage.local.set({ [cacheStorageKey(url)]: { url, b64 } });
  } catch { /* ignore */ }
}

async function saveTranslatedContentCacheEntry(contentKey: string, b64: string): Promise<void> {
  try {
    await chrome.storage.local.set({ [`${TRANSLATED_CACHE_PREFIX}${contentKey}`]: { contentKey, b64 } });
  } catch { /* ignore */ }
}

async function clearTranslatedCache(): Promise<void> {
  translatedCache = new Map();
  translatedContentCache = new Map();
  try {
    // Deliberately avoid chrome.storage.local.get(null) here — after heavy
    // use the cache can hold hundreds of MB to gigabytes of base64 image
    // data, and pulling it all into memory just to find which keys to
    // delete is itself enough to exhaust memory and crash the tab/browser
    // (this is what "Clear cache" used to do). Settings live under a
    // single small key, so read only that, hard-clear everything else via
    // the storage area's native bulk clear, then restore it.
    const settingsResult = await chrome.storage.local.get(STORAGE_KEY);
    await chrome.storage.local.clear();
    if (settingsResult[STORAGE_KEY] !== undefined) {
      await chrome.storage.local.set({ [STORAGE_KEY]: settingsResult[STORAGE_KEY] });
    }
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Context memory: per-story rolling MEMORY NOTE summaries ("trí nhớ context")
// ─────────────────────────────────────────────────────────────────────────────

const CONTEXT_MEMORY_PREFIX = 'mt_context_memory:';
const CONTEXT_MEMORY_INDEX_KEY = 'mt_context_memory_index';
// Rolling summaries kept per story, and distinct stories kept overall —
// both small (short sentences / short key list), so no unbounded growth risk.
const MAX_CONTEXT_MEMORY_PAGES = 10;
const MAX_CONTEXT_MEMORY_STORIES = 20;

interface ContextMemoryEntry {
  pages: string[];
}

// Groups pages of the same chapter/story together by stripping the trailing
// numeric page-number path segment (and query string) from the URL — good
// enough for a single reading session without needing full chapter-URL
// pattern detection (that lives in background/index.ts for chapter collection).
function contextMemoryStoryKey(pageUrl: string): string {
  try {
    const u = new URL(pageUrl);
    const path = u.pathname.replace(/\/(\d+)\/?$/, '/');
    return `${u.origin}${path}`;
  } catch {
    return pageUrl;
  }
}

function contextMemoryStorageKey(storyKey: string): string {
  let hash = 0;
  for (let i = 0; i < storyKey.length; i++) {
    hash = ((hash << 5) - hash + storyKey.charCodeAt(i)) | 0;
  }
  return `${CONTEXT_MEMORY_PREFIX}${Math.abs(hash).toString(36)}`;
}

async function loadContextMemoryText(storyKey: string): Promise<string> {
  try {
    const key = contextMemoryStorageKey(storyKey);
    const result = await chrome.storage.local.get(key);
    const entry = result[key] as ContextMemoryEntry | undefined;
    if (!entry?.pages?.length) return '';
    return entry.pages.map((s, i) => `Page ${i + 1}: ${s}`).join('\n');
  } catch {
    return '';
  }
}

// Bumps storyKey's storage key to most-recently-used in a small bounded
// index, evicting the least-recently-used story's memory once over the cap.
// Deliberately never reads chrome.storage.local.get(null) — that pulls the
// (potentially huge) translated-image cache into memory too. See
// clearTranslatedCache() above for why that's a real crash risk.
async function touchContextMemoryIndex(storageKey: string): Promise<void> {
  try {
    const result = await chrome.storage.local.get(CONTEXT_MEMORY_INDEX_KEY);
    let index = (result[CONTEXT_MEMORY_INDEX_KEY] as string[] | undefined) ?? [];
    index = index.filter((k) => k !== storageKey);
    index.push(storageKey);
    const toRemove: string[] = [];
    while (index.length > MAX_CONTEXT_MEMORY_STORIES) {
      const evicted = index.shift();
      if (evicted) toRemove.push(evicted);
    }
    await chrome.storage.local.set({ [CONTEXT_MEMORY_INDEX_KEY]: index });
    if (toRemove.length) await chrome.storage.local.remove(toRemove);
  } catch { /* ignore */ }
}

async function appendContextMemoryNote(storyKey: string, note: string): Promise<void> {
  const trimmed = note.trim();
  if (!trimmed) return;
  try {
    const key = contextMemoryStorageKey(storyKey);
    const result = await chrome.storage.local.get(key);
    const entry = result[key] as ContextMemoryEntry | undefined;
    const pages = [...(entry?.pages ?? []), trimmed];
    while (pages.length > MAX_CONTEXT_MEMORY_PAGES) pages.shift();
    await chrome.storage.local.set({ [key]: { pages } as ContextMemoryEntry });
    await touchContextMemoryIndex(key);
  } catch { /* ignore */ }
}

// ─────────────────────────────────────────────────────────────────────────────
// Auto-translate: floating UI
// ─────────────────────────────────────────────────────────────────────────────

let autoTranslateRoot: HTMLElement | null = null;

function injectAutoTranslateUI(): void {
  if (autoTranslateRoot) return;
  autoTranslateRoot = document.createElement('div');
  autoTranslateRoot.id = 'mt-auto-root';
  autoTranslateRoot.innerHTML = `
    <div class="mt-auto-indicator">
      <div class="mt-auto-dot"></div>
      <span class="mt-auto-label">${tr('autoMt')}</span>
      <span class="mt-auto-count" id="mt-auto-count">0</span>
      <button class="mt-auto-stop" id="mt-auto-stop">${tr('stop')}</button>
    </div>
  `;
  document.body.appendChild(autoTranslateRoot);

  const stopBtn = document.getElementById('mt-auto-stop');
  stopBtn?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    stopAutoTranslate();
  }, true);

  const style = document.createElement('style');
  style.id = 'mt-auto-style';
  style.textContent = `
    #mt-auto-root {
      position: fixed; bottom: 24px; right: 24px; z-index: 2147483646;
      font-family: Inter, system-ui, sans-serif;
      pointer-events: auto;
    }
    .mt-auto-indicator {
      display: flex; align-items: center; gap: 8px;
      background: rgba(6,10,24,0.96); border: 1px solid rgba(59,130,246,0.25);
      border-radius: 99px; padding: 8px 14px;
      box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      color: #dde6f5; font-size: 12px; font-weight: 700;
    }
    .mt-auto-dot {
      width: 8px; height: 8px; border-radius: 50%;
      background: #22c55e; animation: mt-pulse 1.5s ease-in-out infinite;
    }
    .mt-auto-indicator.stopped .mt-auto-dot { background: #6b7fa8; animation: none; }
    .mt-auto-indicator.stopped { border-color: rgba(60,80,160,0.15); }
    @keyframes mt-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.8); }
    }
    .mt-auto-label { color: #60a5fa; }
    .mt-auto-count { color: #4ade80; min-width: 24px; }
    .mt-auto-stop {
      background: rgba(220,38,38,0.15); color: #f87171;
      border: 1px solid rgba(220,38,38,0.3);
      border-radius: 99px; padding: 2px 10px;
      font-size: 11px; font-weight: 700; cursor: pointer;
      font-family: Inter, system-ui, sans-serif;
      pointer-events: auto;
    }
    .mt-auto-stop:hover { background: rgba(220,38,38,0.25); }
    .mt-badge {
      position: absolute; top: 4px; right: 4px;
      background: rgba(34,197,94,0.85); color: white;
      font-size: 9px; font-weight: 900; padding: 1px 5px;
      border-radius: 4px; pointer-events: none; z-index: 10;
      font-family: Inter, system-ui, sans-serif;
    }
    .mt-progress-badge {
      position: absolute; top: 4px; right: 4px;
      background: rgba(59,130,246,0.9); color: white;
      font-size: 9px; font-weight: 900; padding: 1px 5px;
      border-radius: 4px; pointer-events: none; z-index: 10;
      font-family: Inter, system-ui, sans-serif;
      animation: mt-progress-pulse 1.2s ease-in-out infinite;
    }
    @keyframes mt-progress-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.45; }
    }
    .mt-page-overlay {
      display: block !important;
      max-width: none !important;
      opacity: 1 !important;
    }
    .mt-bubble-magnifier {
      position: fixed;
      display: none;
      background-repeat: no-repeat;
      background-color: #fff;
      border: 2px solid rgba(59,130,246,0.85);
      border-radius: 6px;
      box-shadow: 0 8px 24px rgba(0,0,0,0.5);
      pointer-events: none;
      z-index: 2147483647;
    }
  `;
  document.head.appendChild(style);
}

function removeAutoTranslateUI(): void {
  autoTranslateRoot?.remove();
  autoTranslateRoot = null;
  document.getElementById('mt-auto-style')?.remove();
}

function updateAutoTranslateIndicator(state: 'active' | 'stopped'): void {
  const indicator = document.querySelector('.mt-auto-indicator');
  if (!indicator) return;
  if (state === 'stopped') indicator.classList.add('stopped');
  else indicator.classList.remove('stopped');

  const label = indicator.querySelector('.mt-auto-label');
  if (label) label.textContent = state === 'stopped' ? tr('autoMtDone') : tr('autoMt');
}

function updateAutoTranslateCounter(): void {
  const countEl = document.getElementById('mt-auto-count');
  if (countEl) countEl.textContent = String(translatedCache.size);
}

// ─────────────────────────────────────────────────────────────────────────────
// Background helpers (bypass CORS)
// ─────────────────────────────────────────────────────────────────────────────

function bgTranslateImageWithBody(imageUrl: string, pageUrl: string, body: TranslateRequest): Promise<{ translated_image?: string; bubbles?: unknown[]; processing_time_seconds?: number; ocr_texts?: string[]; memory_note?: string; error?: string }> {
  return new Promise((resolve) => {
    const tid = setTimeout(() => resolve({ error: 'Backend timeout after 5 minutes' }), 300_000);
    chrome.runtime.sendMessage({ type: 'TRANSLATE_IMAGE_WITH_BODY', imageUrl, pageUrl, body }, (resp: unknown) => {
      clearTimeout(tid);
      const lastError = chrome.runtime.lastError;
      if (lastError) {
        resolve({ error: `extension error: ${lastError.message}` });
        return;
      }
      resolve((resp as { translated_image?: string; bubbles?: unknown[]; processing_time_seconds?: number; ocr_texts?: string[]; memory_note?: string; error?: string }) ?? { error: 'no response' });
    });
  });
}

function bgSuggestInstructions(
  images: string[],
  outputLanguage: string,
  settings: AppSettings,
  enableWebSearch?: boolean,
  storyTitle?: string,
): Promise<{ suggestion?: string; error?: string }> {
  return new Promise((resolve) => {
    const tid = setTimeout(() => resolve({ error: 'Backend timeout after 2 minutes' }), 120_000);
    const rotation = buildProviderRotation(settings);
    chrome.runtime.sendMessage(
      {
        type: 'SUGGEST_INSTRUCTIONS',
        body: {
          images,
          output_language: outputLanguage,
          provider: rotation.provider,
          base_url: rotation.base_url,
          model_name: rotation.model_name,
          api_key: rotation.api_key,
          temperature: settings.config.temperature,
          top_p: settings.config.topP,
          top_k: settings.config.topK,
          reasoning_effort: settings.config.reasoningEffort || undefined,
          api_key_weight: rotation.api_key_weight,
          backup_api_keys: rotation.backup_api_keys,
          backup_api_key_weights: rotation.backup_api_key_weights,
          fallback_providers: rotation.fallback_providers,
          rotation_strategy: settings.config.rotationStrategy,
          cooldown_seconds: settings.config.cooldownSeconds,
          enable_web_search: enableWebSearch ?? false,
          story_title: storyTitle,
        },
      },
      (resp: unknown) => {
        clearTimeout(tid);
        const lastError = chrome.runtime.lastError;
        if (lastError) {
          resolve({ error: `extension error: ${lastError.message}` });
          return;
        }
        resolve((resp as { suggestion?: string; error?: string }) ?? { error: 'no response' });
      },
    );
  });
}

async function appendSpecialInstructions(suggestion: string): Promise<void> {
  const result = await chrome.storage.local.get(STORAGE_KEY);
  const stored = normalizeSettings(result[STORAGE_KEY] as Partial<AppSettings> | undefined);
  const existing = stored.config.specialInstructions?.trim();
  stored.config.specialInstructions = existing ? `${existing}\n\n${suggestion}` : suggestion;
  await chrome.storage.local.set({ [STORAGE_KEY]: stored });
}

/** Shared by the Scanner's "Suggest Notes" button and the popup's own
 * suggest button (which asks this tab's content script for whatever
 * sample images are already loaded, since the popup itself has no image
 * data of its own). */
async function runSuggestInstructions(
  images: string[],
  enableWebSearch?: boolean,
  storyTitle?: string,
): Promise<{ ok: boolean; error?: string }> {
  const canSearchWithoutImages = Boolean(enableWebSearch && storyTitle?.trim());
  if (images.length === 0 && !canSearchWithoutImages) {
    const error = tr('suggestNoImagesReady');
    toast(error, true);
    return { ok: false, error };
  }

  const settings = await loadSettings();
  if (settings.extensionEnabled === false) {
    const error = tr('extensionDisabled');
    toast(error, true);
    return { ok: false, error };
  }

  const result = await bgSuggestInstructions(images, settings.config.outputLanguage, settings, enableWebSearch, storyTitle);
  if (result.error) {
    toast(result.error, true);
    return { ok: false, error: result.error };
  }
  if (result.suggestion) {
    await appendSpecialInstructions(result.suggestion);
    toast(tr('suggestionSaved'), false);
    return { ok: true };
  }
  return { ok: false, error: 'no suggestion returned' };
}

// ─────────────────────────────────────────────────────────────────────────────
// Scanner entry
// ─────────────────────────────────────────────────────────────────────────────

async function openScanner(): Promise<void> {
  await refreshUiLanguage();
  closeScanner(false);

  scannerPausedAutoTranslate = autoTranslateActive;
  if (scannerPausedAutoTranslate) {
    stopAutoTranslate(true);
  }

  const pages = collectAllImages();
  if (pages.length === 0) {
    if (scannerPausedAutoTranslate) {
      scannerPausedAutoTranslate = false;
      void startAutoTranslate();
    }
    toast(tr('noMangaImagesPage'), true);
    return;
  }

  seenUrls = new Set(pages.map((p) => p.rawUrl));
  imageCache = new Map();
  currentPages = pages;
  totalChapterPages = pages.length;

  // Rehydrate from translated cache
  await loadTranslatedCache();
  for (const [url, b64] of translatedCache) {
    if (!imageCache.has(url)) {
      imageCache.set(url, `data:image/png;base64,${b64}`);
    }
  }

  const container = createScannerRoot();
  currentShadow = container.attachShadow({ mode: 'closed' });

  currentShadow.innerHTML = buildScannerHTML();
  injectStyles(currentShadow);
  bindScanner(currentShadow);
  mountScannerRoot(container);

  void loadThumbnailsInBackground();
}

// ─────────────────────────────────────────────────────────────────────────────
// Background fetch
// ─────────────────────────────────────────────────────────────────────────────

function bgFetchImage(url: string, pageUrl: string): Promise<string> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(url), 5000);
    chrome.runtime.sendMessage(
      { type: 'FETCH_IMAGE', url, pageUrl },
      (response: unknown) => {
        clearTimeout(timeout);
        const resp = response as { base64?: string; error?: string } | null;
        if (resp?.base64) resolve(`data:image/jpeg;base64,${resp.base64}`);
        else resolve(url);
      },
    );
  });
}

const THUMBNAIL_CONCURRENT = 8;

async function loadThumbnailsInBackground(): Promise<void> {
  if (!currentShadow) return;
  const pageUrl = window.location.href;
  const pages = currentPages;

  async function loadOne(page: PageEntry): Promise<void> {
    if (!currentShadow) return;
    if (imageCache.has(page.rawUrl)) return;
    const card = currentShadow.querySelector<HTMLElement>(`.mts-card[data-index="${page.index}"]`);
    if (!card) return;
    const thumb = await bgFetchImage(page.rawUrl, pageUrl);
    imageCache.set(page.rawUrl, thumb);
    const img = card.querySelector<HTMLImageElement>('.mts-thumb');
    if (img && !card.classList.contains('selected')) {
      img.src = thumb;
    }
  }

  // Lightweight image fetches (not LLM calls) — safe to run with higher
  // concurrency than translation work.
  let nextIndex = 0;
  async function worker(): Promise<void> {
    while (nextIndex < pages.length) {
      if (!currentShadow) return;
      const page = pages[nextIndex++];
      await loadOne(page);
    }
  }
  const workerCount = Math.min(THUMBNAIL_CONCURRENT, pages.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
}

// ─────────────────────────────────────────────────────────────────────────────
// Image collection
// ─────────────────────────────────────────────────────────────────────────────

function resolveLazySrc(img: HTMLImageElement): string | null {
  // Reuse the URL Auto-translate already resolved and cached under for this
  // element (data-mt-raw), same as resolveMangaUrl does — otherwise a page
  // whose lazy-load attribute got swapped/removed after it finished loading
  // resolves to a DIFFERENT URL here than the one it was translated and
  // cached under, so the scanner's translatedCache lookup misses and the
  // "MT" badge never shows even though the page really is translated.
  const existingRaw = img.getAttribute('data-mt-raw');
  if (existingRaw && !existingRaw.startsWith('data:')) return existingRaw;
  return resolveLazyAttributeSrc(img) ?? (isUsableImageUrl(img.currentSrc || img.src) ? (img.currentSrc || img.src) : null);
}

function collectAllImages(): PageEntry[] {
  const pages: PageEntry[] = [];

  const imgs = document.querySelectorAll<HTMLImageElement>('img');
  for (const img of imgs) {
    const thumb = resolveLazySrc(img);
    if (!thumb) continue;
    if (thumb.startsWith('data:') || thumb.startsWith('blob:')) continue;

    const w = img.naturalWidth || (img.getAttribute('width') ? Number(img.getAttribute('width')) : 0);
    const h = img.naturalHeight || (img.getAttribute('height') ? Number(img.getAttribute('height')) : 0);
    const renderedW = img.getBoundingClientRect().width;
    if (w > 0 && h > 0 && (w < 120 || h < 80)) continue;
    if (w === 0 && h === 0 && renderedW > 0 && renderedW < 120) continue;

    img.setAttribute('data-mt-raw', thumb);
    pages.push({ index: pages.length, thumb, rawUrl: thumb, fetched: true });
  }

  const bgElements = document.querySelectorAll<HTMLElement>('[style*="background-image"]');
  for (const el of bgElements) {
    const style = el.getAttribute('style') ?? '';
    const match = style.match(/url\(["']?([^"')]+)["']?\)/);
    if (!match) continue;
    const thumb = match[1];
    if (!thumb || thumb === 'none' || thumb.startsWith('data:') || thumb.startsWith('blob:')) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < 120 || rect.height < 80) continue;
    pages.push({ index: pages.length, thumb, rawUrl: thumb, fetched: true });
  }

  return pages;
}

// ─────────────────────────────────────────────────────────────────────────────
// HTML builder
// ─────────────────────────────────────────────────────────────────────────────

function renderCard(p: PageEntry): string {
  const src = imageCache.get(p.rawUrl) ?? p.thumb;
  const wasTranslated = translatedCache.has(p.rawUrl);
  return `
    <button class="mts-card${p.fetched ? '' : ' fetched-late'}${wasTranslated ? ' translated-cached' : ''}" data-index="${p.index}" type="button">
      <img class="mts-thumb" src="${src}" alt="${tr('pageAlt', { page: p.index + 1 })}" loading="lazy" />
      <div class="mts-card-num">${p.index + 1}</div>
      <div class="mts-check">&#x2713;</div>
      <div class="mts-card-status"></div>
      <div class="mts-zoom-btn" data-zoom-index="${p.index}" title="${tr('zoomTooltip')}">&#x1F50D;</div>
      ${wasTranslated ? '<div class="mts-badge">MT</div>' : ''}
    </button>
  `;
}

function buildScannerHTML(): string {
  const cards = currentPages.map(renderCard).join('');

  const totalLabel = totalChapterPages > 0 ? ` / ${totalChapterPages}` : '';

  return `
    <div class="mts-backdrop"></div>
    <div class="mts-box">
      <div class="mts-box-header">
        <div class="mts-title">MangaTranslator</div>
        <div class="mts-header-row">
          <span class="mts-found-count" id="mts-found-count">${seenUrls.size}${totalLabel} ${tr('pagesLabel')}</span>
          <div class="mts-header-actions">
            <button class="mts-btn-toolbar" data-action="back-to-popup">&#x2190; ${tr('btnBackToTranslate')}</button>
            <button class="mts-btn-toolbar" data-action="select-all">${tr('all')}</button>
            <button class="mts-btn-toolbar" data-action="deselect-all">${tr('none')}</button>
            <button class="mts-btn-close" data-action="close" type="button" title="${tr('close')}">&#x2715;</button>
          </div>
        </div>
      </div>
      <div class="mts-auto-bar">
        <div class="mts-auto-info" id="mts-auto-info">${tr('foundImagesOnPage', { count: currentPages.length })}</div>
        <button class="mts-btn-toolbar mts-btn-collect" data-action="auto-collect">${tr('autoCollect')}</button>
        <button class="mts-btn-toolbar mts-btn-stop" data-action="stop-collect" style="display:none">${tr('stop')}</button>
        <div class="mts-auto-spinner" id="mts-auto-spinner" style="display:none"></div>
      </div>
      <div class="mts-toolbar">
        <span class="mts-count" id="mts-count">0 / ${currentPages.length}</span>
        <button class="mts-btn-toolbar" data-action="cancel" id="mts-cancel-btn" style="display:none">${tr('cancel')}</button>
        <button class="mts-btn-toolbar" data-action="suggest-instructions" disabled title="${tr('suggestInstructionsHint')}">${tr('suggestInstructions')}</button>
        <button class="mts-btn-toolbar" data-action="fix-selected" disabled>${tr('btnFixSelected')}</button>
        <button class="mts-btn-toolbar" data-action="export-all">${tr('btnExportAll')}</button>
        <button class="mts-btn-primary mts-btn-translate" data-action="translate" disabled>${tr('translate')}</button>
      </div>
      <div class="mts-grid">${cards}</div>
    </div>
    <div class="mts-lightbox" id="mts-lightbox" style="display:none">
      <img class="mts-lightbox-img" id="mts-lightbox-img" src="" alt="" />
      <button class="mts-btn-close mts-lightbox-close" data-action="lightbox-close" type="button" title="${tr('close')}">&#x2715;</button>
    </div>
    <div class="mts-hover-preview" id="mts-hover-preview" style="display:none">
      <img class="mts-hover-preview-img" id="mts-hover-preview-img" src="" alt="" />
    </div>
  `;
}

function reRenderGrid(): void {
  if (!currentShadow) return;
  const grid = currentShadow.querySelector<HTMLElement>('.mts-grid');
  const countEl = currentShadow.querySelector<HTMLElement>('#mts-count');
  const foundCountEl = currentShadow.querySelector<HTMLElement>('#mts-found-count');
  const totalLabel = totalChapterPages > 0 ? ` / ${totalChapterPages}` : '';

  if (grid) {
    grid.innerHTML = currentPages.map(renderCard).join('');
  }

  if (countEl) {
    const sel = currentShadow.querySelectorAll<HTMLElement>('.mts-card.selected');
    countEl.textContent = `${sel.length} / ${currentPages.length}`;
  }
  if (foundCountEl) {
    foundCountEl.textContent = `${seenUrls.size}${totalLabel} ${tr('pagesLabel')}`;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Event binding
// ─────────────────────────────────────────────────────────────────────────────

function bindScanner(shadow: ShadowRoot): void {
  const selected = new Set<number>();
  const grid = shadow.querySelector<HTMLElement>('.mts-grid')!;
  const countEl = shadow.querySelector<HTMLElement>('#mts-count')!;
  const translateBtn = shadow.querySelector<HTMLButtonElement>('[data-action="translate"]')!;
  const suggestBtn = shadow.querySelector<HTMLButtonElement>('[data-action="suggest-instructions"]')!;
  const fixSelectedBtn = shadow.querySelector<HTMLButtonElement>('[data-action="fix-selected"]')!;
  const cancelBtn = shadow.querySelector<HTMLButtonElement>('#mts-cancel-btn')!;
  const closeBtn = shadow.querySelector<HTMLButtonElement>('[data-action="close"]')!;
  const backdrop = shadow.querySelector<HTMLElement>('.mts-backdrop')!;
  const selectAllBtn = shadow.querySelector<HTMLButtonElement>('[data-action="select-all"]')!;
  const deselectAllBtn = shadow.querySelector<HTMLButtonElement>('[data-action="deselect-all"]')!;
  const autoCollectBtn = shadow.querySelector<HTMLButtonElement>('[data-action="auto-collect"]')!;
  const stopCollectBtn = shadow.querySelector<HTMLButtonElement>('[data-action="stop-collect"]')!;
  const autoInfo = shadow.querySelector<HTMLElement>('#mts-auto-info')!;
  const autoSpinner = shadow.querySelector<HTMLElement>('#mts-auto-spinner')!;
  const lightbox = shadow.querySelector<HTMLElement>('#mts-lightbox')!;
  const lightboxImg = shadow.querySelector<HTMLImageElement>('#mts-lightbox-img')!;
  const lightboxCloseBtn = shadow.querySelector<HTMLButtonElement>('[data-action="lightbox-close"]')!;
  const hoverPreview = shadow.querySelector<HTMLElement>('#mts-hover-preview')!;
  const hoverPreviewImg = shadow.querySelector<HTMLImageElement>('#mts-hover-preview-img')!;

  // Prefer the translated version if this page has one — zooming in is
  // most useful to check the translation actually reads right, not just
  // to re-see the original.
  const zoomSrcFor = (index: number): string | null => {
    const p = currentPages[index];
    if (!p) return null;
    const translatedB64 = translatedCache.get(p.rawUrl);
    return translatedB64
      ? `data:image/png;base64,${translatedB64}`
      : (imageCache.get(p.rawUrl) ?? p.thumb);
  };

  const openLightbox = (index: number) => {
    const src = zoomSrcFor(index);
    if (!src) return;
    hideHoverPreview();
    lightboxImg.src = src;
    lightbox.style.display = 'flex';
  };
  const closeLightbox = () => {
    lightbox.style.display = 'none';
    lightboxImg.src = '';
  };
  lightboxCloseBtn.addEventListener('click', closeLightbox);
  lightbox.addEventListener('click', (e) => { if (e.target === lightbox) closeLightbox(); });

  // Hover the zoom icon to auto-preview without a click; clicking it still
  // opens the full lightbox for a deliberate, pinned-open look.
  const showHoverPreview = (index: number, anchor: HTMLElement) => {
    const src = zoomSrcFor(index);
    if (!src) return;
    hoverPreviewImg.src = src;
    hoverPreview.style.display = 'flex';
    const rect = anchor.getBoundingClientRect();
    const maxWidth = 320;
    const maxHeight = 420;
    let left = rect.left + rect.width / 2 - maxWidth / 2;
    let top = rect.top - maxHeight - 12;
    if (top < 8) top = rect.bottom + 12;
    left = Math.max(8, Math.min(left, window.innerWidth - maxWidth - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - maxHeight - 8));
    hoverPreview.style.left = `${left}px`;
    hoverPreview.style.top = `${top}px`;
  };
  const hideHoverPreview = () => {
    hoverPreview.style.display = 'none';
    hoverPreviewImg.src = '';
  };
  grid.addEventListener('mouseover', (e) => {
    const zoomBtn = (e.target as HTMLElement).closest<HTMLElement>('.mts-zoom-btn');
    if (!zoomBtn) return;
    const related = e.relatedTarget as HTMLElement | null;
    if (related && zoomBtn.contains(related)) return;
    const card = zoomBtn.closest<HTMLElement>('.mts-card');
    if (card) showHoverPreview(Number(zoomBtn.dataset.zoomIndex), card);
  });
  grid.addEventListener('mouseout', (e) => {
    const zoomBtn = (e.target as HTMLElement).closest<HTMLElement>('.mts-zoom-btn');
    if (!zoomBtn) return;
    const related = e.relatedTarget as HTMLElement | null;
    if (related && zoomBtn.contains(related)) return;
    hideHoverPreview();
  });

  const refresh = () => {
    countEl.textContent = `${selected.size} / ${currentPages.length}`;
    translateBtn.disabled = selected.size === 0;
    suggestBtn.disabled = selected.size === 0;
    // Fix Selected only acts on pages that are already translated (it re-
    // translates them with a correction attached) — disable it rather than
    // silently no-op with just a toast when nothing selected qualifies, so
    // it's clear at a glance which pages the button will actually affect.
    fixSelectedBtn.disabled = !Array.from(selected).some((i) => translatedCache.has(currentPages[i]?.rawUrl ?? ''));
  };

  grid.addEventListener('click', (e) => {
    const zoomBtn = (e.target as HTMLElement).closest<HTMLElement>('.mts-zoom-btn');
    if (zoomBtn) {
      openLightbox(Number(zoomBtn.dataset.zoomIndex));
      return;
    }
    const card = (e.target as HTMLElement).closest<HTMLElement>('.mts-card');
    if (!card) return;
    const idx = Number(card.dataset.index);
    if (selected.has(idx)) { selected.delete(idx); card.classList.remove('selected'); }
    else { selected.add(idx); card.classList.add('selected'); }
    refresh();
  });

  selectAllBtn.addEventListener('click', () => {
    currentPages.forEach((p) => selected.add(p.index));
    shadow.querySelectorAll<HTMLElement>('.mts-card').forEach((c) => c.classList.add('selected'));
    refresh();
  });

  deselectAllBtn.addEventListener('click', () => {
    selected.clear();
    shadow.querySelectorAll<HTMLElement>('.mts-card').forEach((c) => c.classList.remove('selected'));
    refresh();
  });

  backdrop.addEventListener('click', () => closeScanner());
  closeBtn.addEventListener('click', () => closeScanner());

  const backToPopupBtn = shadow.querySelector<HTMLButtonElement>('[data-action="back-to-popup"]')!;
  backToPopupBtn.addEventListener('click', () => {
    closeScanner();
    // Best-effort — chrome.action.openPopup() requires a fresh-enough user
    // gesture and can be refused by the browser in some states (e.g.
    // another window focused); there's no visible fallback if it fails
    // since content scripts can't open the popup any other way.
    chrome.runtime.sendMessage({ type: 'OPEN_POPUP' }).catch(() => {});
  });

  autoCollectBtn.addEventListener('click', async () => {
    autoCollectBtn.style.display = 'none';
    stopCollectBtn.style.display = '';
    autoSpinner.style.display = 'block';
    autoInfo.textContent = tr('starting');
    await autoCollect((status) => { autoInfo.textContent = status; reRenderGrid(); });

    autoSpinner.style.display = 'none';
    stopCollectBtn.style.display = 'none';
    autoCollectBtn.style.display = '';

    void loadThumbnailsInBackground();
  });

  stopCollectBtn.addEventListener('click', () => { abortCollect = true; });

  suggestBtn.addEventListener('click', async () => {
    const chosen = Array.from(selected).map((i) => currentPages[i]);
    if (chosen.length === 0) return;

    const images = chosen
      .map((p) => imageCache.get(p.rawUrl))
      .filter((src): src is string => Boolean(src))
      .map(extractBase64FromDataUrl)
      .filter((b64): b64 is string => Boolean(b64))
      .slice(0, SUGGEST_INSTRUCTIONS_MAX_IMAGES);

    suggestBtn.disabled = true;
    const originalLabel = suggestBtn.textContent;
    suggestBtn.textContent = tr('suggesting');

    try {
      await runSuggestInstructions(images);
    } finally {
      suggestBtn.textContent = originalLabel;
      suggestBtn.disabled = selected.size === 0;
    }
  });

  fixSelectedBtn.addEventListener('click', () => {
    // currentPages can be reassigned by a background rescan (auto-collect,
    // lazy-load discovering more pages) between when a card was selected
    // and this click — filter out any index that's no longer valid instead
    // of letting `.rawUrl` on undefined throw and silently kill the whole
    // handler with no visible feedback.
    const chosen = Array.from(selected)
      .map((i) => currentPages[i])
      .filter((p): p is PageEntry => Boolean(p));
    const translatedChosen = chosen.filter((p) => translatedCache.has(p.rawUrl));
    if (translatedChosen.length === 0) {
      toast(tr('fixSelectedNoneTranslated'), true);
      return;
    }
    openFixSelectedPopover(translatedChosen);
  });

  const exportAllBtn = shadow.querySelector<HTMLButtonElement>('[data-action="export-all"]')!;
  exportAllBtn.addEventListener('click', async () => {
    const entries = currentPages
      .filter((p) => translatedCache.has(p.rawUrl))
      .map((p) => ({ url: p.rawUrl, base64: translatedCache.get(p.rawUrl)!, index: p.index }));

    if (entries.length === 0) {
      toast(tr('exportNoneTranslated'), true);
      return;
    }

    exportAllBtn.disabled = true;
    const originalLabel = exportAllBtn.textContent;
    try {
      await exportTranslatedPagesAsZip(entries, (status) => { exportAllBtn.textContent = status; });
      toast(tr('exportDone', { count: entries.length }));
    } finally {
      exportAllBtn.textContent = originalLabel;
      exportAllBtn.disabled = false;
    }
  });

  translateBtn.addEventListener('click', async () => {
    const chosen = Array.from(selected).map((i) => currentPages[i]);
    if (chosen.length === 0) return;

    const settings = await loadSettings();
    if (settings.extensionEnabled === false) {
      toast(tr('extensionDisabled'), true);
      return;
    }

    translateBtn.style.display = 'none';
    selectAllBtn.style.display = 'none';
    deselectAllBtn.style.display = 'none';
    closeBtn.style.display = 'none';
    autoCollectBtn.style.display = 'none';
    stopCollectBtn.style.display = 'none';
    cancelBtn.style.display = '';
    backdrop.style.pointerEvents = 'none';

    abortTranslate = false;
    let success = 0;
    let completed = 0;

    async function runOne(page: PageEntry): Promise<void> {
      const card = shadow.querySelector<HTMLElement>(`.mts-card[data-index="${page.index}"]`);
      const statusEl = card?.querySelector<HTMLElement>('.mts-card-status') ?? null;

      card?.classList.add('translating');
      if (statusEl) { statusEl.className = 'mts-card-status translating'; statusEl.textContent = '…'; }

      const ok = await translateOne(page, statusEl);

      card?.classList.remove('translating');
      if (ok) {
        card?.classList.add('done');
        const wasTranslated = translatedCache.has(page.rawUrl);
        if (!wasTranslated) {
          const imgEl = card?.querySelector<HTMLImageElement>('.mts-thumb');
          if (imgEl) {
            const b64 = imgEl.src.replace(/^data:image\/\w+;base64,/, '');
            rememberTranslated(page.rawUrl, b64);
            await saveTranslatedCacheEntry(page.rawUrl, b64);
          }
        }
        success++;
      } else {
        card?.classList.add('failed');
      }
      completed++;
      translateBtn.textContent = `${completed} / ${chosen.length}`;
    }

    // Bounded-concurrency worker pool — same cap as Auto-translate's queue,
    // so a batch of selected pages translates in parallel instead of one
    // at a time (previously: fully sequential, N pages × 45-85s each).
    let nextIndex = 0;
    async function worker(): Promise<void> {
      while (nextIndex < chosen.length) {
        if (abortTranslate) return;
        const page = chosen[nextIndex++];
        await runOne(page);
      }
    }
    const sequentialForContextMemory =
      (settings.config.contextMemoryEnabled ?? false) && (settings.config.contextMemorySequential ?? true);
    const workerCount = sequentialForContextMemory ? 1 : Math.min(AUTO_MAX_CONCURRENT, chosen.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));

    if (abortTranslate) {
      toast(tr('cancelledTranslated', { success, total: completed }), false);
    } else {
      toast(
        success === chosen.length
          ? tr('allImagesTranslated', { count: success })
          : tr('partialTranslated', { success, total: chosen.length }),
        success === 0,
      );
    }

    setTimeout(closeScanner, 2500);
  });

  cancelBtn.addEventListener('click', () => { abortTranslate = true; });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (lightbox.style.display !== 'none') { closeLightbox(); return; }
      closeScanner();
      return;
    }
    if (e.key === 'Enter' && !translateBtn.disabled) translateBtn.click();
  });

  refresh();
}

// ─────────────────────────────────────────────────────────────────────────────
// Translation
// ─────────────────────────────────────────────────────────────────────────────

async function autoCollect(onProgress: (status: string) => void): Promise<void> {
  abortCollect = false;
  onProgress(tr('scanningPage'));

  const pages = collectAllImages();
  if (pages.length === 0) {
    onProgress(tr('noImagesFoundOnPage'));
    return;
  }

  let added = 0;
  for (const page of pages) {
    if (abortCollect) break;
    if (seenUrls.has(page.rawUrl)) continue;
    seenUrls.add(page.rawUrl);
    currentPages.push({ index: currentPages.length, thumb: page.thumb, rawUrl: page.rawUrl, fetched: true });
    added++;
    if (added % 10 === 0) {
      onProgress(tr('foundImages', { count: seenUrls.size }));
      reRenderGrid();
    }
  }

  totalChapterPages = seenUrls.size;
  onProgress(tr('foundMangaImages', { count: seenUrls.size }));
  reRenderGrid();
}

// Every provider group is equal — no distinguished "primary" — just a flat,
// user-ordered list where each group's own keys can also be independently
// enabled/disabled (e.g. one is rate-limited right now). The backend's wire
// format still wants one (provider, key) pair in the primary slot plus the
// rest as backup_api_keys/fallback_providers, so the first enabled group
// fills that slot and the rest become fallback_providers, in list order.
// A group with zero enabled keys still occupies its position with an empty
// api_key — the backend already rotates past a candidate with a missing
// key to the next one, so this correctly falls through to whichever group
// comes next without any special-casing here.
function buildProviderRotation(settings: AppSettings): {
  provider: string;
  base_url?: string;
  model_name?: string;
  api_key?: string;
  api_key_weight?: number;
  backup_api_keys?: string[];
  backup_api_key_weights?: number[];
  fallback_providers?: { provider: string; model_name?: string; api_keys: string[]; api_key_weights?: number[]; base_url?: string }[];
} {
  const groups = (settings.config.providerGroups ?? []).filter((g) => g.enabled !== false);
  const [first, ...rest] = groups;
  if (!first) return { provider: 'Google' };
  const [primary, ...backups] = first.apiKeys.filter((k) => k.enabled);
  const fallbackProviders = rest.map((g) => {
    const keys = g.apiKeys.filter((k) => k.enabled);
    return {
      provider: g.provider,
      model_name: g.modelName,
      base_url: g.baseUrl,
      api_keys: keys.map((k) => k.key),
      api_key_weights: keys.map((k) => k.weight ?? 1),
    };
  });
  return {
    provider: first.provider,
    base_url: first.baseUrl,
    model_name: first.modelName,
    api_key: primary?.key,
    api_key_weight: primary?.weight ?? 1,
    backup_api_keys: backups.length ? backups.map((k) => k.key) : undefined,
    backup_api_key_weights: backups.length ? backups.map((k) => k.weight ?? 1) : undefined,
    fallback_providers: fallbackProviders.length ? fallbackProviders : undefined,
  };
}

function buildTranslateRequest(
  image: string,
  settings: AppSettings,
  previousContextTexts?: string[][],
  contextMemoryText?: string,
): TranslateRequest {
  const contextMemoryEnabled = settings.config.contextMemoryEnabled ?? false;
  const rotation = buildProviderRotation(settings);
  return {
    image,
    input_language: settings.config.inputLanguage,
    output_language: settings.config.outputLanguage,
    provider: rotation.provider,
    base_url: rotation.base_url,
    model_name: rotation.model_name,
    api_key: rotation.api_key,
    temperature: settings.config.temperature,
    top_p: settings.config.topP,
    top_k: settings.config.topK,
    max_tokens: settings.config.maxTokens,
    translation_mode: settings.config.translationMode,
    ocr_method: settings.config.ocrMethod,
    reasoning_effort: settings.config.reasoningEffort || undefined,
    special_instructions: settings.config.specialInstructions || undefined,
    llm_instructions: settings.config.llmInstructions || undefined,
    font_dir: settings.config.fontDir || undefined,
    max_font_size: settings.config.maxFontSize,
    min_font_size: settings.config.minFontSize,
    supersampling_factor: settings.config.supersamplingFactor,
    send_full_page_context: settings.config.sendFullPageContext,
    image_detail: settings.config.imageDetail,
    outside_text_enabled: settings.config.outsideTextEnabled ?? false,
    previous_context_texts: previousContextTexts?.length ? previousContextTexts : undefined,
    context_memory_enabled: contextMemoryEnabled,
    context_memory: contextMemoryEnabled && contextMemoryText ? contextMemoryText : undefined,
    api_key_weight: rotation.api_key_weight,
    backup_api_keys: rotation.backup_api_keys,
    backup_api_key_weights: rotation.backup_api_key_weights,
    fallback_providers: rotation.fallback_providers,
    rotation_strategy: settings.config.rotationStrategy,
    cooldown_seconds: settings.config.cooldownSeconds,
  };
}

async function translateOne(page: PageEntry, statusEl: HTMLElement | null): Promise<boolean> {
  const settings = await loadSettings();

  // Check cache first
  if (translatedCache.has(page.rawUrl)) {
    const cached = translatedCache.get(page.rawUrl)!;
    const dataUrl = `data:image/png;base64,${cached}`;
    imageCache.set(page.rawUrl, dataUrl);
    applyTranslatedImageToPage(page.rawUrl, dataUrl);
    if (currentShadow) {
      const card = currentShadow.querySelector<HTMLElement>(`.mts-card[data-index="${page.index}"]`);
      const img = card?.querySelector<HTMLImageElement>('.mts-thumb');
      if (img) img.src = dataUrl;
    }
    if (statusEl) { statusEl.textContent = tr('cached'); statusEl.className = 'mts-card-status done'; }
    return true;
  }

  // fetchImageData tries DOM capture first (uses browser's cached/authed image),
  // then background fetch, then direct CORS fetch
  const imgData = await fetchImageData(page.rawUrl, window.location.href);

  if (!imgData) {
    if (statusEl) { statusEl.textContent = tr('loadError'); statusEl.className = 'mts-card-status failed'; }
    return false;
  }

  const backendUrl = settings.backendUrl || DEFAULT_BACKEND_URL;
  // endpoint kept for reference; translation now routes through background
  void backendUrl;

  if (statusEl) { statusEl.textContent = tr('sending'); statusEl.className = 'mts-card-status translating'; }

  const contextMemoryEnabled = settings.config.contextMemoryEnabled ?? false;
  const storyKey = contextMemoryEnabled ? contextMemoryStoryKey(window.location.href) : '';
  const contextMemoryText = contextMemoryEnabled ? await loadContextMemoryText(storyKey) : '';

  const body = buildTranslateRequest(imgData, settings, undefined, contextMemoryText);

  try {
    if (statusEl) statusEl.textContent = tr('translating');
    // Route through background to bypass CORS; pass page URL for correct Referer header
    const result = await bgTranslateImageWithBody(page.rawUrl, window.location.href, body);
    if (result.error) {
      if (statusEl) { statusEl.textContent = result.error; statusEl.className = 'mts-card-status failed'; }
      return false;
    }
    if (!result.translated_image) {
      if (statusEl) { statusEl.textContent = tr('noResult'); statusEl.className = 'mts-card-status failed'; }
      return false;
    }

    if (contextMemoryEnabled && result.memory_note) {
      void appendContextMemoryNote(storyKey, result.memory_note);
    }

    const translatedB64 = result.translated_image;
    const translatedDataUrl = `data:image/png;base64,${translatedB64}`;
    imageCache.set(page.rawUrl, translatedDataUrl);

    rememberTranslated(page.rawUrl, translatedB64);
    await saveTranslatedCacheEntry(page.rawUrl, translatedB64);
    applyTranslatedImageToPage(page.rawUrl, translatedDataUrl, result.bubbles as BubbleInfo[] | undefined, body);

    if (currentShadow) {
      const card = currentShadow.querySelector<HTMLElement>(`.mts-card[data-index="${page.index}"]`);
      const img = card?.querySelector<HTMLImageElement>('.mts-thumb');
      if (img) img.src = translatedDataUrl;
    }

    const bubbles = result.bubbles?.length ?? 0;
    const time = result.processing_time_seconds?.toFixed(1) ?? '?';
    if (statusEl) {
      statusEl.textContent = bubbles > 0 ? tr('bubbles', { count: bubbles, time }) : tr('doneWithTime', { time });
      statusEl.className = 'mts-card-status done';
    }
    return true;

  } catch {
    if (statusEl) { statusEl.textContent = tr('networkError'); statusEl.className = 'mts-card-status failed'; }
    return false;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Image capture / fetch
// ─────────────────────────────────────────────────────────────────────────────

function captureImgElement(img: HTMLImageElement): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      // naturalWidth/naturalHeight can already be non-zero (reported from
      // image headers) before the pixel data has fully decoded — drawImage
      // at that point can paint an incomplete/blank frame onto the canvas
      // (the white fillRect below then shows through as a "translated" blank
      // white page, since nothing catches or retries this: canvas.toBlob
      // still succeeds and returns a normal-looking, just-empty PNG). Bail
      // out to fetchImageData's network-fetch fallbacks instead, which pull
      // the actual image bytes directly rather than reading current canvas
      // paint state.
      if (!img.complete) { resolve(null); return; }
      const w = img.naturalWidth || img.width;
      const h = img.naturalHeight || img.height;
      if (w === 0 || h === 0) { resolve(null); return; }
      const canvas = document.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      if (!ctx) { resolve(null); return; }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, w, h);
      ctx.drawImage(img, 0, 0, w, h);
      // toBlob (async, off the synchronous call stack) instead of
      // toDataURL (blocking): same lossless PNG bytes, same base64 result —
      // just doesn't freeze the tab's main thread for the encode, which
      // matters when scanning/auto-translating many pages back to back.
      canvas.toBlob((blob) => {
        if (!blob) { resolve(null); return; }
        const fr = new FileReader();
        fr.onloadend = () => resolve((fr.result as string).replace(/^data:image\/\w+;base64,/, ''));
        fr.onerror = () => resolve(null);
        fr.readAsDataURL(blob);
      }, 'image/png');
    } catch { resolve(null); }
  });
}

async function fetchImageData(url: string, pageUrl: string): Promise<string | null> {
  // 1. Try to capture from DOM — uses browser's cached/authorized image, no fetch needed
  try {
    const domImg = document.querySelector<HTMLImageElement>(
      `img[src="${url}"], img[data-mt-raw="${url}"]`,
    );
    if (domImg) {
      const captured = await captureImgElement(domImg);
      if (captured) return captured;
    }
  } catch { /* fall through */ }

  // 2. Direct fetch from content script — uses page cookies/auth (unlike service worker)
  const captured = await fetchImageWithAuth(url);
  if (captured) return captured;

  // 3. Background fetch as fallback
  try {
    const result = await new Promise<string>((resolve) => {
      const tid = setTimeout(() => resolve(''), 6000);
      chrome.runtime.sendMessage({ type: 'FETCH_IMAGE', url, pageUrl }, (resp: unknown) => {
        clearTimeout(tid);
        const r = resp as { base64?: string } | null;
        resolve(r?.base64 ? `data:image/jpeg;base64,${r.base64}` : '');
      });
    });
    if (result) return result.replace(/^data:image\/\w+;base64,/, '');
  } catch { /* fall through */ }

  return null;
}

/** Fetch image from content script — inherits page cookies/auth unlike service worker. */
async function fetchImageWithAuth(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, {
      credentials: 'include',
      headers: {
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
        'Origin': window.location.origin,
      },
    });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise<string>((resolve) => {
      const fr = new FileReader();
      fr.onloadend = () => resolve((fr.result as string).replace(/^data:image\/\w+;base64,/, ''));
      fr.onerror = () => resolve('');
      fr.readAsDataURL(blob);
    });
  } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Settings
// ─────────────────────────────────────────────────────────────────────────────

async function loadSettings(): Promise<AppSettings> {
  try {
    const result = await chrome.storage.local.get(STORAGE_KEY);
    return normalizeSettings(result[STORAGE_KEY] as Partial<AppSettings> | undefined);
  } catch { return getDefaultSettings(); }
}

function normalizeSettings(raw?: Partial<AppSettings>): AppSettings {
  return {
    ...getDefaultSettings(),
    ...(raw ?? {}),
    uiLanguage: normalizeUiLanguage(raw?.uiLanguage),
    config: {
      ...getDefaultSettings().config,
      ...stripLegacyProviderFields(raw?.config),
      providerGroups: normalizeProviderGroups(raw?.config),
    },
  };
}

function getDefaultSettings(): AppSettings {
  return {
    backendUrl: DEFAULT_BACKEND_URL,
    autoDetect: false,
    showBubbleBboxes: false,
    extensionEnabled: true,
    uiLanguage: 'en',
    config: {
      inputLanguage: 'Auto',
      outputLanguage: 'English',
      providerGroups: [{ provider: 'Google', apiKeys: [], enabled: true }],
      temperature: 0.1,
      topP: 0.95,
      topK: 1,
      translationMode: 'one-step',
      ocrMethod: 'LLM',
      maxFontSize: 16,
      minFontSize: 8,
      supersamplingFactor: 4,
      sendFullPageContext: true,
      imageDetail: 'auto',
      outsideTextEnabled: false,
      preTranslate: false,
      previousContextEnabled: false,
      contextMemoryEnabled: false,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Overlay management
// ─────────────────────────────────────────────────────────────────────────────

function closeScanner(resumeAutoTranslate = true): void {
  abortCollect = true;
  abortTranslate = true;
  const shouldResumeAutoTranslate = resumeAutoTranslate && scannerPausedAutoTranslate;
  scannerPausedAutoTranslate = false;

  const root = document.getElementById(ROOT_ID);
  if (root) root.remove();

  currentShadow = null;
  seenUrls = new Set();
  imageCache = new Map();
  currentPages = [];
  totalChapterPages = 0;

  if (shouldResumeAutoTranslate && !autoTranslateActive) {
    void startAutoTranslate();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Toast
// ─────────────────────────────────────────────────────────────────────────────

function createScannerRoot(): HTMLElement {
  const container = document.createElement('div');
  container.id = ROOT_ID;
  container.setAttribute('popover', 'manual');
  applyScannerRootStyles(container);
  return container;
}

function mountScannerRoot(container: HTMLElement): void {
  applyScannerRootStyles(container);
  (document.documentElement || document.body).appendChild(container);

  const popoverHost = container as HTMLElement & { showPopover?: () => void };
  if (typeof popoverHost.showPopover === 'function') {
    try {
      popoverHost.showPopover();
      applyScannerRootStyles(container);
    } catch {
      // Some pages or browser versions can reject popover; fixed max z-index is the fallback.
    }
  }
}

function applyScannerRootStyles(container: HTMLElement): void {
  container.style.all = 'initial';
  container.style.display = 'block';
  container.style.position = 'fixed';
  container.style.inset = '0';
  container.style.width = '100vw';
  container.style.height = '100vh';
  container.style.maxWidth = 'none';
  container.style.maxHeight = 'none';
  container.style.margin = '0';
  container.style.padding = '0';
  container.style.border = '0';
  container.style.background = 'transparent';
  container.style.overflow = 'hidden';
  container.style.zIndex = '2147483647';
  container.style.isolation = 'isolate';
  container.style.contain = 'layout style paint';
  container.style.pointerEvents = 'auto';
}

function toast(message: string, isError = false): void {
  const existing = document.getElementById('mt-toast');
  if (existing) existing.remove();
  const el = document.createElement('div');
  el.id = 'mt-toast';
  el.className = `mt-toast${isError ? ' error' : ''}`;
  el.textContent = message;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 5000);
}

// ─────────────────────────────────────────────────────────────────────────────
// Styles
// ─────────────────────────────────────────────────────────────────────────────

function injectStyles(shadow: ShadowRoot): void {
  if (shadow.querySelector('#' + STYLE_ID)) return;
  const s = document.createElement('style');
  s.id = STYLE_ID;
  s.textContent = `
    :host, :host([popover]) {
      all: initial !important;
      position: fixed !important;
      inset: 0 !important;
      width: 100vw !important;
      height: 100vh !important;
      z-index: 2147483647 !important;
      display: block !important;
      overflow: hidden !important;
      pointer-events: auto !important;
      isolation: isolate !important;
      contain: layout style paint !important;
    }
    :host::backdrop { background: transparent !important; }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: Inter, system-ui, sans-serif; }
    button, img { all: unset; box-sizing: border-box; }
    button { cursor: pointer; }
    .mts-backdrop {
      position: fixed; inset: 0; z-index: 0;
      background: rgba(2,4,16,0.65); backdrop-filter: blur(4px);
      pointer-events: auto;
    }
    .mts-box {
      position: fixed; top: 50%; left: 50%; transform: translate(-50%,-50%);
      z-index: 1;
      width: min(1100px, calc(100vw - 48px)); max-height: calc(100vh - 48px);
      display: flex; flex-direction: column;
      background: #080b18; border: 1px solid rgba(80,100,200,0.2);
      border-radius: 20px; overflow: hidden; box-shadow: 0 40px 120px rgba(0,0,0,0.65);
    }
    .mts-lightbox {
      position: fixed; inset: 0; z-index: 2;
      background: rgba(2,4,16,0.9);
      align-items: center; justify-content: center; padding: 40px;
      cursor: zoom-out;
    }
    .mts-lightbox-img {
      max-width: 100%; max-height: 100%; object-fit: contain;
      border-radius: 8px; box-shadow: 0 20px 80px rgba(0,0,0,0.7);
      cursor: default;
    }
    .mts-lightbox-close {
      position: absolute; top: 20px; right: 20px;
    }
    .mts-hover-preview {
      position: fixed; z-index: 3; pointer-events: none;
      width: 320px; height: 420px;
      display: flex; align-items: center; justify-content: center;
      border-radius: 10px; overflow: hidden;
      border: 1px solid rgba(80,100,200,0.3); box-shadow: 0 20px 60px rgba(0,0,0,0.6);
      background: #0d1428;
    }
    .mts-hover-preview-img {
      display: block; max-width: 100%; max-height: 100%;
      width: auto; height: auto; object-fit: contain;
    }
    .mts-box-header {
      padding: 16px 18px 12px; background: rgba(10,15,38,0.98);
      border-bottom: 1px solid rgba(80,100,200,0.1); flex-shrink: 0;
    }
    .mts-title {
      font-size: 18px; font-weight: 800;
      background: linear-gradient(135deg, #60a5fa, #818cf8);
      -webkit-background-clip: text; -webkit-text-fill-color: transparent;
      background-clip: text; margin-bottom: 8px;
    }
    .mts-header-row { display: flex; align-items: center; justify-content: space-between; }
    .mts-found-count { font-size: 12px; color: #4a5e8a; }
    .mts-header-actions { display: flex; gap: 6px; align-items: center; }
    .mts-auto-bar {
      display: flex; align-items: center; gap: 10px; padding: 10px 18px;
      background: rgba(14,22,50,0.96);
      border-bottom: 1px solid rgba(80,100,200,0.08); flex-shrink: 0;
    }
    .mts-auto-info {
      font-size: 12px; color: #6b7fa8; flex: 1;
      min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .mts-auto-spinner {
      width: 14px; height: 14px; flex-shrink: 0;
      border: 2px solid rgba(80,120,255,0.3); border-top-color: #60a5fa;
      border-radius: 50%; animation: mt-spin 0.7s linear infinite;
    }
    @keyframes mt-spin { to { transform: rotate(360deg); } }
    .mts-toolbar {
      display: flex; align-items: center; gap: 10px; padding: 10px 18px;
      background: rgba(10,14,32,0.96);
      border-bottom: 1px solid rgba(80,100,200,0.08); flex-shrink: 0;
    }
    .mts-count { font-size: 13px; font-weight: 700; color: #6b7fa8; margin-right: auto; }
    .mts-grid {
      flex: 1; overflow-y: auto; overflow-x: hidden; padding: 14px;
      display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 10px;
      background: #050710;
    }
    .mts-grid::-webkit-scrollbar { width: 5px; }
    .mts-grid::-webkit-scrollbar-track { background: transparent; }
    .mts-grid::-webkit-scrollbar-thumb { background: rgba(80,100,200,0.25); border-radius: 99px; }
    .mts-card {
      position: relative; display: flex; flex-direction: column;
      border: 2px solid rgba(60,80,160,0.12); border-radius: 12px; overflow: hidden;
      cursor: pointer; background: #0a0e1e;
      color: inherit; text-align: left; appearance: none;
      transition: border-color 0.15s, transform 0.1s;
    }
    .mts-card:hover { border-color: rgba(80,120,255,0.45); transform: translateY(-2px); }
    .mts-card.selected { border-color: #4f8ff7; }
    .mts-card.translating { opacity: 0.55; }
    .mts-card.done { border-color: #16a34a; opacity: 0.75; }
    .mts-card.failed { border-color: #dc2626; opacity: 0.65; }
    .mts-card.fetched-late { border-color: rgba(80,180,120,0.35); }
    .mts-card.translated-cached { border-color: rgba(34,197,94,0.4); }
    .mts-thumb { width: 100%; aspect-ratio: 3/4; object-fit: cover; display: block; background: #0d1428; }
    .mts-card-num {
      position: absolute; top: 6px; left: 6px; background: rgba(0,0,0,0.7);
      color: #c0d0f0; font-size: 10px; font-weight: 800; padding: 2px 7px; border-radius: 6px;
    }
    .mts-check {
      display: none; position: absolute; top: 6px; right: 6px;
      width: 22px; height: 22px; border-radius: 999px;
      background: #2563eb; color: white; font-size: 12px; font-weight: 900;
      align-items: center; justify-content: center;
    }
    .mts-card.selected .mts-check { display: flex; }
    .mts-card-status { display: none; font-size: 10px; font-weight: 700; padding: 3px 7px; background: rgba(0,0,0,0.75); }
    .mts-card.translating .mts-card-status { display: block; color: #93c5fd; }
    .mts-card.done .mts-card-status { display: block; color: #86efac; }
    .mts-card.failed .mts-card-status { display: block; color: #fca5a5; }
    .mts-badge {
      position: absolute; bottom: 6px; right: 6px;
      background: rgba(34,197,94,0.85); color: white;
      font-size: 9px; font-weight: 900; padding: 1px 5px; border-radius: 4px;
    }
    .mts-zoom-btn {
      position: absolute; bottom: 6px; left: 6px;
      width: 24px; height: 24px; border-radius: 999px;
      background: rgba(0,0,0,0.65); color: white; font-size: 12px;
      display: flex; align-items: center; justify-content: center;
      opacity: 0.75; transition: opacity 0.15s, background 0.15s;
    }
    .mts-zoom-btn:hover { opacity: 1; background: rgba(37,99,235,0.9); }
    .mts-btn-toolbar, .mts-btn-primary, .mts-btn-close {
      display: inline-flex; align-items: center; justify-content: center;
      border: none; border-radius: 9px; cursor: pointer; font-weight: 700;
      font-family: Inter, system-ui, sans-serif;
    }
    .mts-btn-toolbar {
      background: rgba(14,22,50,0.9); color: #7a90b8; font-size: 12px; padding: 6px 11px;
      border: 1px solid rgba(60,80,160,0.15);
    }
    .mts-btn-toolbar:hover { background: rgba(24,38,80,0.9); color: #a0b8d8; }
    .mts-btn-toolbar:disabled { opacity: 0.35; cursor: not-allowed; }
    .mts-btn-toolbar:disabled:hover { background: rgba(14,22,50,0.9); color: #7a90b8; }
    .mts-btn-collect {
      background: rgba(10,40,80,0.9); color: #60a5fa;
      border: 1px solid rgba(60,120,255,0.2);
    }
    .mts-btn-collect:hover { background: rgba(20,60,140,0.9); color: #93c5fd; }
    .mts-btn-close {
      background: rgba(20,30,60,0.9); color: #5a6e90;
      font-size: 16px; width: 30px; height: 30px; padding: 0; line-height: 1;
      border: 1px solid rgba(60,80,160,0.15);
    }
    .mts-btn-close:hover { background: rgba(40,60,120,0.9); color: #fff; }
    .mts-btn-primary {
      background: linear-gradient(135deg, #3b82f6, #6366f1); color: white;
      font-size: 13px; padding: 9px 16px; box-shadow: 0 4px 14px rgba(59,130,246,0.22);
    }
    .mts-btn-primary:disabled { opacity: 0.4; cursor: not-allowed; box-shadow: none; }
    .mt-toast {
      position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
      z-index: 2147483647; padding: 11px 20px; border-radius: 12px;
      background: rgba(8,12,28,0.97); color: #dde6f5; font: 600 13px Inter, system-ui, sans-serif;
      border: 1px solid rgba(80,110,200,0.22); box-shadow: 0 8px 30px rgba(0,0,0,0.4); white-space: nowrap;
    }
    .mt-toast.error { background: rgba(50,10,10,0.97); border-color: rgba(220,50,50,0.22); color: #fca5a5; }
  `;
  shadow.appendChild(s);
}
