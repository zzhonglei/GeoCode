# 文件路径与系统身份

本文档描述 GeoCode 在磁盘与操作系统上的身份:四个数据根、文件命名、系统注册项,以及它们为什么
必须与 OpenCode 彻底分开。

内核侧与桌面侧的身份都已落地,在 macOS 上端到端验过。§3.5 的 Windows 注册表与 §6 末段的双平台
对账写的是它们**应当**是什么样,那两处只有实机能回答。

## 1. 为什么这件事排在最前

GeoCode 与 OpenCode 共享同一个内核,却必须是用户机器上两个互不相干的程序。这条边界不靠 UI 上的
名字划出来,而靠磁盘路径、进程身份与操作系统注册表——只要有一处漏了,两个程序就会读写彼此的
文件。用户看到的是「装了 GeoCode 之后 OpenCode 打不开了」,而排查要翻到注册表层。

它排在任何功能定制之前,还有一个务实的理由:此后所有实机验证的落盘都以这套路径为准。路径没定
就做装配,测出来的每个文件都要重测一遍。

## 2. 旧版留下的教训

后面每一条规矩都是从这三件事来的。

**只改命名空间不改文件名,等于没改。** 旧版改了内核里的一个常量,四个 XDG 根随之改名,文件名
那一层却从未触碰。用户打开自己的数据目录,看到的是一个叫 OpenCode 的程序在写文件。

**增量注入必然长成一团。** 两代配置文件在同一个目录里并存、谁生效说不清;自有缓存与内核产物
平铺在同一层、分不出谁属于谁。每加一个功能就往根目录随手放一个文件夹,没有人负责整体。

**身份错误会在注册表里固化。** Windows 的 NSIS 安装目录取自 `package.json` 的 `name` 而非
`productName`,GeoCode 因此装进过与上游完全相同的目录,两个程序互相覆盖文件。修复靠
`extraMetadata` 在打包期改写 `name`,但装过旧安装器的机器会按注册表里记的 `InstallLocation`
继续用老目录——**不是重装就能自动纠正的**。

壳与内核的 state 根位置不一致(壳把它搬进 userData,其余三根留在 XDG 位置),这是**上游桌面壳
自身的设计**,不是旧版的私货。新版原样保留,不要单方面把它「修」掉。

## 3. 与 OpenCode 的一一对应

沿用上游的 XDG 布局,不改用各平台惯例路径,差异只在命名空间与文件名。理由是与上游对齐:内核
升级时路径逻辑不会成为冲突点,行为可预测。

### 3.1 四根与临时目录

`xdg-basedir` 是纯环境变量实现,未设 `XDG_*` 时一律回落到家目录下的 Linux 风格路径,**Windows
亦然**。两个平台的相对结构因此完全一致,只是家目录写法不同。

| 根 | OpenCode | GeoCode | macOS 展开 | Windows 展开 |
|---|---|---|---|---|
| data | `<XDG_DATA_HOME>/opencode` | `<XDG_DATA_HOME>/GeoCode` | `~/.local/share/GeoCode` | `C:\Users\<user>\.local\share\GeoCode` |
| config | `<XDG_CONFIG_HOME>/opencode` | `<XDG_CONFIG_HOME>/GeoCode` | `~/.config/GeoCode` | `C:\Users\<user>\.config\GeoCode` |
| cache | `<XDG_CACHE_HOME>/opencode` | `<XDG_CACHE_HOME>/GeoCode` | `~/.cache/GeoCode` | `C:\Users\<user>\.cache\GeoCode` |
| state | `<XDG_STATE_HOME>/opencode` | `<XDG_STATE_HOME>/GeoCode` | `~/.local/state/GeoCode` | `C:\Users\<user>\.local\state\GeoCode` |
| tmp | `<tmpdir>/opencode` | `<tmpdir>/GeoCode` | `$TMPDIR/GeoCode` | `%TEMP%\GeoCode` |

### 3.2 命名规则与两个配置文件

