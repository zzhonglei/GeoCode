import { useI18nStore, type Locale } from '@/lib/i18n';

import type { QgisStatus, QgisView } from './geoStatus';

type Shown =QgisStatus['status'] | 'unreadable';

export type QgisText = {
  status: Record<Shown, string>;
  advice: Partial<Record<Shown, string>>;
  algorithms: (count: number) => string;
  app: string;
  path: string;
  version: string;
  interpreter: string;
  output: string;
  details: string;
  copy: string;
  copied: string;
  manage: string;
  pageTitle: string;
  pageDescription: string;
  qgisDescription: string;
  back: string;
  installsHeading: string;
  rescan: string;
  scanFailed: (reason: string) => string;
  none: string;
  inUse: string;
  oldRelease: string;
  oldReleaseHint: string;
  chooseOther: string;
  pickTitle: string;
  recheck: string;
  chooseFailed: (reason: string) => string;
  recheckFailed: (reason: string) => string;
};

const REINSTALL = {
  en: 'The installation looks incomplete; reinstalling QGIS usually fixes this.',
  'zh-CN': 'QGIS 的安装看起来不完整，重新安装 QGIS 通常可以解决。',
  'zh-TW': 'QGIS 的安裝看起來不完整，重新安裝 QGIS 通常可以解決。',
};

