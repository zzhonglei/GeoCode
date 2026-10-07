import { useI18nStore, type Locale } from '@/lib/i18n';

import type { QgisStatus, QgisView } from './geoStatus';

type Shown =QgisStatus['status'] | 'unreadable';

/**
 * The names of the states stay in English whatever the interface language, as in most software's logs. Short, since
 * the indicator's popover shows one after "QGIS" on a single line.
 */
export const QGIS_STATUS = {
  unconfigured: 'Not set up',
  checking: 'Checking…',
  ready: 'Ready',
  'config-error': 'Settings unreadable',
  'platform-unsupported': 'Not on this system yet',
  'path-missing': 'App not found',
  'not-qgis': 'Not a QGIS app',
  ambiguous: 'Several in one folder',
  'python-missing': 'Python not found',
  'gdal-missing': 'Cannot load GDAL',
  'proj-broken': 'PROJ data broken',
  'core-missing': 'Cannot load QGIS core',
  'processing-failed': 'Processing failed',
  'probe-timeout': 'Check timed out',
  'probe-failed': 'Check failed',
  unreadable: 'Unknown status',
} satisfies Record<Shown, string>;

export type QgisText = {
  algorithms: (count: number) => string;
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
  chooseOther: string;
  pickTitle: string;
  /** On Windows, where a QGIS is a folder rather than an app. */
  pickFolderTitle: string;
  recheck: string;
  chooseFailed: (reason: string) => string;
  recheckFailed: (reason: string) => string;
};

const TEXT: { en: QgisText } & Partial<Record<Locale, QgisText>> = {
  en: {
    algorithms: (count) => `${count} algorithms`,
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
    chooseOther: 'Other location…',
    pickTitle: 'Choose the QGIS app',
    pickFolderTitle: 'Choose the QGIS folder',
    recheck: 'Check again',
    chooseFailed: (reason) => `Could not use this QGIS: ${reason}`,
    recheckFailed: (reason) => `Could not check QGIS again: ${reason}`,
  },
  'zh-CN': {
    algorithms: (count) => `${count} 个算法`,
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
    chooseOther: '其他位置…',
    pickTitle: '选择 QGIS 应用',
    pickFolderTitle: '选择 QGIS 所在的文件夹',
    recheck: '重新检查',
    chooseFailed: (reason) => `无法使用这套 QGIS：${reason}`,
    recheckFailed: (reason) => `无法重新检查 QGIS：${reason}`,
  },
  'zh-TW': {
    algorithms: (count) => `${count} 個演算法`,
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
    chooseOther: '其他位置…',
    pickTitle: '選擇 QGIS 應用程式',
    pickFolderTitle: '選擇 QGIS 所在的資料夾',
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

/** Everything known about a failure, as shown under Diagnostics and copied; in English, as the state's name is. */
export const diagnosticsOf = (status: QgisView): string => {
  if (status.status === 'unreadable') return JSON.stringify(status.value, null, 2);
  if (!('diagnostics' in status)) return `QGIS: ${QGIS_STATUS[status.status]} (${status.status})`;
  const diagnostics = status.diagnostics;
  return [
    `QGIS: ${QGIS_STATUS[status.status]} (${status.status})`,
    diagnostics.message,
    diagnostics.file ? `File: ${diagnostics.file}` : null,
    diagnostics.path ? `Chosen path: ${diagnostics.path}` : null,
    diagnostics.app && diagnostics.app !== diagnostics.path ? `App: ${diagnostics.app}` : null,
    diagnostics.version ? `Version: ${diagnostics.version}` : null,
    diagnostics.interpreter ? `Interpreter: ${diagnostics.interpreter}` : null,
    diagnostics.folder && diagnostics.folder !== diagnostics.path ? `Folder: ${diagnostics.folder}` : null,
    diagnostics.choices?.length
      ? `QGIS in it:\n${diagnostics.choices.map((choice) => (choice.version ? `${choice.app} (${choice.version})` : choice.app)).join('\n')}`
      : null,
    diagnostics.environment && Object.keys(diagnostics.environment).length
      ? `Environment:\n${Object.entries(diagnostics.environment).map(([name, value]) => `${name}=${value}`).join('\n')}`
      : null,
    diagnostics.output?.trim() ? `Output:\n${diagnostics.output.trim()}` : null,
  ].filter(Boolean).join('\n');
};