带商标的一律改名,不带商标的逐字保留,减少与上游的差异面。改名后的每个名字都由两个基串派生,
完整清单是 `core/src/brand.ts` 自己(§5),本文不复述——一份清单两处抄写必然漂移。

三处不套这条规则:

- `node_modules/`、`package.json`、`package-lock.json` 逐字保留,npm 机制要求;
- 上游那些本来就不带商标的名字(`auth.json`、`storage/`、`snapshot/` 等)原样沿用;
- **数据库按发行通道分库,而通道取自构建时的 `git branch --show-current`**
  (`script/src/index.ts`),不是固定值。`latest`、`beta`、`prod` 三个通道落回不带后缀的
  `geocode.db`,其余按分支名落在 `geocode-<分支>.db`。⚠️ **换个分支构建就换一个库**,上一个库
  里的会话从界面上消失,但仍留在磁盘上。

配置目录**只保留一套**配置文件,不再新旧并存;GeoCode 自有的缓存统一收进 `cache/geo/` 一层之下,
不与内核产物平铺。这两条直接冲着 §2 第二条教训去,对将来新增的地理能力同样生效。

配置分成**两个文件**:

| 文件 | 内容 | 生效方式 |
|---|---|---|
| `geocode.json` | 内核与 Agent 配置(模型、代理人、权限等),沿用上游语义 | 实例加载时读取 |
| `machine.json` | **本机地理环境的描述**:各外部软件的位置与所需标识 | **保存即生效**,由地理内核监控并按域重探 |

不合并成一个,是因为二者的生效语义相反:一个文件里出现两种生效方式,用户无从分辨哪些改动需要
重启。分开还带来两项收益——`machine.json` 写坏不波及 Agent 配置;设置界面写入它时不可能损坏用户
手写的内核配置。它另有一项收益是自带「不可搬运」的语义:`geocode.json` 换机照抄即可用,而本文件
全是绝对路径,抄过去必然全错。文件设计见 GEOKERNEL.md §3.1。

**命名排除过两个候选**,理由都不是美学:

- **不叫 `geo.json`**:在 GIS 应用里,这个名字会被当成 GeoJSON 数据文件。
- **不叫 `env.json`**:本产品自身大量操作真正的环境变量,而该名字在通行惯例中正指向环境变量
  文件。两个含义贴得太近,会诱发一类被容错机制吞掉的错误:Agent 可以独立写入本文件,而未知键
  **静默忽略**的规则(为键名笔误设计)会让写错的变量名解析成功、块值不变、不触发重探,
  **全链路无一处报错**。

**不做旧配置迁移。** 旧版把 QGIS/GEE/GDAL 配置放在 `geocode.json` 的对应块里;新版不读取那些块,
也不自动搬运——迁移代码只会为一台机器的一次性动作长期存在。升级后这些能力显示「未配置」属预期。

### 3.3 全景:一台机器上实际会出现什么

标 ★ 的是 GeoCode 自有,其余承自内核或壳上游。**这棵树是 §6 对账的判据**,所以它必须完整:新增
一个落盘位置而不写进来,验证就发现不了它。