const TEXT: { en: QgisText } & Partial<Record<Locale, QgisText>> = {
  en: {
    status: {
      unconfigured: 'Not set up',
      checking: 'Checking…',
      ready: 'Ready',
      'config-error': 'Settings cannot be read',
      'platform-unsupported': 'Not supported on this system yet',
      'path-missing': 'QGIS is no longer there',
      'not-qgis': 'This app is not QGIS',
      unsupported: 'This QGIS release is not supported',
      'gdal-missing': 'QGIS cannot load GDAL',
      'proj-broken': 'QGIS cannot transform coordinates',
      'core-missing': 'QGIS cannot load its core',
      'processing-failed': 'QGIS Processing does not start',
      'probe-timeout': 'Checking QGIS took too long',
      'probe-failed': 'QGIS failed while being checked',
      unreadable: 'Unrecognized status',
    },
    advice: {
      unconfigured: 'Choose the QGIS on this computer in Settings.',
      'config-error': 'GeoCode cannot read its saved settings. GeoAgent can repair them.',
      'path-missing': 'It may have been moved, renamed or removed. Choose QGIS again.',
      'not-qgis': 'Choose QGIS again.',
      unsupported: 'GeoCode supports the official QGIS 3.44 LTR and 4.x packages.',
      'gdal-missing': REINSTALL.en,
      'proj-broken': REINSTALL.en,
      'core-missing': REINSTALL.en,
      'processing-failed': REINSTALL.en,
      'probe-timeout': 'The computer may be busy. Check again in a moment.',
      'probe-failed': REINSTALL.en,
    },
    algorithms: (count) => `${count} algorithms`,
    app: 'App',
    path: 'Chosen app',
    version: 'Version',
    interpreter: 'Interpreter',
    output: 'Output',
    details: 'Diagnostics',
    copy: 'Copy',
    copied: 'Copied',
    manage: 'Manage in Settings',
    pageTitle: 'Geo environment',
    pageDescription: 'The software on this computer that GeoCode runs geographic tasks with.',
    qgisDescription: 'Spatial analysis with the QGIS Processing algorithms',
    back: 'Back to Geo environment',
    installsHeading: 'Installations',
    rescan: 'Scan again',
    scanFailed: (reason) => `Could not look for QGIS: ${reason}`,
    none: 'No QGIS found. Install it from qgis.org, or choose where it is.',
    inUse: 'In use',
    oldRelease: 'Too old',
    oldReleaseHint: 'GeoCode needs QGIS 3.44 or later',
    chooseOther: 'Other location…',
    pickTitle: 'Choose the QGIS app',
    recheck: 'Check again',
    chooseFailed: (reason) => `Could not use this QGIS: ${reason}`,
    recheckFailed: (reason) => `Could not check QGIS again: ${reason}`,
  },
  'zh-CN': {
    status: {
      unconfigured: '未设置',
      checking: '正在检查…',
      ready: '就绪',
      'config-error': '设置无法读取',
      'platform-unsupported': '暂不支持这个系统',
      'path-missing': '找不到选中的 QGIS',
      'not-qgis': '选中的应用不是 QGIS',
      unsupported: '不支持这个 QGIS 版本',
      'gdal-missing': 'QGIS 无法加载 GDAL',
      'proj-broken': 'QGIS 无法转换坐标',
      'core-missing': 'QGIS 核心无法加载',
      'processing-failed': 'QGIS 的处理框架无法启动',
      'probe-timeout': '检查 QGIS 超时',
      'probe-failed': '检查 QGIS 时出错',
      unreadable: '无法识别的状态',
    },
    advice: {
      unconfigured: '在设置里选择这台电脑上的 QGIS。',
      'config-error': 'GeoCode 保存的设置无法读取，可以让 GeoAgent 修复。',
      'path-missing': '它可能被移动、改名或删除了，请重新选择 QGIS。',
      'not-qgis': '请重新选择 QGIS。',
      unsupported: 'GeoCode 支持 QGIS 官方的 3.44 LTR 与 4.x 安装包。',
      'gdal-missing': REINSTALL['zh-CN'],
      'proj-broken': REINSTALL['zh-CN'],
      'core-missing': REINSTALL['zh-CN'],
      'processing-failed': REINSTALL['zh-CN'],
      'probe-timeout': '电脑可能正忙，稍后可以重新检查。',
      'probe-failed': REINSTALL['zh-CN'],
    },
    algorithms: (count) => `${count} 个算法`,
    app: '应用',
    path: '选中的应用',
    version: '版本',
    interpreter: '解释器',
    output: '输出',
    details: '诊断信息',
    copy: '复制',
    copied: '已复制',
    manage: '在设置中管理',
    pageTitle: '地理环境',
    pageDescription: 'GeoCode 用这台电脑上的这些软件执行地理任务。',
    qgisDescription: '用 QGIS 的处理算法做空间分析',
    back: '返回地理环境',
    installsHeading: '已安装',
    rescan: '重新扫描',
    scanFailed: (reason) => `查找 QGIS 失败：${reason}`,
    none: '没有找到 QGIS。可以从 qgis.org 安装，或者指定它的位置。',
    inUse: '正在使用',
    oldRelease: '版本过旧',
    oldReleaseHint: '需要 QGIS 3.44 或更新的版本',
    chooseOther: '其他位置…',
    pickTitle: '选择 QGIS 应用',
    recheck: '重新检查',
    chooseFailed: (reason) => `无法使用这套 QGIS：${reason}`,
    recheckFailed: (reason) => `无法重新检查 QGIS：${reason}`,
  },
  'zh-TW': {
    status: {
      unconfigured: '未設定',
      checking: '正在檢查…',
      ready: '就緒',
      'config-error': '設定無法讀取',
      'platform-unsupported': '尚不支援這個系統',
      'path-missing': '找不到選取的 QGIS',
      'not-qgis': '選取的應用程式不是 QGIS',
      unsupported: '不支援這個 QGIS 版本',
      'gdal-missing': 'QGIS 無法載入 GDAL',
      'proj-broken': 'QGIS 無法轉換座標',
      'core-missing': 'QGIS 核心無法載入',
      'processing-failed': 'QGIS 的處理框架無法啟動',
      'probe-timeout': '檢查 QGIS 逾時',
      'probe-failed': '檢查 QGIS 時出錯',
      unreadable: '無法辨識的狀態',
    },
    advice: {
      unconfigured: '在設定裡選擇這台電腦上的 QGIS。',
      'config-error': 'GeoCode 儲存的設定無法讀取，可以讓 GeoAgent 修復。',
      'path-missing': '它可能被移動、改名或刪除了，請重新選擇 QGIS。',
      'not-qgis': '請重新選擇 QGIS。',
      unsupported: 'GeoCode 支援 QGIS 官方的 3.44 LTR 與 4.x 安裝檔。',
      'gdal-missing': REINSTALL['zh-TW'],
      'proj-broken': REINSTALL['zh-TW'],
      'core-missing': REINSTALL['zh-TW'],
      'processing-failed': REINSTALL['zh-TW'],
      'probe-timeout': '電腦可能正忙，稍後可以重新檢查。',
      'probe-failed': REINSTALL['zh-TW'],
    },
    algorithms: (count) => `${count} 個演算法`,
    app: '應用程式',
    path: '選取的應用程式',
    version: '版本',
    interpreter: '直譯器',
    output: '輸出',
    details: '診斷資訊',
    copy: '複製',
    copied: '已複製',
    manage: '在設定中管理',
    pageTitle: '地理環境',
    pageDescription: 'GeoCode 用這台電腦上的這些軟體執行地理任務。',
    qgisDescription: '用 QGIS 的處理演算法做空間分析',
    back: '返回地理環境',
    installsHeading: '已安裝',
    rescan: '重新掃描',
    scanFailed: (reason) => `尋找 QGIS 失敗：${reason}`,
    none: '沒有找到 QGIS。可以從 qgis.org 安裝，或者指定它的位置。',
    inUse: '正在使用',
    oldRelease: '版本過舊',
    oldReleaseHint: '需要 QGIS 3.44 或更新的版本',
    chooseOther: '其他位置…',
    pickTitle: '選擇 QGIS 應用程式',
    recheck: '重新檢查',
    chooseFailed: (reason) => `無法使用這套 QGIS：${reason}`,
    recheckFailed: (reason) => `無法重新檢查 QGIS：${reason}`,
  },
};

