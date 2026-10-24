import type { Locale } from '@/lib/i18n';

import type { GeeStatus, GeeView } from './geoStatus';

type Refusal = NonNullable<Extract<GeeStatus, { diagnostics: unknown }>['diagnostics']['refusal']>;

/** As QGIS_STATUS: in English whatever the interface language, and short. A refusal is named by its reason. */
const GEE_STATUS = {
  checking: 'Checking…',
  ready: 'Ready',
  'config-error': 'Settings unreadable',
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
    diagnostics.project ? `Project: ${diagnostics.project}` : null,
    diagnostics.output?.trim() ? `Output:\n${diagnostics.output.trim()}` : null,
    diagnostics.traceback?.trim() ? `Traceback:\n${diagnostics.traceback.trim()}` : null,
  ]
    .filter(Boolean)
    .join('\n');
};

export type GeeText = {
  accountHeading: string;
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
  /** The project's monthly quota, in the status card and on this page; hours and times come formatted. */
  quota: {
    heading: string;
    /** The refresh button's name, which says what it refreshes, and its tooltip. */
    refresh: string;
    refreshTitle: string;
    loading: string;
    /** Beside the bar, in place of the share used. */
    unlimited: string;
    used: (used: string, limit: string) => string;
    usedNoLimit: (used: string) => string;
    /** Two facts on one line, as when it resets and when it was sampled. */
    together: (first: string, second: string) => string;
    noData: string;
    resets: (when: string) => string;
    sampled: (when: string) => string;
    failedBecause: (reason: string) => string;
    /** The status card's line for a failure, which has no room for the reason. */
    failedSee: string;
    /** Google could not be reached, after one more try: only the fact, as GEE's check says it. */
    unreachable: string;
    /** The status card's, which has no refresh button. */
    cardUnreachable: string;
    needs: string;
  };
};

const PAGE_TEXT: { en: GeeText } & Partial<Record<Locale, GeeText>> = {
  en: {
    accountHeading: 'Google account',
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
    quota: {
      heading: 'This month\'s quota',
      refresh: 'Refresh this month\'s quota',
      refreshTitle: 'Refresh',
      loading: 'Checking…',
      unlimited: 'No limit',
      used: (used, limit) => `Used ${used} of ${limit} h`,
      usedNoLimit: (used) => `Used ${used} h`,
      together: (first, second) => `${first} · ${second}`,
      noData: 'No usage recorded this month yet',
      resets: (when) => `Resets ${when}`,
      sampled: (when) => `as of ${when}`,
      failedBecause: (reason) => `Could not get this month's quota: ${reason}`,
      failedSee: 'Could not get this month\'s quota; see Settings.',
      unreachable: 'Cannot reach Google right now; refresh again in a moment.',
      cardUnreachable: 'Cannot reach Google right now.',
      needs: 'The quota is read through the project\'s Service Usage and Cloud Monitoring APIs; GEE itself works as usual.',
    },
  },
  'zh-CN': {
    accountHeading: 'Google 账号',
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
    quota: {
      heading: '本月额度',
      refresh: '刷新本月额度',
      refreshTitle: '刷新',
      loading: '正在查询…',
      unlimited: '不限额',
      used: (used, limit) => `已用 ${used} / ${limit} 小时`,
      usedNoLimit: (used) => `已用 ${used} 小时`,
      together: (first, second) => `${first} · ${second}`,
      noData: '本月暂无用量数据',
      resets: (when) => `${when} 重置`,
      sampled: (when) => `统计于 ${when}`,
      failedBecause: (reason) => `无法获取本月额度：${reason}`,
      failedSee: '无法获取本月额度，详情见设置页。',
      unreachable: '暂时连不上 Google，稍后再刷新。',
      cardUnreachable: '暂时连不上 Google。',
      needs: '查额度要用项目里的 Service Usage 与 Cloud Monitoring 两个服务；GEE 本身照常可用。',
    },
  },
  'zh-TW': {
    accountHeading: 'Google 帳號',
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
    quota: {
      heading: '本月額度',
      refresh: '重新整理本月額度',
      refreshTitle: '重新整理',
      loading: '正在查詢…',
      unlimited: '不限額',
      used: (used, limit) => `已用 ${used} / ${limit} 小時`,
      usedNoLimit: (used) => `已用 ${used} 小時`,
      together: (first, second) => `${first} · ${second}`,
      noData: '本月尚無用量資料',
      resets: (when) => `${when} 重置`,
      sampled: (when) => `統計於 ${when}`,
      failedBecause: (reason) => `無法取得本月額度：${reason}`,
      failedSee: '無法取得本月額度，詳情見設定頁。',
      unreachable: '暫時連不上 Google，稍後再重新整理。',
      cardUnreachable: '暫時連不上 Google。',
      needs: '查額度要用專案裡的 Service Usage 與 Cloud Monitoring 兩項服務；GEE 本身照常可用。',
    },
  },
};

export const geeText = (locale: Locale): GeeText => PAGE_TEXT[locale] ?? PAGE_TEXT.en;