```
~/.local/share/GeoCode/          数据根:删了会丢会话与登录
├── geocode-<通道>.db  -shm  -wal  主库:会话、消息、账号、项目登记(通道见 §3.2)
├── auth.json                    供应商凭据(OAuth 令牌与 API key)
├── mcp-auth.json                MCP 服务器的凭据
├── <文件名>.geocode.backup    ★ 壳覆盖配置或凭据前留的副本,没有代码读回,只供人手动恢复
├── storage/                     会话消息与工具输出的正文
├── snapshot/<项目>/<工作区哈希>/  每工作区一个 git 仓,做检查点用(★ 地理数据不入内)
├── worktree/                    agent 创建的工作树
├── tool-output/                 超长工具输出的落盘副本
├── plans/                       计划模式的产物
├── repos/                       克隆的仓库
└── log/
    ├── geocode.log              滚动日志
    └── direct/<时间戳>-<pid>.jsonl   单次直跑的追踪

~/.config/GeoCode/               配置根:用户手写,删了回到出厂状态
├── geocode.json / .jsonc        内核与 Agent 配置(模型、代理人、权限)
├── machine.json / .jsonc      ★ 本机地理环境:QGIS/GEE/GDAL 装在哪(§3.2)
├── AGENTS.md                    全局行为提示词
├── agents/  commands/  skills/  自定义 agent、命令与技能
├── themes/  tui/                主题与终端形态
└── desktop/                     壳的数据根,不归内核(为什么挂在这里见 §5)
    ├── settings.json            窗口、主题、布局等桌面偏好
    ├── preferences.json         安装档案
    ├── chats/  projects/        聊天的工作目录、按项目的壳侧设置
    ├── goals/                   会话目标
    ├── sessions-directories.json  会话目录登记
    ├── discovered-apps.json     已安装应用的探测缓存
    ├── skills-catalog-cache.json  skills-github-meta.json   技能商店缓存
    ├── install-id-<面>          三个安装标识(desktop-electron / mobile-capacitor / web)
    ├── managed-opencode/        受管进程登记表
    ├── jwt-secret  ui-passkeys.json  github-auth.json  quota/
    │                            壳自己的四份凭据,`desktop_read_file` 一律拒读(§5)
    └── agent-tool/geocode-browser-plugin.js
                                 主进程每次启动重写、内核加载的插件,装着浏览器工具与控制工具
                                 (DESKTOP.md §7.2)

~/.cache/GeoCode/                缓存根:可整个删掉,下次自动重建
├── bin/                         LSP 与 ripgrep 二进制
├── skills/                      技能暂存区(内含 .geocode-version 标记)
├── models.json                  模型目录快照
└── geo/                       ★ 地理内核的全部缓存,一眼可辨(成员见 GEOKERNEL.md)

~/.local/state/GeoCode/          状态根:小而重要,记「上次选了什么」
├── model.json                   上次使用的模型
├── plugin-meta.json             插件元信息
└── locks/                       跨进程文件锁

$TMPDIR/GeoCode/                 临时根:进程内的短命文件

<appData>/GeoCode/               Electron 的 userData:只有 Chromium 自己的东西(Cookie、本地
                                 存储、缓存、浏览器面板的会话分区)

~/Library/Logs/GeoCode/main.log  壳侧日志:macOS 惯例位置,Windows 落在 <appData>/GeoCode/logs

<用户项目>/                       GeoCode 在用户项目里的全部接触面
├── .git/geocode              ★ 项目 id 标记(见下),始终写入
├── .browser/                 ★ 智能体截图,只在它调用截图动作时创建(DESKTOP.md §7.2)
└── .geocode/                    项目级配置,与全局同构;用户自建,GeoCode 不主动创建
    ├── geocode.json / .jsonc    覆盖全局设置
    ├── agent/  command/  skill/ 项目专属定义
    └── plans/                   计划模式的产物(仅当实验性计划模式启用)
```

三条值得单独记住:

- **地理数据从不进快照仓库。** 用户项目里的 `.tif`、`.gpkg`、`.shp` 及其附属文件被检查点排除,
  否则一景遥感影像就能让 `snapshot/` 比项目本身还大(GEOKERNEL.md §10.1)。
- **`cache/geo/` 可以随时整个删掉。** 成员全部可重建:预览产物每次启动清空,脚本与运行时库按需
  物化,链接农场重建即可。
- **主动写进用户项目的只有两处**:`.git/geocode` 每次都写,`.browser/` 只在智能体调用截图动作时
  建。`.geocode/` 是用户自己建的;写进去的只有计划文件,且要实验性计划模式启用才会发生。上游会往每个配置目录(**含项目里的那个**)装 `@opencode-ai/plugin`
  并写一份 `.gitignore`,那是为了让用户自写的插件能 import SDK——GeoCode 不加载插件,这两件事
  一并去掉了(KERNEL.md 屏蔽清单),项目目录里因此不会出现 `node_modules/`。

