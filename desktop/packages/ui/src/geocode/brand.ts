import type { I18nKey } from '@/lib/i18n/messages/en';
import type { Locale } from '@/lib/i18n/runtime';
import type { I18nDictionary } from '@/lib/i18n/store';

type Messages = Partial<Record<I18nKey, string>>;

export const GEOCODE_RELEASES_URL = 'https://github.com/zzhonglei/GeoCode-Release';
export const GEOCODE_ISSUES_URL = 'https://github.com/zzhonglei/GeoCode/issues/new';

// Links into the sites of OpenCode and OpenChamber are not offered.
export const withoutUpstreamSite = (url: string): string | undefined =>
  /^https:\/\/(?:[\w-]+\.)*(?:opencode\.ai|openchamber\.dev)(?:\/|$)/.test(url) ? undefined : url;

// Renames the label of each status line, leaving the values, which hold paths and error text, and the kernel's own
// lines, which the report indents, as they are.
export const toGeoCodeReport = (lines: readonly string[]): string[] =>
  lines.map((line) => /^\s/.test(line) ? line : line.replace(/^[^:]*/, (label) =>
    label.replace(/OpenChamber/g, 'GeoCode').replace(/^(- )?OpenCode/, '$1Kernel').replace(/OpenCode/g, 'kernel')));

