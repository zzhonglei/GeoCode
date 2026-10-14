import type { I18nKey } from '@/lib/i18n/messages/en';
import type { Locale } from '@/lib/i18n/runtime';
import type { I18nDictionary } from '@/lib/i18n/store';

type Messages = Partial<Record<I18nKey, string>>;

export const GEOCODE_RELEASES_URL = 'https://github.com/zzhonglei/GeoCode-Release';
export const GEOCODE_ISSUES_URL = 'https://github.com/zzhonglei/GeoCode/issues/new';

// Links into the sites of OpenCode and OpenChamber are not offered.
export const withoutUpstreamSite = (url: string): string | undefined =>
  /^https:\/\/(?:[\w-]+\.)*(?:opencode\.ai|openchamber\.dev)(?:\/|$)/.test(url) ? undefined : url;

// Renames the label of each status line and leaves the values, which hold paths and error text, as they are.
export const toGeoCodeReport = (lines: readonly string[]): string[] =>
  lines.map((line) => line.replace(/^[^:]*/, (label) =>
    label.replace(/OpenChamber/g, 'GeoCode').replace(/^(- )?OpenCode/, '$1Kernel').replace(/OpenCode/g, 'kernel')));

// OpenCode's own services keep their names.
const UPSTREAM = /(\b[Aa]n )?(?:OpenChamber|OpenCode(?! (?:Zen|Go|Console|Web Search)\b))/g;

export const toGeoCodeText = (text: string): string =>
  text.replace(UPSTREAM, (_, article?: string) => `${article ? article.replace('n ', ' ') : ''}GeoCode`);