export const qgisText = (locale: Locale): QgisText => TEXT[locale] ?? TEXT.en;

/** For the settings navigation, whose titles come from a callback rather than a component. */
export const geoEnvironmentTitle = (): string => qgisText(useI18nStore.getState().locale).pageTitle;

/** The release without its name: "4.2.3-Belém do Pará" is 4.2.3. */
export const releaseOf = (version: string) => version.split('-')[0];

/** What a ready QGIS runs with, on one line. */
export const summaryOf = (status: Extract<QgisStatus, { status: 'ready' }>, text: QgisText) =>
  [`QGIS ${releaseOf(status.versions.qgis)}`, `GDAL ${status.versions.gdal}`, `Python ${status.versions.python}`, text.algorithms(status.algorithms)].join(' · ');

/** Everything known about a failure, as shown under Diagnostics and copied. */
export const diagnosticsOf = (status: QgisView, text: QgisText): string => {
  if (status.status === 'unreadable') return JSON.stringify(status.value, null, 2);
  if (!('diagnostics' in status)) return `QGIS: ${text.status[status.status]} (${status.status})`;
  const diagnostics = status.diagnostics;
  return [
    `QGIS: ${text.status[status.status]} (${status.status})`,
    diagnostics.message,
    diagnostics.path ? `${text.path}: ${diagnostics.path}` : null,
    diagnostics.app && diagnostics.app !== diagnostics.path ? `${text.app}: ${diagnostics.app}` : null,
    diagnostics.version ? `${text.version}: ${diagnostics.version}` : null,
    diagnostics.interpreter ? `${text.interpreter}: ${diagnostics.interpreter}` : null,
    diagnostics.output?.trim() ? `${text.output}:\n${diagnostics.output.trim()}` : null,
  ].filter(Boolean).join('\n');
};