// The diagnostic timeline as a status report says it: GeoCode's own version where the timeline gives the shell's, then
// the labels renamed the same way.
export const toGeoCodeDiagnosticLog = (text: string, version: string | null | undefined): string =>
  toGeoCodeReport(text.split('\n').map((line) => line
    .replace(/^OpenChamber: (.*) \((desktop|web)\)$/,
      (_, shell: string, runtime: string) => `GeoCode version: ${version ?? '(unknown)'} (shell ${shell}, ${runtime})`)
    // The load line's value is the export's own wording, not a path or an error; so are the two below.
    .replace(/^(OpenCode load: )(.*)$/, (_, label: string, value: string) => label + value.replace(/OpenCode/g, 'the kernel'))
    .replace(/^(Current health: .*)OpenCode running=/, '$1kernel running=')
    .replace(/^(- Server journal: bounded history of )OpenCode /, '$1kernel ')
    // An event's source, in brackets after its time; the rest of the line can hold an error's text.
    .replace(/^(\S+ \[)OpenCode\b/, '$1Kernel'))).join('\n');

// OpenCode's own services keep their names.
const UPSTREAM = /(\b[Aa]n )?(?:OpenChamber|OpenCode(?! (?:Zen|Go|Console|Web Search)\b))/g;

export const toGeoCodeText = (text: string): string =>
  text.replace(UPSTREAM, (_, article?: string) => `${article ? article.replace('n ', ' ') : ''}GeoCode`);

// Where upstream means the kernel as a part, describes a server and a client that are one app here, or offers what the app does not have.
const MESSAGES = {
  en: {
    'settings.view.nav.group.opencode': 'Kernel',
    'commandPalette.item.restartOpenCode': 'Restart kernel',
    'chat.toast.opencodeRestartInterrupted.description': 'The kernel restarted while a response was still running. Send a message to continue.',
    'chat.emptyState.opencodeUnreachable': 'The kernel is not reachable',
    'aboutDialog.openCodeVersionLabel': 'Kernel version {version}',
    'aboutDialog.diagnosticsDescription': 'Includes GeoCode state, kernel health, directories, and projects.',
    'sessions.sidebar.session.action.upstreamErrorWithRef': 'The kernel answered {status} {name} (ref {ref}). Search the kernel log for this ref.',
    'sessions.sidebar.session.action.upstreamError': 'The kernel answered {status}: {message}',
    'settings.openchamber.opencodeCli.restart.restartFailed': 'Couldn\'t restart the kernel.',
    'settings.mcp.page.deleteDialog.descriptionSuffix': 'The kernel will need to reload.',
    'settings.integrations.firstParty.info': 'Accounts for the services GeoCode works with. They stay on this computer.',
    'settings.providers.page.auth.apiKeyTooltip': 'Keys are kept on this computer, in the GeoCode data directory.',
    'settings.providers.page.custom.field.apiKey.info': 'Kept on this computer, in the GeoCode data directory. Use {env:VAR_NAME} to read a key from the environment instead.',
    'settings.common.legacyFormat.note': 'This file still uses an older format. The next save rewrites it in the current one.',
    'settings.voice.page.tooltip.localTts': 'On-device synthesis on this computer (Kokoro for English; models for other languages download on first use). No API key needed.',
    'settings.voice.page.tooltip.sttLocal': 'On-device transcription on this computer. Models download automatically; no API key needed.',
    'sessionAuth.error.networkTitle': 'The local service is not responding',
    'sessionAuth.error.networkDescription': 'GeoCode could not verify this window with its local service. Retry, or restart GeoCode.',
    'sourceBoard.empty.noSource': 'This project has no GitHub remote.',
    'settings.environment.user.info': 'Added to the environment of the kernel, Git, the terminal and project actions. Values stay on this computer and are never shown again. A project can add its own in Projects.',
    'settings.environment.user.restartNote': 'The kernel picks up the change after a restart.',
    'settings.projects.environment.info': 'Added to Git, the terminal and project actions in this project and its worktrees, on top of the variables in General. The kernel serves all projects at once, so it doesn\'t get these.',
    'settings.openchamber.opencodeCli.actions.restart': 'Restart kernel',
    'settings.openchamber.opencodeCli.actions.restartingOpenCode': 'Restarting kernel…',
    'settings.agents.page.field.colorTooltip': 'Marks the agent in the composer, menus and messages. Saved in the agent\'s config. Without one, a colour from the theme is picked.',
    'gitView.toast.initializeGitNotDetected': 'Git was initialized, but GeoCode does not see a repository here.',
    'settings.projects.actions.info': 'Commands the run button starts.',
    'chat.chatInput.waitingForOpenCode': 'Waiting for the kernel…',
    'chat.chatInput.waitingForOpenCodeHint': 'The message goes out as soon as the kernel starts',
    'settings.openchamber.sessionWork.info': 'A block in the sidebar, under Chats, for the sessions you\'re working in. A session goes there when you send a message in it, stays in its project as well, and leaves when you mark it done: hover it and use the check, or use the session menu.',
    'settings.openchamber.visual.field.openTrackerLinksOnBoardInfo': 'Links to GitHub issues and pull requests open in the Tracker beside the chat when their project is open here. Cmd+click or Ctrl+click opens the link itself.',
    'session.newWorktree.toast.startFolderMissing': 'This worktree has no "{folder}" folder, so the kernel started at the worktree root.',
    'session.newWorktree.toast.startFolderUnverified': 'Couldn\'t check the "{folder}" folder, so the kernel started at the worktree root.',
    'session.newWorktree.toast.startFolderUnknown': 'Couldn\'t tell which folder of the repository this project opens, so the kernel started at the worktree root.',
    'settings.openchamber.defaults.field.fallbackModelInfo': 'When a usage limit stops a session and no other account can take over, the session continues on this model. Works when GeoCode starts the kernel itself.',
    'settings.providers.accounts.switchOnLimitInfo': 'When the active account hits its usage limit, the next account becomes active for every session and the work continues on it. Works when GeoCode starts the kernel itself.',
    'settings.providers.methods.external.description': 'Use a cloud login set up on the machine the kernel runs on.',
    'settings.skills.page.switch.failed': 'Couldn\'t save the change to the kernel\'s config.',
    'settings.skills.page.switch.keptOnByRuleNoFile': 'On because of the rule {rule} in the kernel\'s config.',
    'settings.skills.page.switch.offByRuleNoFile': 'Off because of the rule {rule} in the kernel\'s config.',
    'settings.skills.page.use.info': 'Off adds a rule to the kernel\'s config and leaves the skill\'s files as they are.',
    'settings.skills.page.use.unknown': 'Couldn\'t read the kernel\'s config, so it\'s not known whether this skill is off. Reopen the page to try again.',
    'settings.sourceControl.token.info': 'GeoCode keeps the token on this computer and never shows it again.',
    'chat.autocomplete.scope.openchamber': 'GeoCode', // the badge of its own commands, which upstream writes in lower case
    'projects.opencodeTrust.title': 'Let the kernel run code from this folder?',
    'projects.opencodeTrust.plugins': 'Configuration files', // the kernel runs no plugin of a project, so only an unreadable file is listed here
    'projects.opencodeTrust.description': 'The kernel runs the commands in the configuration of {path} as soon as it opens the folder. Trust them once, and GeoCode asks again only when they change.',
    'openCodeStatusDialog.heapSnapshot.action': 'Save kernel memory snapshot',
    'openCodeStatusDialog.heapSnapshot.writing': "Writing the snapshot. The kernel pauses until it's done.",
    'openCodeStatusDialog.heapSnapshot.failed': "The kernel couldn't write the snapshot.",
    'settings.openchamber.visual.field.sessionTabsPerWorkspace': 'Separate tabs for each project and worktree', // the app has no isolated spaces, also the two below
    'settings.openchamber.visual.field.sessionTabsPerWorkspaceAria': 'Toggle separate tabs for each project and worktree',
    'settings.openchamber.visual.field.sessionTabsPerWorkspaceInfo': 'Each project and worktree keeps its own tabs, and the header shows the tabs of the one you are in. The first time you open a worktree, the sessions you started there open as tabs.',
  },
  'zh-CN': {
    'settings.view.nav.group.opencode': '内核',
    'commandPalette.item.restartOpenCode': '重启内核',
    'chat.toast.opencodeRestartInterrupted.description': '内核在回复仍在生成时重启了。发送一条消息以继续。',
    'chat.emptyState.opencodeUnreachable': '无法连接内核',
    'aboutDialog.openCodeVersionLabel': '内核版本 {version}',
    'aboutDialog.diagnosticsDescription': '包含 GeoCode 状态、内核健康信息、目录和项目。',
    'sessions.sidebar.session.action.upstreamErrorWithRef': '内核返回 {status} {name}（ref {ref}）。请在内核日志中搜索此 ref。',
    'sessions.sidebar.session.action.upstreamError': '内核返回 {status}：{message}',
    'settings.openchamber.opencodeCli.restart.restartFailed': '无法重启内核。',
    'settings.mcp.page.deleteDialog.descriptionSuffix': '内核需要重新加载。',
    'settings.integrations.firstParty.info': 'GeoCode 所连接服务的账号，保存在本机。',
    'settings.providers.page.auth.apiKeyTooltip': '密钥保存在本机的 GeoCode 数据中。',
    'settings.providers.page.custom.field.apiKey.info': '保存在本机的 GeoCode 数据中。使用 {env:VAR_NAME} 可从环境变量读取密钥。',
    'settings.common.legacyFormat.note': '该文件仍使用旧格式，下次保存会重写为当前格式。',
    'settings.voice.page.tooltip.localTts': '在本机合成语音（英语使用 Kokoro；其他语言的模型在首次使用时下载）。无需 API 密钥。',
    'settings.voice.page.tooltip.sttLocal': '在本机转写。模型自动下载，无需 API 密钥。',
    'sessionAuth.error.networkTitle': '本地服务没有响应',
    'sessionAuth.error.networkDescription': 'GeoCode 无法向本地服务验证此窗口。请重试，或重启 GeoCode。',
    'sourceBoard.empty.noSource': '这个项目没有 GitHub 远程仓库。',
    'settings.environment.user.info': '会添加到内核、Git、终端和项目操作的环境中。值保存在本机，之后不会再显示。项目可以在“项目”中添加自己的变量。',
    'settings.environment.user.restartNote': '内核重启后才会应用此更改。',
    'settings.projects.environment.info': '在“通用”中的变量之外，再添加到此项目及其 worktree 的 Git、终端和项目操作中。内核同时服务所有项目，因此不会收到这些变量。',
    'settings.openchamber.opencodeCli.actions.restart': '重启内核',
    'settings.openchamber.opencodeCli.actions.restartingOpenCode': '正在重启内核…',
    'settings.agents.page.field.colorTooltip': '在输入框、菜单和消息中标识该代理。保存在代理配置中。未设置时会从主题中选取颜色。',
    'gitView.toast.initializeGitNotDetected': 'Git 已初始化，但 GeoCode 在这里看不到仓库。',
    'settings.projects.actions.info': '运行按钮启动的命令。',
    'chat.chatInput.waitingForOpenCode': '正在等待内核…',
    'chat.chatInput.waitingForOpenCodeHint': '内核启动后会立即发送消息',
    'settings.openchamber.sessionWork.info': '侧边栏中位于聊天下方的一个区块，用于放置你正在处理的会话。你在会话中发送消息后，它就会进入这里，同时仍留在所属项目中；标记为完成后才会离开：悬停在会话上点对勾，或使用会话菜单。',
    'settings.openchamber.visual.field.openTrackerLinksOnBoardInfo': 'GitHub 的 Issue 和拉取请求的链接，在其项目已在此打开时会在聊天旁的“跟踪”中打开。Cmd+点击或 Ctrl+点击会打开链接本身。',
    'session.newWorktree.toast.startFolderMissing': '此 worktree 中没有“{folder}”文件夹，因此内核在 worktree 根目录启动。',
    'session.newWorktree.toast.startFolderUnverified': '无法检查“{folder}”文件夹，因此内核在 worktree 根目录启动。',
    'session.newWorktree.toast.startFolderUnknown': '无法确定此项目打开的是仓库中的哪个文件夹，因此内核在 worktree 根目录启动。',
    'settings.openchamber.defaults.field.fallbackModelInfo': '当用量限制让会话停下、且没有其他账号可以接手时，会话会改用这个模型继续。仅在 GeoCode 自己启动内核时生效。',
    'settings.providers.accounts.switchOnLimitInfo': '当前账号达到用量限制时，下一个账号会对所有会话生效，工作在该账号上继续。仅在 GeoCode 自己启动内核时生效。',
    'settings.providers.methods.external.description': '使用内核所在机器上已设置的云登录。',
    'settings.skills.page.switch.failed': '无法将更改保存到内核配置。',
    'settings.skills.page.switch.keptOnByRuleNoFile': '因内核配置中的规则 {rule} 而开启。',
    'settings.skills.page.switch.offByRuleNoFile': '因内核配置中的规则 {rule} 而关闭。',
    'settings.skills.page.use.info': '关闭会在内核配置中添加一条规则，技能文件保持不变。',
    'settings.skills.page.use.unknown': '无法读取内核配置，因此不知道此技能是否已关闭。重新打开页面即可重试。',
    'settings.sourceControl.token.info': 'GeoCode 将令牌保存在本机，之后不会再显示。',
    'chat.autocomplete.scope.openchamber': 'GeoCode',
    'projects.opencodeTrust.title': '允许内核运行此文件夹中的代码？',
    'projects.opencodeTrust.plugins': '配置文件',
    'projects.opencodeTrust.description': '内核一打开文件夹，就会运行 {path} 配置中的命令。信任一次后，只有当它们变更时 GeoCode 才会再次询问。',
    'openCodeStatusDialog.heapSnapshot.action': '保存内核内存快照',
    'openCodeStatusDialog.heapSnapshot.writing': '正在写入快照。完成前内核会暂停。',
    'openCodeStatusDialog.heapSnapshot.failed': '内核无法写入快照。',
    'settings.openchamber.visual.field.sessionTabsPerWorkspace': '为每个项目和 worktree 使用单独的标签页',
    'settings.openchamber.visual.field.sessionTabsPerWorkspaceAria': '切换每个项目和 worktree 的单独标签页',
    'settings.openchamber.visual.field.sessionTabsPerWorkspaceInfo': '每个项目和 worktree 都保留自己的标签页，顶部显示你当前所在位置的标签页。第一次打开某个 worktree 时，你在那里开始的会话会以标签页打开。',
  },
  'zh-TW': {
    'settings.view.nav.group.opencode': '核心',
    'commandPalette.item.restartOpenCode': '重新啟動核心',
    'chat.toast.opencodeRestartInterrupted.description': '核心在回覆仍在產生時重新啟動。傳送訊息以繼續。',
    'chat.emptyState.opencodeUnreachable': '無法連線核心',
    'aboutDialog.openCodeVersionLabel': '核心版本 {version}',
    'aboutDialog.diagnosticsDescription': '包含 GeoCode 狀態、核心健康資訊、目錄和專案。',
    'sessions.sidebar.session.action.upstreamErrorWithRef': '核心回應 {status} {name}（ref {ref}）。請在核心日誌中搜尋此 ref。',
    'sessions.sidebar.session.action.upstreamError': '核心回應 {status}：{message}',
    'settings.openchamber.opencodeCli.restart.restartFailed': '無法重新啟動核心。',
    'settings.mcp.page.deleteDialog.descriptionSuffix': '核心需要重新載入。',
    'settings.integrations.firstParty.info': 'GeoCode 所連接服務的帳號，儲存在本機。',
    'settings.providers.page.auth.apiKeyTooltip': '金鑰儲存在本機的 GeoCode 資料中。',
    'settings.providers.page.custom.field.apiKey.info': '儲存在本機的 GeoCode 資料中。使用 {env:VAR_NAME} 可從環境變數讀取金鑰。',
    'settings.common.legacyFormat.note': '此檔案仍使用舊格式，下次儲存會改寫為目前格式。',
    'settings.voice.page.tooltip.localTts': '在本機合成語音（英文使用 Kokoro；其他語言的模型在首次使用時下載）。不需要 API 金鑰。',
    'settings.voice.page.tooltip.sttLocal': '在本機轉寫。模型會自動下載，無需 API 金鑰。',
    'sessionAuth.error.networkTitle': '本機服務沒有回應',
    'sessionAuth.error.networkDescription': 'GeoCode 無法向本機服務驗證此視窗。請重試，或重新啟動 GeoCode。',
    'sourceBoard.empty.noSource': '這個專案沒有 GitHub 遠端儲存庫。',
    'settings.environment.user.info': '會加入核心、Git、終端機和專案動作的環境中。值保存在本機，之後不會再顯示。專案可以在「專案」中加入自己的變數。',
    'settings.environment.user.restartNote': '核心重新啟動後才會套用此變更。',
    'settings.projects.environment.info': '在「一般」中的變數之外，再加入此專案及其 worktree 的 Git、終端機和專案動作中。核心同時服務所有專案，因此不會收到這些變數。',
    'settings.openchamber.opencodeCli.actions.restart': '重新啟動核心',
    'settings.openchamber.opencodeCli.actions.restartingOpenCode': '正在重新啟動核心…',
    'settings.agents.page.field.colorTooltip': '在輸入框、選單和訊息中標示此代理。儲存在代理設定中。未設定時會從主題中選取顏色。',
    'gitView.toast.initializeGitNotDetected': 'Git 已初始化，但 GeoCode 在這裡看不到儲存庫。',
    'settings.projects.actions.info': '執行按鈕啟動的命令。',
    'chat.chatInput.waitingForOpenCode': '正在等待核心…',
    'chat.chatInput.waitingForOpenCodeHint': '核心啟動後會立即傳送訊息',
    'settings.openchamber.sessionWork.info': '側邊欄中位於聊天下方的一個區塊，用來放置你正在處理的工作階段。你在工作階段中傳送訊息後，它就會進入這裡，同時仍留在所屬專案中；標記為完成後才會離開：將游標移到工作階段上點勾號，或使用工作階段選單。',
    'settings.openchamber.visual.field.openTrackerLinksOnBoardInfo': 'GitHub 的 Issue 與拉取請求的連結，在其專案已在此開啟時會在聊天旁的「追蹤」中開啟。Cmd+點擊或 Ctrl+點擊會開啟連結本身。',
    'session.newWorktree.toast.startFolderMissing': '此 worktree 中沒有「{folder}」資料夾，因此核心在 worktree 根目錄啟動。',
    'session.newWorktree.toast.startFolderUnverified': '無法檢查「{folder}」資料夾，因此核心在 worktree 根目錄啟動。',
    'session.newWorktree.toast.startFolderUnknown': '無法確定此專案開啟的是儲存庫中的哪個資料夾，因此核心在 worktree 根目錄啟動。',
    'settings.openchamber.defaults.field.fallbackModelInfo': '當用量限制讓工作階段停下、且沒有其他帳號可以接手時，工作階段會改用這個模型繼續。僅在 GeoCode 自行啟動核心時生效。',
    'settings.providers.accounts.switchOnLimitInfo': '目前帳號達到用量限制時，下一個帳號會對所有工作階段生效，工作在該帳號上繼續。僅在 GeoCode 自行啟動核心時生效。',
    'settings.providers.methods.external.description': '使用核心所在機器上已設定的雲端登入。',
    'settings.skills.page.switch.failed': '無法將變更儲存到核心設定。',
    'settings.skills.page.switch.keptOnByRuleNoFile': '因核心設定中的規則 {rule} 而開啟。',
    'settings.skills.page.switch.offByRuleNoFile': '因核心設定中的規則 {rule} 而關閉。',
    'settings.skills.page.use.info': '關閉會在核心設定中新增一條規則，技能檔案保持不變。',
    'settings.skills.page.use.unknown': '無法讀取核心設定，因此不知道此技能是否已關閉。重新開啟頁面即可重試。',
    'settings.sourceControl.token.info': 'GeoCode 會將權杖保存在本機，之後不會再顯示。',
    'chat.autocomplete.scope.openchamber': 'GeoCode',
    'projects.opencodeTrust.title': '允許核心執行此資料夾中的程式碼？',
    'projects.opencodeTrust.plugins': '設定檔',
    'projects.opencodeTrust.description': '核心一開啟資料夾，就會執行 {path} 設定中的命令。信任一次後，只有在它們變更時 GeoCode 才會再次詢問。',
    'openCodeStatusDialog.heapSnapshot.action': '儲存核心記憶體快照',
    'openCodeStatusDialog.heapSnapshot.writing': '正在寫入快照。完成前核心會暫停。',
    'openCodeStatusDialog.heapSnapshot.failed': '核心無法寫入快照。',
    'settings.openchamber.visual.field.sessionTabsPerWorkspace': '每個專案和 worktree 使用各自的分頁',
    'settings.openchamber.visual.field.sessionTabsPerWorkspaceAria': '切換每個專案和 worktree 各自的分頁',
    'settings.openchamber.visual.field.sessionTabsPerWorkspaceInfo': '每個專案和 worktree 都保有自己的分頁，頂部會顯示你目前所在位置的分頁。第一次開啟某個 worktree 時，你在那裡開始的工作階段會以分頁開啟。',
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