**两套根在支持的两个平台上都不相交。** 内核走 §3.1 的 XDG 布局,Electron 的 userData 在 macOS 是
`~/Library/Application Support/GeoCode`、Windows 是 `%APPDATA%\GeoCode`,分处 `%USERPROFILE%` 下
的不同子树。⚠️ **Linux 会撞**——那里 Electron 的 `appData` 就是 `~/.config`,userData 因此等于
内核的配置根。我们只支持 macOS 与 Windows(`CONVENTIONS.md` §8),但壳里的 Linux 分支还在,谁
将来打开它,必须先处理这处重叠。

日志是两套,排障时一起取:壳日志记窗口与进程生命周期,内核日志记会话与工具执行,不合并。

#### `.git/geocode`:项目身份

内容是一行 id。会话、检查点仓库、工作树全部以它作键,所以这个 id **必须跨时间稳定**——一旦变了,
用户之前的会话就还在磁盘上但没人找得到。

id 按三档推导:**远端 URL 的哈希** → **本文件记的值** → **首个根提交的哈希**。既然一三档都能算出
来,为什么还要存文件?**因为它们都会变**:本地 `git init` 起步的项目用根提交推导,等用户某天把它
推上 GitHub,规则改用远端——若无本文件,那一刻之前的全部历史就此失联。文件记住上次用的是哪个,
解析时一并返回,调用方据此迁移。改写过历史(rebase 到根)是同一类情形。

**放在 `.git/` 内部而非项目根目录**,因为 git 不跟踪自己的元数据目录:它不出现在 `git status` 里、
不会被误提交、同事 clone 时也不会带走你的项目 id。写入位置取 git 的 common directory,因此一个
仓库的多个工作树共享同一个 id,而不是各记各的。

壳与内核**共用这一个文件**,这是安全的:内核按「远端 → 本文件 → 根提交」取值,壳写进去的值永远
盖不掉它优先的远端哈希,而没有远端时两侧推出的是同一个根提交。

### 3.4 系统身份

| 项 | OpenCode | GeoCode | 影响面 |
|---|---|---|---|
| bundle id / appId | `ai.opencode.desktop` | `ai.geocode.desktop` | macOS 包标识;Windows 注册表键名 |
| 通道变体 | `.dev` / `.beta` 后缀 | 同构 | |
| URL 协议 | `opencode://` | `geocode://` | 深链,注册在系统。改名的另一半在渲染端:聊天内容里的自家深链必须进拦截清单,否则会被当成普通第三方应用深链、可点、且信任之后不再询问 |
| 打包 UI 的自有协议 | `openchamber-ui://app` | `geocode-ui://app` | 打包版窗口从这个源载入。服务器的 CORS 白名单与渲染端「当前就是本机实例」的判断各持一份手抄 |
| 产品名 | `OpenCode` | `GeoCode` | 显示名,判据见下 |
| Windows 安装目录 | 由 `package.json` 的 `name` 推导 | 经 `extraMetadata` 改写为 `GeoCode` | **必须显式改写**,否则与上游同目录(§2) |
| Electron userData | `<appData>/<appId>` | `<appData>/GeoCode` | 取显示名而非 appId,用户在 Finder 里看到的与应用名一致 |
| 应用日志 | `<userData>/logs` | macOS `~/Library/Logs/GeoCode`,Windows `<userData>/logs` | electron-log 取 `app.getPath('logs')`,不覆写 |
| 浏览器面板 partition | `persist:openchamber-browser` | `persist:geocode-browser` | 主进程只对该 partition 的视图回答截图与清除数据;渲染端手抄一份 |
| mDNS 服务名与域名 | `opencode-<port>` / `opencode.local` | `geocode-<port>` / `geocode.local` | 局域网发现,域名可在配置中覆盖 |
| macOS MDM plist 域 | `ai.opencode.managed` | `ai.geocode.managed` | `/Library/Managed Preferences/` 下的策略文件名 |
| 系统托管配置目录 | `/Library/Application Support/opencode`、`%ProgramData%\opencode` | 同构,`GeoCode` | 目录内配置文件同样按 `geocode.json(c)` 命名 |
| MCP 客户端标识 | 握手 `opencode`;OAuth 动态注册 `OpenCode` | 握手 `geocode`;注册 `GeoCode` 与自家发布仓库 | 握手名每次连接都发出;注册信息显示在授权页上。已注册过的服务器按地址复用,改名不触发重新授权 |
| 环境变量(内核内部) | `OPENCODE_*` | **原样保留** | 降格为壳与内核之间的内部 ABI,人类不再直接书写(§3.6) |
| npm 包名 / User-Agent / schema URL / 模型目录 URL | 上游值 | **原样保留** | 借上游已有的商标身份接入各家 LLM 供应商更现实,用户体感没有差别 |

