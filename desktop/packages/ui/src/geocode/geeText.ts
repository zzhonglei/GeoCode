import type { Locale } from '@/lib/i18n';

import type { GeeFault } from './geeSteps';
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
    diagnostics.status === undefined ? null : `HTTP status: ${diagnostics.status}`,
    diagnostics.file ? `File: ${diagnostics.file}` : null,
    diagnostics.project ? `Project: ${diagnostics.project}` : null,
    diagnostics.output?.trim() ? `Output:\n${diagnostics.output.trim()}` : null,
    diagnostics.traceback?.trim() ? `Traceback:\n${diagnostics.traceback.trim()}` : null,
  ]
    .filter(Boolean)
    .join('\n');
};

export type GeeText = {
  /** What Google Earth Engine is for, on its card in the overview. */
  cardDescription: string;
  /** The overview before Earth Engine is set up: what is missing, and what it is for. */
  unset: { signedOut: string; projectMissing: string };
  unsetText: string;
  /** The overview's second line under the project, and the link to the Code Editor. */
  projectKind: string;
  openEditor: string;
  setupHeading: string;
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
  checkDescription: string;
  steps: readonly [string, string, string, string];
  /** Under each step that passed: the sign-in found, (the project), valid, working. */
  stepFound: string;
  stepValid: string;
  /** Under the step that is the user's next one, and under Google when it cannot be reached. */
  stepSignedOut: string;
  stepNotSet: string;
  stepUnreachable: string;
  verdicts: { ready: string; checking: string; signedOut: string; projectMissing: string };
  /**
   * The fact of each failure, in the interface's language; the diagnostics carry GeoEngine's and Google's words. The
   * check's time limit in `check-timeout` is CHECK_TIMEOUT in geoengine/src/gee/index.ts.
   */
  explain: Record<GeeFault, string>;
  /** The verdict's way to put a failure right, where there is a sure one. */
  enableApi: string;
  register: string;
  uses: Record<'analyse' | 'assets' | 'export', { name: string; text: string }>;
  /** The project's monthly quota, in the status card and on this page; hours and times come formatted. */
  quota: {
    heading: string;
    /** The refresh button's name, which says what it refreshes, and its tooltip. */
    refresh: string;
    refreshTitle: string;
    loading: string;
    /** The overview's quota line before Earth Engine is ready. */
    notReady: string;
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
    cardDescription: 'Cloud remote sensing and data access',
    unset: { signedOut: 'Not signed in yet', projectMissing: 'No project set yet' },
    unsetText: 'Once signed in with a project set, the agent can do remote sensing with it.',
    projectKind: 'Cloud project',
    openEditor: 'Open in the Code Editor',
    setupHeading: 'Account and project',
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
    checkDescription: 'GeoCode checks what running a script depends on, in order, and stops at the first failure.',
    steps: ['Sign-in', 'Project', 'Google', 'Earth Engine'],
    stepFound: 'Found',
    stepValid: 'Valid',
    stepSignedOut: 'Not signed in',
    stepNotSet: 'Not set',
    stepUnreachable: 'Unreachable',
    verdicts: {
      ready: 'Every check passed; the agent can use Earth Engine.',
      checking: 'Checking; this can take some seconds.',
      signedOut: 'Checked once you sign in with your Google account.',
      projectMissing: 'Checked once a Cloud project is set.',
    },
    explain: {
      'config-error': 'The settings file machine.json cannot be read; GeoCode leaves it as it is.',
      'credentials-invalid': 'The sign-in on this computer has expired or been revoked.',
      'project-not-found': 'This Cloud project cannot be found.',
      'no-permission': 'The signed-in account may not use this project.',
      'api-disabled': 'The Earth Engine API is not enabled in this project; once enabled, it applies in a few minutes.',
      refused: 'Earth Engine refused this project; it may not be registered for Earth Engine yet.',
      unreachable: 'Cannot reach Google: there is no network, or Google cannot be reached.',
      failing: 'Earth Engine is failing or busy right now.',
      'check-timeout': 'The check did not finish in 90 seconds.',
      'check-failed': 'Checking Earth Engine failed unexpectedly.',
      unreadable: 'The status of Earth Engine cannot be read.',
    },
    enableApi: 'Enable the API',
    register: 'Register',
    uses: {
      analyse: { name: 'Remote sensing', text: 'Analysis scripts run on Earth Engine’s servers' },
      assets: { name: 'Tasks and assets', text: 'Results that take long are kept in the cloud for later' },
      export: { name: 'Download and export', text: 'As GeoTIFF, or to Google Drive' },
    },
    quota: {
      heading: 'This month\'s quota',
      refresh: 'Refresh this month\'s quota',
      refreshTitle: 'Refresh',
      loading: 'Checking…',
      notReady: 'Shown once Earth Engine is ready',
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
    cardDescription: '云端遥感分析与数据获取',
    unset: { signedOut: '还没有登录', projectMissing: '还没有设置项目' },
    unsetText: '登录并设置项目后，智能体就能用它做遥感分析。',
    projectKind: 'Cloud 项目',
    openEditor: '在 Code Editor 中打开',
    setupHeading: '账号与项目',
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
    checkDescription: 'GeoCode 按运行脚本所依赖的顺序逐项检查，有一项不通过就停下。',
    steps: ['本机登录', 'Cloud 项目', '连接 Google', 'Earth Engine'],
    stepFound: '已找到',
    stepValid: '有效',
    stepSignedOut: '未登录',
    stepNotSet: '未设置',
    stepUnreachable: '连不上',
    verdicts: {
      ready: '全部通过，智能体可以使用 Earth Engine。',
      checking: '正在检查，可能需要几十秒。',
      signedOut: '登录 Google 账号后自动检查。',
      projectMissing: '设置 Cloud 项目后自动检查。',
    },
    explain: {
      'config-error': '设置文件 machine.json 无法读取，GeoCode 不会覆盖它。',
      'credentials-invalid': '这台电脑上的登录已失效或被撤销。',
      'project-not-found': '找不到这个 Cloud 项目。',
      'no-permission': '当前登录的账号无权使用这个项目。',
      'api-disabled': '这个项目没有启用 Earth Engine API，启用后几分钟生效。',
      refused: 'Earth Engine 拒绝了这个项目，它可能还没有注册 Earth Engine。',
      unreachable: '连不上 Google：没有网络，或无法访问 Google。',
      failing: 'Earth Engine 暂时出错或繁忙。',
      'check-timeout': '检查 90 秒仍未完成，没有得到结果。',
      'check-failed': '检查 Earth Engine 时出了意外的错误。',
      unreadable: '无法识别 Earth Engine 的状态。',
    },
    enableApi: '启用 API',
    register: '注册项目',
    uses: {
      analyse: { name: '遥感分析', text: '在 Earth Engine 的服务器上运行分析脚本' },
      assets: { name: '任务与资产', text: '把耗时的结果存在云端，之后接着用' },
      export: { name: '下载与导出', text: '下载为 GeoTIFF，或导出到 Google Drive' },
    },
    quota: {
      heading: '本月额度',
      refresh: '刷新本月额度',
      refreshTitle: '刷新',
      loading: '正在查询…',
      notReady: '就绪后显示本月用量',
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
    cardDescription: '雲端遙測分析與資料取得',
    unset: { signedOut: '還沒有登入', projectMissing: '還沒有設定專案' },
    unsetText: '登入並設定專案後，智慧體就能用它做遙測分析。',
    projectKind: 'Cloud 專案',
    openEditor: '在 Code Editor 中開啟',
    setupHeading: '帳號與專案',
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
    checkDescription: 'GeoCode 依執行指令碼所依賴的順序逐項檢查，有一項不通過就停下。',
    steps: ['本機登入', 'Cloud 專案', '連線 Google', 'Earth Engine'],
    stepFound: '已找到',
    stepValid: '有效',
    stepSignedOut: '未登入',
    stepNotSet: '未設定',
    stepUnreachable: '連不上',
    verdicts: {
      ready: '全部通過，智慧體可以使用 Earth Engine。',
      checking: '正在檢查，可能需要幾十秒。',
      signedOut: '登入 Google 帳號後自動檢查。',
      projectMissing: '設定 Cloud 專案後自動檢查。',
    },
    explain: {
      'config-error': '設定檔 machine.json 無法讀取，GeoCode 不會覆蓋它。',
      'credentials-invalid': '這台電腦上的登入已失效或被撤銷。',
      'project-not-found': '找不到這個 Cloud 專案。',
      'no-permission': '目前登入的帳號無權使用這個專案。',
      'api-disabled': '這個專案沒有啟用 Earth Engine API，啟用後幾分鐘生效。',
      refused: 'Earth Engine 拒絕了這個專案，它可能還沒有註冊 Earth Engine。',
      unreachable: '連不上 Google：沒有網路，或無法存取 Google。',
      failing: 'Earth Engine 暫時出錯或忙碌。',
      'check-timeout': '檢查 90 秒仍未完成，沒有得到結果。',
      'check-failed': '檢查 Earth Engine 時發生意外的錯誤。',
      unreadable: '無法辨識 Earth Engine 的狀態。',
    },
    enableApi: '啟用 API',
    register: '註冊專案',
    uses: {
      analyse: { name: '遙測分析', text: '在 Earth Engine 的伺服器上執行分析指令碼' },
      assets: { name: '任務與資產', text: '把耗時的結果存在雲端，之後接著用' },
      export: { name: '下載與匯出', text: '下載為 GeoTIFF，或匯出到 Google Drive' },
    },
    quota: {
      heading: '本月額度',
      refresh: '重新整理本月額度',
      refreshTitle: '重新整理',
      loading: '正在查詢…',
      notReady: '就緒後顯示本月用量',
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
