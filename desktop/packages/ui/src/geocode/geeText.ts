import type { Locale } from '@/lib/i18n';

import type { GeeStatus, GeeView } from './geoStatus';

type Refusal = NonNullable<Extract<GeeStatus, { diagnostics: unknown }>['diagnostics']['refusal']>;

/** As QGIS_STATUS: in English whatever the interface language, and short. A refusal is named by its reason. */
const GEE_STATUS = {
  unconfigured: 'Not set up',
  checking: 'Checking…',
  ready: 'Ready',
  'config-error': 'Settings unreadable',
  'python-missing': 'Python not found',
  'packages-missing': 'Packages missing',
  'packages-broken': 'Packages broken',
  'signed-out': 'Not signed in',
  'project-missing': 'No project',
  unreachable: 'Unreachable',
  'check-timeout': 'Check timed out',
  'check-failed': 'Check failed',
  unreadable: 'Unknown status',
} satisfies Record<Exclude<GeeView['status'], 'rejected'>, string>;

const REFUSED = {
  'credentials-invalid': 'Sign-in expired',
  'project-not-found': 'Project not found',
  'no-permission': 'No access to project',
  'api-disabled': 'API not enabled',
  other: 'Refused',
} satisfies Record<Refusal, string>;

export const geeLabel = (view: GeeView): string =>
  view.status === 'rejected' ? REFUSED[view.diagnostics.refusal ?? 'other'] : GEE_STATUS[view.status];