⚠️ **`app.setName()` 单独既不改 `userData`,也不改 `logs`。** 打包版落对位置靠的是打包器把产品名
写进 bundle,进程启动时默认名就已经对了;开发版靠显式设置 userData 路径,而**日志目录是「改名」与
「设路径」两件事的组合副作用**——只做一件都不生效。这条依赖很脆:上游哪天去掉开发版那次设置,
开发日志会无声地掉回 Electron 的默认目录,而没有任何东西会报错。

**改牌的判据:用户有可能看见的都换**,包括只在出错、竞态或兜底时才出现的文字;**应用发给模型
厂商的内容一律不换**(请求头、User-Agent、归属头、授权地址里的 originator)。代码标识与存储键名
非必要不改,指真实外部服务的名字(如 OpenCode Zen)不改。

只换了商标、但说的事在 GeoCode 里不成立的句子(提到网页端、手机、服务器或已关的功能),同批改写
成本机成立的说法,措辞从简;上游自己本来就不准的句子不改。

逐批的处置记录与绊线清单在 `DESKTOP.md` §7 与 `.artifacts/DECISIONS.md`。

### 3.5 Windows 注册表

NSIS 单击、按用户安装(`oneClick: true`, `perMachine: false`)只写 `HKCU`,不触碰 `HKLM`:

| 键 | 内容 | 隔离要点 |
|---|---|---|
| `…\CurrentVersion\Uninstall\<appId>` | 卸载信息、`InstallLocation`、显示名与版本 | 键名即 appId,改了 appId 就天然隔离 |
| `…\Classes\<scheme>` | `geocode://` 协议处理器 | scheme 必须改,否则抢注上游深链 |
| `…\Classes\Applications\<exe>` | 可执行文件关联 | 随可执行文件名变化 |
| AppUserModelId | 任务栏图标归并与通知归属 | 壳启动时显式设置为 appId |

`InstallLocation` 的固化行为要特别记住:安装器决定目标目录时优先读这个键,而不是重新推导默认值。
一次错误的安装目录会跨版本延续,唯一的纠正方式是完整卸载后重装。

### 3.6 环境变量:边界在进程,规则在 `ENVIRONMENT.md`

内核源码里读 `OPENCODE_*` 的位置有数十处、散布二十余个文件,其中几处落在 OAuth 冻结区。在源码层
逐处改名既违背薄内核铁律,还有一个更隐蔽的恶果:上游每个版本都在新增 `OPENCODE_*`,合并后它们
不会自动跟随改名,产品会退化成一半 flag 听新名、一半听旧名的混杂态。所以处理做在**进程边界**。

本节只留一句:**带商标的剥,不带商标的不动**。`XDG_*` 属于后者——四个数据根由用户环境决定,
GeoCode 只保证壳与内核对它的解读一致。产品没有公开的环境变量面。

## 4. 与旧版 0.9.x 的交接

命名空间不做通道派生,也不为新旧共存设计任何机制:新版直接占用 `GeoCode`。这有一个前提——
**旧版在开发机上就地退役**。macOS 的 APFS 与 Windows 的 NTFS 默认对大小写不敏感,`GeoCode` 与
旧版的 `geocode` 解析为同一个目录,共存不可能靠大小写实现;与其为过渡期发明一套派生命名,不如
清场。**旧版应用从此不再启动**——一旦启动它会重建目录,与新版数据混写在同一个物理位置。