// Where upstream means the kernel as a part, describes a server and a client that are one app here, or offers what the app does not have.
const MESSAGES = {
  en: {
    'settings.view.nav.group.opencode': 'Kernel',
    'commandPalette.item.restartOpenCode': 'Restart kernel',
    'commandPalette.item.showOpenCodeStatus': 'Show kernel status',
    'openCodeStatusDialog.title': 'Kernel Status',
    'openCodeStatusDialog.description': 'Inspect the current kernel status and diagnostics.',
    'chat.sessionError.showStatus': 'Show kernel status',
    'chat.toast.opencodeRestartInterrupted.description': 'The kernel restarted while a response was still running. Send a message to continue.',
    'chat.emptyState.opencodeUnreachable': 'The kernel is not reachable',
    'aboutDialog.openCodeVersionLabel': 'Kernel version {version}',
    'aboutDialog.diagnosticsDescription': 'Includes GeoCode state, kernel health, directories, and projects.',
    'sessions.sidebar.session.action.upstreamErrorWithRef': 'The kernel answered {status} {name} (ref {ref}). Search the kernel log for this ref.',
    'settings.providers.page.auth.apiKeyTooltip': 'Keys are kept on this computer, in the GeoCode data directory.',
    'settings.providers.page.custom.field.apiKey.info': 'Kept on this computer, in the GeoCode data directory. Use {env:VAR_NAME} to read a key from the environment instead.',
    'settings.common.legacyFormat.note': 'This file still uses an older format. The next save rewrites it in the current one.',
    'settings.voice.page.tooltip.localTts': 'On-device synthesis on this computer (Kokoro for English; models for other languages download on first use). No API key needed.',
    'settings.voice.page.tooltip.sttLocal': 'On-device transcription on this computer. Models download automatically; no API key needed.',
    'sessionAuth.error.networkTitle': 'The local service is not responding',
    'sessionAuth.error.networkDescription': 'GeoCode could not verify this window with its local service. Retry, or restart GeoCode.',
    'sourceBoard.empty.noSource': 'This project has no GitHub remote.',
  },
  'zh-CN': {
    'settings.view.nav.group.opencode': '内核',
    'commandPalette.item.restartOpenCode': '重启内核',
    'commandPalette.item.showOpenCodeStatus': '显示内核状态',
    'openCodeStatusDialog.title': '内核状态',
    'openCodeStatusDialog.description': '查看当前内核状态与诊断信息。',
    'chat.sessionError.showStatus': '显示内核状态',
    'chat.toast.opencodeRestartInterrupted.description': '内核在回复仍在生成时重启了。发送一条消息以继续。',
    'chat.emptyState.opencodeUnreachable': '无法连接内核',
    'aboutDialog.openCodeVersionLabel': '内核版本 {version}',
    'aboutDialog.diagnosticsDescription': '包含 GeoCode 状态、内核健康信息、目录和项目。',
    'sessions.sidebar.session.action.upstreamErrorWithRef': '内核返回 {status} {name}（ref {ref}）。请在内核日志中搜索此 ref。',
    'settings.providers.page.auth.apiKeyTooltip': '密钥保存在本机的 GeoCode 数据中。',
    'settings.providers.page.custom.field.apiKey.info': '保存在本机的 GeoCode 数据中。使用 {env:VAR_NAME} 可从环境变量读取密钥。',
    'settings.common.legacyFormat.note': '该文件仍使用旧格式，下次保存会重写为当前格式。',
    'settings.voice.page.tooltip.localTts': '在本机合成语音（英语使用 Kokoro；其他语言的模型在首次使用时下载）。无需 API 密钥。',
    'settings.voice.page.tooltip.sttLocal': '在本机转写。模型自动下载，无需 API 密钥。',
    'sessionAuth.error.networkTitle': '本地服务没有响应',
    'sessionAuth.error.networkDescription': 'GeoCode 无法向本地服务验证此窗口。请重试，或重启 GeoCode。',
    'sourceBoard.empty.noSource': '这个项目没有 GitHub 远程仓库。',
  },
  'zh-TW': {
    'settings.view.nav.group.opencode': '核心',
    'commandPalette.item.restartOpenCode': '重新啟動核心',
    'commandPalette.item.showOpenCodeStatus': '顯示核心狀態',
    'openCodeStatusDialog.title': '核心狀態',
    'openCodeStatusDialog.description': '查看目前核心狀態與診斷資訊。',
    'chat.sessionError.showStatus': '顯示核心狀態',
    'chat.toast.opencodeRestartInterrupted.description': '核心在回覆仍在產生時重新啟動。傳送訊息以繼續。',
    'chat.emptyState.opencodeUnreachable': '無法連線核心',
    'aboutDialog.openCodeVersionLabel': '核心版本 {version}',
    'aboutDialog.diagnosticsDescription': '包含 GeoCode 狀態、核心健康資訊、目錄和專案。',
    'sessions.sidebar.session.action.upstreamErrorWithRef': '核心回應 {status} {name}（ref {ref}）。請在核心日誌中搜尋此 ref。',
    'settings.providers.page.auth.apiKeyTooltip': '金鑰儲存在本機的 GeoCode 資料中。',
    'settings.providers.page.custom.field.apiKey.info': '儲存在本機的 GeoCode 資料中。使用 {env:VAR_NAME} 可從環境變數讀取金鑰。',
    'settings.common.legacyFormat.note': '此檔案仍使用舊格式，下次儲存會改寫為目前格式。',
    'settings.voice.page.tooltip.localTts': '在本機合成語音（英文使用 Kokoro；其他語言的模型在首次使用時下載）。不需要 API 金鑰。',
    'settings.voice.page.tooltip.sttLocal': '在本機轉寫。模型會自動下載，無需 API 金鑰。',
    'sessionAuth.error.networkTitle': '本機服務沒有回應',
    'sessionAuth.error.networkDescription': 'GeoCode 無法向本機服務驗證此視窗。請重試，或重新啟動 GeoCode。',
    'sourceBoard.empty.noSource': '這個專案沒有 GitHub 遠端儲存庫。',
  },
} satisfies Partial<Record<Locale, Messages>>;

const messagesFor = (locale: Locale): Messages =>
  locale === 'en' || locale === 'zh-CN' || locale === 'zh-TW' ? MESSAGES[locale] : {};

const isMessageKey = (key: string, dictionary: Readonly<I18nDictionary>): key is I18nKey => key in dictionary;

export const toGeoCodeDictionary = (locale: Locale, dictionary: Readonly<I18nDictionary>): I18nDictionary => {
  const messages = messagesFor(locale);
  const renamed = { ...dictionary };
  for (const key in dictionary) {
    if (isMessageKey(key, dictionary)) renamed[key] = messages[key] ?? toGeoCodeText(dictionary[key]);
  }
  return renamed;
};
