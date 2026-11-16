import { useI18nStore, type Locale } from '@/lib/i18n';

import type { Light, QgisStatus, QgisView } from './geoStatus';

type Shown =QgisStatus['status'] | 'unreadable';

/** The states that stop a QGIS from being used, each explained on the settings page. */
type Fault = Exclude<Shown, 'unconfigured' | 'checking' | 'ready'>;

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
  /** What QGIS is for, on its card in the overview. */
  cardDescription: string;
  /** The overview cards' pills, one word for each light: what is wrong is said on the environment's own page. */
  lights: Record<Light, string>;
  back: string;
  notChosen: string;
  notChosenText: string;
  /** Under the count of algorithms in the QGIS settings' overview. */
  algorithmsLabel: string;
  checkHeading: string;
  checkDescription: string;
  /** The check's steps, in the order GeoEngine takes them: the app, Python, GDAL, a transform, QGIS's core, Processing. */
  steps: readonly [string, string, string, string, string, string];
  stepWorks: string;
  stepWaiting: string;
  stepFailed: string;
  stepNotRun: string;
  verdicts: { ready: string; checking: string; idle: string };
  /** What is wrong, in a line of the interface's language: only the fact; the buttons beside it say what can be done. */
  explain: Record<Fault, string>;
  usesHeading: string;
  uses: Record<'read' | 'lookup' | 'run', { name: string; text: string }>;
  permissions: string;
  installsHeading: string;
  found: (count: number) => string;
  scanning: string;
  rescan: string;
  scanFailed: (reason: string) => string;
  nothingTitle: string;
  nothingText: string;
  download: string;
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
    pageDescription: 'Set up GeoCode\'s geo environment.',
    cardDescription: 'Geodata processing and spatial analysis',
    lights: { ready: 'Ready', checking: 'Checking', idle: 'Not set up', failed: 'Needs attention' },
    back: 'Back to Geo environment',
    notChosen: 'No QGIS chosen yet',
    notChosenText: 'Once one is chosen, the agent can process and analyse data with it.',
    algorithmsLabel: 'Algorithms',
    checkHeading: 'Check',
    checkDescription: 'GeoCode checks what running an algorithm depends on, in order, and stops at the first failure.',
    steps: ['App', 'Python', 'GDAL', 'Transform', 'QGIS core', 'Processing'],
    stepWorks: 'Works',
    stepWaiting: 'Checking',
    stepFailed: 'Failed',
    stepNotRun: 'Not run',
    verdicts: {
      ready: 'Every check passed; the agent can use QGIS.',
      checking: 'Checking this QGIS; a first check can take a minute or two.',
      idle: 'A QGIS is checked once it is chosen.',
    },
    explain: {
      'config-error': 'The settings file machine.json cannot be read; GeoCode leaves it as it is.',
      'platform-unsupported': 'GeoCode cannot run QGIS on this system yet.',
      'path-missing': 'The chosen QGIS is no longer where it was.',
      'not-qgis': 'The chosen location is not a QGIS.',
      ambiguous: 'The chosen folder holds more than one QGIS.',
      'python-missing': 'This QGIS’s own Python cannot be found.',
      'gdal-missing': 'This QGIS’s GDAL cannot be loaded.',
      'proj-broken': 'This QGIS’s projection data is broken, so coordinates cannot be transformed.',
      'core-missing': 'This QGIS’s core library cannot be loaded.',
      'processing-failed': 'This QGIS’s processing framework does not start.',
      'probe-timeout': 'The check did not finish in two minutes.',
      'probe-failed': 'Checking this QGIS failed unexpectedly.',
      unreadable: 'The status of QGIS cannot be read.',
    },
    usesHeading: 'What GeoCode uses it for',
    uses: {
      read: { name: 'Read data', text: 'A dataset’s coordinate system, fields and contents' },
      lookup: { name: 'Look up algorithms', text: 'The algorithms available and how to use them' },
      run: { name: 'Run algorithms', text: 'Spatial processing and analysis' },
    },
    permissions: 'Permissions',
    installsHeading: 'QGIS on this computer',
    found: (count) => `${count} found`,
    scanning: 'Looking…',
    rescan: 'Scan again',
    scanFailed: (reason) => `Could not look for QGIS: ${reason}`,
    nothingTitle: 'No QGIS found on this computer',
    nothingText: 'QGIS is a free and open-source desktop GIS. Once installed it appears here; one installed elsewhere can be chosen by hand.',
    download: 'Download from qgis.org',
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
    pageDescription: '设置 GeoCode 的地理环境。',
    cardDescription: '地理数据处理与空间分析',
    lights: { ready: '就绪', checking: '检查中', idle: '未设置', failed: '需要处理' },
    back: '返回地理环境',
    notChosen: '还没有选择 QGIS',
    notChosenText: '选好一套后，智能体就能用它处理与分析数据。',
    algorithmsLabel: '可用算法',
    checkHeading: '检查',
    checkDescription: 'GeoCode 按运行算法所依赖的顺序逐项检查，有一项不通过就停下。',
    steps: ['找到应用', 'Python', 'GDAL', '坐标变换', 'QGIS 核心', '处理框架'],
    stepWorks: '正常',
    stepWaiting: '检查中',
    stepFailed: '未通过',
    stepNotRun: '未进行',
    verdicts: {
      ready: '全部通过，智能体可以使用 QGIS。',
      checking: '正在检查这套 QGIS，第一次检查可能需要一两分钟。',
      idle: '选择一套 QGIS 后自动检查。',
    },
    explain: {
      'config-error': '设置文件 machine.json 无法读取，GeoCode 不会覆盖它。',
      'platform-unsupported': 'GeoCode 还不支持在这个系统上运行 QGIS。',
      'path-missing': '选中的 QGIS 已不在原来的位置。',
      'not-qgis': '选中的位置不是一套 QGIS。',
      ambiguous: '选中的文件夹里有不止一套 QGIS。',
      'python-missing': '这套 QGIS 里找不到它自带的 Python。',
      'gdal-missing': '这套 QGIS 的 GDAL 无法加载。',
      'proj-broken': '这套 QGIS 的投影数据损坏，坐标变换无法进行。',
      'core-missing': '这套 QGIS 的核心库无法加载。',
      'processing-failed': '这套 QGIS 的处理框架无法启动。',
      'probe-timeout': '检查两分钟仍未完成，没有得到结果。',
      'probe-failed': '检查这套 QGIS 时出了意外的错误。',
      unreadable: '无法识别 QGIS 的状态。',
    },
    usesHeading: 'GeoCode 用它做什么',
    uses: {
      read: { name: '读取地理数据', text: '查看数据的坐标系、字段与内容' },
      lookup: { name: '查阅算法', text: '查找可用的算法和用法' },
      run: { name: '运行算法', text: '执行空间处理与分析' },
    },
    permissions: '权限设置',
    installsHeading: '本机的 QGIS',
    found: (count) => `找到 ${count} 套`,
    scanning: '正在查找…',
    rescan: '重新扫描',
    scanFailed: (reason) => `查找 QGIS 失败：${reason}`,
    nothingTitle: '没有在这台电脑上找到 QGIS',
    nothingText: 'QGIS 是免费、开源的桌面 GIS。装好之后它会出现在这里；装在别处的可以手动选择。',
    download: '从 qgis.org 下载',
    inUse: '正在使用',
    chooseOther: '选择其他位置…',
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
    pageDescription: '設定 GeoCode 的地理環境。',
    cardDescription: '地理資料處理與空間分析',
    lights: { ready: '就緒', checking: '檢查中', idle: '未設定', failed: '需要處理' },
    back: '返回地理環境',
    notChosen: '還沒有選擇 QGIS',
    notChosenText: '選好一套後，智慧體就能用它處理與分析資料。',
    algorithmsLabel: '可用演算法',
    checkHeading: '檢查',
    checkDescription: 'GeoCode 依執行演算法所依賴的順序逐項檢查，有一項不通過就停下。',
    steps: ['找到應用程式', 'Python', 'GDAL', '座標轉換', 'QGIS 核心', '處理框架'],
    stepWorks: '正常',
    stepWaiting: '檢查中',
    stepFailed: '未通過',
    stepNotRun: '未進行',
    verdicts: {
      ready: '全部通過，智慧體可以使用 QGIS。',
      checking: '正在檢查這套 QGIS，第一次檢查可能需要一兩分鐘。',
      idle: '選擇一套 QGIS 後自動檢查。',
    },
    explain: {
      'config-error': '設定檔 machine.json 無法讀取，GeoCode 不會覆蓋它。',
      'platform-unsupported': 'GeoCode 還不支援在這個系統上執行 QGIS。',
      'path-missing': '選中的 QGIS 已不在原來的位置。',
      'not-qgis': '選中的位置不是一套 QGIS。',
      ambiguous: '選中的資料夾裡有不只一套 QGIS。',
      'python-missing': '這套 QGIS 裡找不到它內建的 Python。',
      'gdal-missing': '這套 QGIS 的 GDAL 無法載入。',
      'proj-broken': '這套 QGIS 的投影資料損壞，座標轉換無法進行。',
      'core-missing': '這套 QGIS 的核心函式庫無法載入。',
      'processing-failed': '這套 QGIS 的處理框架無法啟動。',
      'probe-timeout': '檢查兩分鐘仍未完成，沒有得到結果。',
      'probe-failed': '檢查這套 QGIS 時發生意外的錯誤。',
      unreadable: '無法辨識 QGIS 的狀態。',
    },
    usesHeading: 'GeoCode 用它做什麼',
    uses: {
      read: { name: '讀取地理資料', text: '查看資料的座標系統、欄位與內容' },
      lookup: { name: '查閱演算法', text: '查找可用的演算法和用法' },
      run: { name: '執行演算法', text: '進行空間處理與分析' },
    },
    permissions: '權限設定',
    installsHeading: '本機的 QGIS',
    found: (count) => `找到 ${count} 套`,
    scanning: '正在尋找…',
    rescan: '重新掃描',
    scanFailed: (reason) => `尋找 QGIS 失敗：${reason}`,
    nothingTitle: '沒有在這台電腦上找到 QGIS',
    nothingText: 'QGIS 是免費、開源的桌面 GIS。裝好之後它會出現在這裡；裝在別處的可以手動選擇。',
    download: '從 qgis.org 下載',
    inUse: '正在使用',
    chooseOther: '選擇其他位置…',
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

/** The release's name alone: "4.2.3-Belém do Pará" is Belém do Pará; undefined for a version without one. */
export const codenameOf = (version: string) => version.split('-').slice(1).join('-') || undefined;

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