日常开发不落真实目录:沙箱脚本通过 `XDG_*` 把一切收进独立沙箱,删目录即工厂重置。真实的
`GeoCode` 目录只由打包后的应用写入。

真正的交接义务是**消息迁移**。会话数据存在数据库与 `storage/` 两处,中间隔着十几个内核 schema
迁移版本,直接拷贝文件不可行;迁移工具是一项独立工程,排期在界面可用之后、正式发布之前。

## 5. 实现方式

身份字符串集中在 `core/src/brand.ts` 一个模块,所有消费点引用它,不再散落字面量。全部字段由两个
基串派生:

```ts
const dirName = "GeoCode"   // XDG 各根与系统目录的命名空间(大小写形态)
const name = "geocode"      // 文件名与网络标识的基串,也是配置文件的基名
```

**不写平铺字面量**,这不是简洁的问题:文件名与「扫描它的那个基名」必须一致,写成两个字面量就是
两处要人工同步的地方;派生之后它们是同一个表达式。收益也不在少写几行,而在审计——上游将来新增
一处硬编码 `opencode` 字面量时 typecheck 不会报错,但对照这一个模块做一次 grep 就能发现遗漏。
路径层的正确性无法靠类型系统保证,只能靠可审计性保证。

壳与内核必须用同一套常量来源,避免两侧各自演化。唯一的例外是 `electron/package.json` 的 `build`
块:JSON 取不到那份常量,只能抄一份,由绊线对住。

**写入方与读取方必须成对。** 它们分家时不报错:写入的命令照样报告成功,而写下去的东西永远没人
读。这条规律有三个形状:

- **路径本身要同源。** 判断「这个目录是不是项目配置目录」与「进去找哪个配置文件」若分别写死,
  判断会通过而文件永远找不到。`plansSegments` 给的是路径片段数组而非字符串,因为「写到哪」与
  「允许计划 agent 改哪」展开的必须是同一个数组。
- **读取时机也要对齐。** 壳的 `main.mjs` 里,有的路径在模块顶层就求值成字符串、此后不再重算,
  有的是惰性的、每次调用都跟随。所以注入壳数据根必须**紧跟身份设置**,晚一步对某些读取方就已经
  太晚。两种取值方式在同一文件里并存,**不能靠看一眼判断,读取方要逐个查**。
- **前后端各自自洽不等于对齐。** 同一条路径的读取方在渲染端、写入方在服务端时,单看任何一侧都
  正常。绊线因此成对写,一次钉住两端。

**壳的数据根挂在 HOME 下,不挂在 Electron 的 userData 下,`.config` 也是写死的而不是读
`XDG_CONFIG_HOME`。** 两条都是被渲染进程逼出来的:它要按 HOME 自己拼一份 chats 根来兜底,并据此
判断一个目录是不是 chat,而它**读不到环境变量**。**渲染进程算不出来的根,就是两半迟早会各说各话
的根。** 上游把这个根挂在 HOME 下正是同一个理由。

代价要说清楚:开发版与打包版因此**共用一套壳数据**(settings、chats、projects),userData 侧靠
`GeoCode Dev` 分开的只是 Chromium 自己的东西。上游也是这个形状。

根名带 `desktop/` 这一段是必须的:`.config/GeoCode` 本身是内核的配置根,而 macOS 文件系统大小写
不敏感,写 `geocode` 会落进同一个目录,把壳的 settings 与 chats 混进 Agent 配置里。

壳侧还有第二个自有模块,管的是另一件事:它给出**内核**的根,供壳里那几处必须读内核文件的地方
引用。它有两处不能照抄上游——**必须认 `XDG_*`**,否则开发沙箱里壳读一份凭据、内核写另一份,
两边都不报错;**两个基串是手抄件**,因为 `web` 是 `electron` 的依赖而非反向,内核又是另一个安装
根,import 不过去,跨文件的抄件正是绊线的适用场景。