/** What a ready Earth Engine runs with, on one line. */
export const geeSummaryOf = (status: Extract<GeeStatus, { status: 'ready' }>) =>
  [
    status.project,
    status.versions['earthengine-api'] ? `earthengine-api ${status.versions['earthengine-api']}` : null,
    status.versions.python ? `Python ${status.versions.python}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

/** The failure itself, on a line: what Google said when it answered, GeoEngine's message otherwise. */
export const geeMessageOf = (status: Extract<GeeStatus, { diagnostics: unknown }>) =>
  status.diagnostics.said ?? status.diagnostics.message;

/** Everything known about a failure, as shown under Diagnostics and copied; in English, as the state's name is. */
export const geeDiagnosticsOf = (view: GeeView): string => {
  if (view.status === 'unreadable') return JSON.stringify(view.value, null, 2);
  const heading = `Google Earth Engine: ${geeLabel(view)} (${view.status === 'rejected' ? `rejected, ${view.diagnostics.refusal ?? 'other'}` : view.status})`;
  if (!('diagnostics' in view)) return heading;
  const diagnostics = view.diagnostics;
  return [
    heading,
    diagnostics.message,
    diagnostics.said && diagnostics.said !== diagnostics.message ? `Google said: ${diagnostics.said}` : null,
    diagnostics.file ? `File: ${diagnostics.file}` : null,
    diagnostics.python ? `Python: ${diagnostics.python}` : null,
    diagnostics.project ? `Project: ${diagnostics.project}` : null,
    diagnostics.missing?.length ? `Not installed: ${diagnostics.missing.join(', ')}` : null,
    diagnostics.broken?.length
      ? `Failing to import:\n${diagnostics.broken.map((item) => `${item.package}: ${item.error}`).join('\n')}`
      : null,
    diagnostics.output?.trim() ? `Output:\n${diagnostics.output.trim()}` : null,
    diagnostics.traceback?.trim() ? `Traceback:\n${diagnostics.traceback.trim()}` : null,
  ]
    .filter(Boolean)
    .join('\n');
};

export type GeeText = {
  pythonHeading: string;
  pythonHelp: string;
  noPythons: string;
  missing: (packages: readonly string[]) => string;
  pickPython: string;
  scanFailed: (reason: string) => string;
  chooseFailed: (reason: string) => string;
  accountHeading: string;
  noPython: string;
  notChecked: string;
  signedOut: string;
  checking: string;
  signedIn: string;
  expired: string;
  signIn: string;
  signInAgain: string;
  waiting: string;
  noBrowser: string;
  copyLink: string;
  cancel: string;
  signInFailed: (reason: string) => string;
  denied: string;
  timedOut: string;
  projectHeading: string;
  projectPlaceholder: string;
  projectInvalid: string;
  save: string;
  /** The help under the project, around the link to the Code Editor. */
  projectHelp: readonly [string, string];
  saveFailed: (reason: string) => string;
  recheckFailed: (reason: string) => string;
  marks: { done: string; todo: string; problem: string; busy: string };
};

const PAGE_TEXT: { en: GeeText } & Partial<Record<Locale, GeeText>> = {
  en: {
    pythonHeading: 'Python environment',
    pythonHelp:
      'The Pythons on this computer with earthengine-api installed. For another, use Other location… to choose its folder: a virtual environment, or a project folder with a .venv in it.',
    noPythons: 'No Python with earthengine-api found. Choose one with Other location…, or ask GeoAgent to set one up.',
    missing: (packages) => `Missing ${packages.join(', ')}`,
    pickPython: 'Choose the folder of the Python environment',
    scanFailed: (reason) => `Could not look for Pythons: ${reason}`,
    chooseFailed: (reason) => `Could not use this Python: ${reason}`,
    accountHeading: 'Google account',
    noPython: 'Choose a Python environment first',
    notChecked: 'Not checked yet',
    signedOut: 'No Earth Engine credentials on this computer yet',
    checking: 'Checking…',
    signedIn: 'Signed in',
    expired: 'Sign-in expired',
    signIn: 'Sign in',
    signInAgain: 'Sign in again',
    waiting: 'Finish signing in with your browser',
    noBrowser: 'Browser did not open?',
    copyLink: 'Copy the sign-in link',
    cancel: 'Cancel',
    signInFailed: (reason) => `Sign-in did not finish: ${reason}`,
    denied: 'access was denied',
    timedOut: 'more than 10 minutes passed',
    projectHeading: 'Cloud project',
    projectPlaceholder: 'Project ID, such as my-project-123',
    projectInvalid: 'A project ID has only letters, digits and hyphens',
    save: 'Save',
    projectHelp: ['The ', ' shows your project ID at its top.'],
    saveFailed: (reason) => `Could not save the project: ${reason}`,
    recheckFailed: (reason) => `Could not check Google Earth Engine again: ${reason}`,
    marks: { done: 'Done', todo: 'To do', problem: 'Needs attention', busy: 'Checking' },
  },
  'zh-CN': {
    pythonHeading: 'Python 环境',
    pythonHelp: '列出这台电脑上装了 earthengine-api 的 Python。其他的用「其他位置…」选择它所在的文件夹：虚拟环境，或者含有 .venv 的项目文件夹。',
    noPythons: '没有找到装了 earthengine-api 的 Python。可以用「其他位置…」指定，或者请 GeoAgent 帮你配置。',
    missing: (packages) => `缺少 ${packages.join('、')}`,
    pickPython: '选择 Python 环境所在的文件夹',
    scanFailed: (reason) => `查找 Python 失败：${reason}`,
    chooseFailed: (reason) => `无法使用这个 Python：${reason}`,
    accountHeading: 'Google 账号',
    noPython: '先选择 Python 环境',
    notChecked: '尚未检查',
    signedOut: '这台电脑上还没有 Earth Engine 的登录凭据',
    checking: '正在检查…',
    signedIn: '已登录',
    expired: '登录已失效',
    signIn: '登录',
    signInAgain: '重新登录',
    waiting: '请在浏览器中完成授权',
    noBrowser: '浏览器没有打开？',
    copyLink: '复制授权链接',
    cancel: '取消',
    signInFailed: (reason) => `登录未完成：${reason}`,
    denied: '授权被拒绝',
    timedOut: '已超过 10 分钟',
    projectHeading: 'Cloud 项目',
    projectPlaceholder: '项目 ID，例如 my-project-123',
    projectInvalid: '项目 ID 只含字母、数字和连字符',
    save: '保存',
    projectHelp: ['在 ', ' 顶部可以看到项目 ID。'],
    saveFailed: (reason) => `无法保存项目：${reason}`,
    recheckFailed: (reason) => `无法重新检查 Google Earth Engine：${reason}`,
    marks: { done: '已完成', todo: '未完成', problem: '有问题', busy: '检查中' },
  },
  'zh-TW': {
    pythonHeading: 'Python 環境',
    pythonHelp: '列出這台電腦上裝了 earthengine-api 的 Python。其他的用「其他位置…」選擇它所在的資料夾：虛擬環境，或者含有 .venv 的專案資料夾。',
    noPythons: '沒有找到裝了 earthengine-api 的 Python。可以用「其他位置…」指定，或者請 GeoAgent 幫你設定。',
    missing: (packages) => `缺少 ${packages.join('、')}`,
    pickPython: '選擇 Python 環境所在的資料夾',
    scanFailed: (reason) => `尋找 Python 失敗：${reason}`,
    chooseFailed: (reason) => `無法使用這個 Python：${reason}`,
    accountHeading: 'Google 帳號',
    noPython: '先選擇 Python 環境',
    notChecked: '尚未檢查',
    signedOut: '這台電腦上還沒有 Earth Engine 的登入憑證',
    checking: '正在檢查…',
    signedIn: '已登入',
    expired: '登入已失效',
    signIn: '登入',
    signInAgain: '重新登入',
    waiting: '請在瀏覽器中完成授權',
    noBrowser: '瀏覽器沒有開啟？',
    copyLink: '複製授權連結',
    cancel: '取消',
    signInFailed: (reason) => `登入未完成：${reason}`,
    denied: '授權被拒絕',
    timedOut: '已超過 10 分鐘',
    projectHeading: 'Cloud 專案',
    projectPlaceholder: '專案 ID，例如 my-project-123',
    projectInvalid: '專案 ID 只含字母、數字和連字號',
    save: '儲存',
    projectHelp: ['在 ', ' 頂端可以看到專案 ID。'],
    saveFailed: (reason) => `無法儲存專案：${reason}`,
    recheckFailed: (reason) => `無法重新檢查 Google Earth Engine：${reason}`,
    marks: { done: '已完成', todo: '未完成', problem: '有問題', busy: '檢查中' },
  },
};

export const geeText = (locale: Locale): GeeText => PAGE_TEXT[locale] ?? PAGE_TEXT.en;