这一层必须对齐的理由比命名整洁强得多:壳读配置层的那个函数是**凭据入口**。它读错根,读到的就是
用户真实的 OpenCode 配置文件,而会话空闲时触发的小模型调用会把里面的 `apiKey` 连同 `baseURL` 一起
送进 `fetch`,默认开、不需要用户操作。**壳读错一个配置根,后果不是设置丢失,是拿别的产品的凭据去
打别的端点。**

改读取方时**必须同时数清写入方**:有几处模块自己拼配置路径、不经统一入口取,改了读取方而不动
它们,写进去的文件就再没人读。

`desktop_read_file` 对四份壳凭据与内核的凭据一律拒读,匹配**折叠大小写**——macOS 与 Windows 默认
大小写不敏感,逐字比较等于只拦住一种拼法。代价是大小写敏感的文件系统上会误拒一个真叫 `.SSH` 的
目录,那是一次被拒的读取,不是泄漏。

**关闭一条跨模块的路径时,中间状态必须是合法状态。** 「读关了写没关」比两头都开更糟——用户会
造出一个自己再也管不了的东西。判断方式很直接:把改到一半的产品交给用户用一遍,想想他会撞上
什么。同理,**一个只读的清单和一个可写的清单危险程度差着量级**,不能因为长得像就一起归类。

内核内置的 GitLab Duo 与 Poe 登录插件不随 GeoCode 加载:它们以 npm 发布包的形式进来,打包产物
**内嵌了一份发布版 core 的路径代码**,一加载就在用户磁盘上创建 `opencode` 命名的空目录,而那份
副本是编译产物,源码补丁永远够不到。摘除做在内置插件清单里,其余登录链路不受影响。

## 6. 验证

路径正确性不能靠阅读代码确认,必须实测落盘:在干净沙箱中启动内核,遍历产生的全部文件,逐一对照
§3.3 的树;再以打包后的应用重复一次,确认生产态与开发态一致。Windows 侧额外检查注册表三个键的
实际写入值。任何一处对不上,都说明存在未被发现的硬编码。

桌面侧多一条约束:开发机上装着真的 OpenChamber,「运行后不存在 OpenChamber 目录」这个判据恒假、
且不含关于本次改动的任何信息。改用**快照对比**——跑前对相关位置取一次文件清单,跑完再取一次,
差集里只应出现 GeoCode 领域内的路径。

对账会话必须**真正进入项目、加载过插件**:健康检查级别的冒烟不会触发插件层,而内置插件恰恰以
这种方式漏检过一次。

⚠️ 这道门只看写,不看读(`CONVENTIONS.md` §7)。读取另一个产品的凭据不留痕,只能靠代码审计发现。

Windows 侧的「两套根不相交」目前只是推导(依据 `xdg-basedir` 的源码与 Electron 对 `appData` 的
取值),实机确认归 `DESKTOP.md` 阶段 8。

## 7. 另外两个 agent 工具的技能根

`~/.claude/skills` 与 `~/.agents/skills`(家目录与项目各级)不进 GeoCode 体系。**判据是归属,不是
开放与否**:两者都是用户写给**任意** agent 工具的技能库,而 GeoCode 是地理助手不是通用 agent。
同一判据也覆盖壳侧的 `.agents/loops`——同一个目录下的邻居,归属完全一样。**下一个
`.agents/<新名字>` 出现时先套这条判据,不要另起讨论。**

**`AGENTS.md` 保留**:它是信息而非能力注入,全局那份读的是我们自己配置根里的那个。用户自定义
技能改从 `~/.config/GeoCode/{skill,skills}`、项目 `.geocode/{skill,skills}` 或 `skills.paths`
进,关闭后仍生效(KERNEL.md §6)。

关闭这条路径时**六处必须同时动**:发现、创建、删除、受管根、目录商店安装目标、UI 位置选择器。
理由就是 §5 末尾那条——「读关了写没关」不是合法状态。⚠️ 删除技能的接口**不接受来源参数**,它把
知道的每个根删一遍,所以「壳还认得 `~/.claude/skills`」不只是多列几个技能,而是删自己的技能会
连带删掉用户 Claude Code 的同名技能,递归、无提示。
