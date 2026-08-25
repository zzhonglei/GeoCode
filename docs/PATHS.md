# 文件路径与系统身份

本文档描述 GeoCode 在磁盘与操作系统上的身份:四个数据根、文件命名、系统注册项,以及它们
为什么必须与 OpenCode 彻底分开。

内核侧已经落地——身份字符串集中在 `Brand` 模块(§5),并在沙箱里实测过落盘(§6)。
桌面壳与打包侧尚未迁入,§3.4、§3.5 与 §6 末段因此记的是它们**应当**写成什么样,不是现状。

## 1. 为什么这件事排在最前

GeoCode 与 OpenCode 共享同一个内核,却必须是用户机器上两个互不相干的程序。这条边界不是靠 UI 上的名字划出来的,而是靠磁盘路径、进程身份与操作系统注册表划出来的——只要有一处漏了,两个程序就会读写彼此的文件。这类事故一旦发生,用户看到的是"装了 GeoCode 之后 OpenCode 打不开了",而排查要翻到注册表层。

它必须在任何功能定制之前完成,还有一个务实的原因:此后所有实机验证的落盘都以这套路径为准。路径没定就做装配,测出来的每一个文件都要重测一遍。

## 2. 旧版留下的教训

旧版只改了内核里的一个常量 `app = "geocode"`,四个 XDG 根随之改名,但**文件名那一层从未触碰**。实测旧版目录,商标残留八处:`opencode.db`(含 `-shm`/`-wal`)、`opencode-local.db`(同)、`log/opencode.log`、`opencode.jsonc`。用户打开自己的数据目录,看到的是一个叫 OpenCode 的程序在写文件。

更深的问题是路径不成体系:配置目录里 `geocode.json` 与 `opencode.jsonc` 并存,谁生效说不清;日志目录里三种命名风格混排;GeoCode 自有的 `gee-runtime`、`qgis-pyhome`、`qgis-registry`、`store` 与内核的 `bin`、`models.json` 平铺在缓存根下,分不出谁属于谁。这是增量注入的必然结果——每加一个功能就往根目录随手放一个文件夹,没有人负责整体。

最隐蔽的一处在壳与内核之间。Electron 壳启动内核进程时注入 `XDG_STATE_HOME = userData`,于是内核的 state 根被搬到 `<appData>/<appId>/` 下,而 data、config、cache 三根仍在 XDG 位置。同一个产品的数据因此散在四个顶层位置,其中一根还会随启动方式(TUI 直起 / 壳拉起)漂移。需要说明:这不是旧版的私货,而是**上游桌面壳自身的设计**(state 按应用通道隔离、其余三根跨通道共享)。新版照搬体系时原样保留——这个漂移是刻意的,不要单方面把它"修"掉。

Windows 上还发生过真实事故:NSIS 单击安装器的安装目录取自 package.json 的 `name` 而非 `productName`,由于包名为保持合并卫生保留了 `@opencode-ai/desktop`,GeoCode 装进了 `%LOCALAPPDATA%\Programs\@opencode-aidesktop`——与上游 OpenCode 完全相同的目录,两个程序互相覆盖文件。修复靠 `extraMetadata` 在打包期改写 `name`,但已经装过旧安装器的机器会因注册表里记录的 `InstallLocation` 继续沿用老目录。**身份错误会在注册表里固化,不是重装就能自动纠正的。**

## 3. 与 OpenCode 的一一对应

新版沿用上游的 XDG 布局(不改用各平台惯例路径),差异只在命名空间与文件名。这样做的理由是与上游对齐:内核升级时路径逻辑不会成为冲突点,行为可预测。

### 3.1 四根 + 临时目录

`xdg-basedir` 是纯环境变量实现,未设 `XDG_*` 时一律回落到家目录下的 Linux 风格路径,**Windows 亦然**。因此两个平台的相对结构完全一致,只是家目录写法不同。

| 根 | OpenCode | GeoCode | macOS 展开 | Windows 展开 |
|---|---|---|---|---|
| data | `<XDG_DATA_HOME>/opencode` | `<XDG_DATA_HOME>/GeoCode` | `~/.local/share/GeoCode` | `C:\Users\<user>\.local\share\GeoCode` |
| config | `<XDG_CONFIG_HOME>/opencode` | `<XDG_CONFIG_HOME>/GeoCode` | `~/.config/GeoCode` | `C:\Users\<user>\.config\GeoCode` |
| cache | `<XDG_CACHE_HOME>/opencode` | `<XDG_CACHE_HOME>/GeoCode` | `~/.cache/GeoCode` | `C:\Users\<user>\.cache\GeoCode` |
| state | `<XDG_STATE_HOME>/opencode` | `<XDG_STATE_HOME>/GeoCode` | `~/.local/state/GeoCode` | `C:\Users\<user>\.local\state\GeoCode` |
| tmp | `<tmpdir>/opencode` | `<tmpdir>/GeoCode` | `$TMPDIR/GeoCode` | `%TEMP%\GeoCode` |

### 3.2 各根内的文件

带商标的一律改名;不带商标的逐字保留,减少与上游的差异面。

| 根 | OpenCode | GeoCode | 说明 |
|---|---|---|---|
| data | `opencode.db` `-shm` `-wal` | `geocode.db` `-shm` `-wal` | 打包版主库 |
| data | `opencode-<channel>.db` | `geocode-<channel>.db` | 按发行通道分库;开发态 channel 为 `local` |
| data | `auth.json` / `mcp-auth.json` | 同名 | 凭据,无商标。账号本身存在主库的表里,**不是文件** |
| data | `storage/` `snapshot/` `worktree/` `tool-output/` `plans/` `repos/` | 同名 | 无商标 |
| data | `log/opencode.log` | `log/geocode.log` | |
| data | `log/direct/*.jsonl` | 同名 | |
| config | `opencode.json` / `opencode.jsonc` / `config.json` | `geocode.json` / `geocode.jsonc` | **只保留一套**,不再新旧并存 |
| config | —— | `machine.json` / `machine.jsonc` | **GeoCode 自有**:本机的地理环境描述(见下) |
| config | `themes/` `tui/` `agents/` | 同名 | |
| config | `node_modules/` `package.json` `package-lock.json` | 同名 | 插件安装用,npm 机制要求,不可改名 |
| cache | `bin/` `skills/` `models.json` | 同名 | LSP 与 ripgrep 二进制、模型快照 |
| state | `model.json` `plugin-meta.json` `locks/` | 同名 | |
| cache | `skills/` 暂存区内 `.opencode-version` | `.geocode-version` | 技能暂存版本标记 |
| 用户项目 `.git/` | `opencode`(项目 id 标记文件) | `geocode` | 内核写进项目 git 目录的唯一文件;改名后两个程序各记各的项目 id,互不干扰 |

GeoCode 自有的缓存(QGIS 注册表、GEE 运行时、技能商店目录)统一收进 `cache/geo/` 一层之下,不再与内核产物平铺。这条规则对将来新增的地理能力同样生效——地理内核的任何缓存都在 `geo/` 里,永远一眼可辨。已就位四个成员:`preview/`(预览产物,每次启动清空,§7.6)、`scripts/`(Python 脚本的物化产物,内容哈希命名、变更即换名,§4.13)、`qgis-pyhome/`(符号链接农场,§4.4)、`gee-runtime/`(随执行注入的运行时库,§5.10)——章节号均指 GEOKERNEL.md。

**两个配置文件的分工**必须清晰,否则用户不知道该改哪一个:

| 文件 | 内容 | 生效方式 |
|---|---|---|
| `geocode.json` | 内核与 Agent 配置(模型、代理人、权限等),沿用上游语义 | 实例加载时读取 |
| `machine.json` | **本机地理环境的描述**:各外部软件的位置与所需标识 | **保存即生效**,由地理内核监控并按域重探 |

分成两个文件而非合并为一个,是因为二者的生效语义相反:一个文件内出现两种生效方式,用户无从分辨哪些改动需要重启。分开还带来两项收益——`machine.json` 写坏不波及 Agent 配置;设置界面写入 `machine.json` 时不可能损坏用户手写的内核配置。文件设计见 GEOKERNEL.md §3.1。

**命名排除过两个候选**,理由都不是美学:

- **不叫 `geo.json`**:在 GIS 应用中,名为 `geo.json` 的文件会被当作 GeoJSON 数据文件。
- **不叫 `env.json`**:本产品自身大量操作真正的环境变量(GEOKERNEL.md §4.5、§7.3 要注入 `PROJ_LIB`、`QT_PLUGIN_PATH`、`GDAL_DATA` 等成串变量),而该名字在通行惯例中正指向环境变量文件。两个含义在同一个代码库里贴得太近,会诱发一类被容错机制吞掉的错误:GEOKERNEL.md §5.11 允许 Agent 独立写入本文件,而 §3.1 的未知键**静默忽略**规则(为键名笔误设计)会让写错的变量名解析成功、块值不变、不触发重探,**全链路无一处报错**。

**不做旧配置迁移**:旧版把 QGIS/GEE/GDAL 配置放在 `geocode.json` 的对应块里;新版不读取
那些块,也不自动搬运——旧版已就地退役、配置已归档(§3.5),迁移代码只会为一台机器的一次性
动作长期存在。升级后这些能力显示"未配置"属预期,重新填写 `machine.json` 即可。

`machine.json` 另有一项两个候选都不具备的收益:它自带"不可搬运"的语义。`geocode.json` 里是模型与代理人配置,换机照抄即可用;本文件全是绝对路径,抄过去必然全错。名字说清这一点,省掉一次用户事故。

### 3.3 全景:一台机器上会出现什么

上面两张表按根拆开对照,这里把它们合成一棵树——**用户在自己的磁盘上实际会看到什么**。
标 ★ 的是 GeoCode 自有,其余承自内核。

```
~/.local/share/GeoCode/          数据根:删了会丢会话与登录
├── geocode.db  -shm  -wal       主库:会话、消息、账号、项目登记
├── geocode-local.db  ...        开发态按通道分库
├── auth.json                    供应商凭据(OAuth 令牌与 API key)
├── mcp-auth.json                MCP 服务器的凭据
├── storage/                     会话消息与工具输出的正文
├── snapshot/<项目>/<worktree哈希>/   每工作区一个 git 仓,做检查点用(★ 地理数据不入内)
├── worktree/                    agent 创建的工作树
├── tool-output/                 超长工具输出的落盘副本
├── plans/                       计划模式的产物
├── repos/                       克隆的仓库
└── log/
    ├── geocode.log              滚动日志
    └── direct/<时间戳>-<pid>.jsonl   单次直跑的追踪

~/.config/GeoCode/               配置根:用户手写,删了回到出厂状态
├── geocode.json / .jsonc        内核与 Agent 配置(模型、代理人、权限)
├── machine.json / .jsonc      ★ 本机地理环境:QGIS/GEE/GDAL 装在哪
└── themes/  tui/  agents/       主题、终端形态、自定义 agent

~/.cache/GeoCode/                缓存根:可整个删掉,下次自动重建
├── bin/                         LSP 与 ripgrep 二进制
├── skills/                      技能暂存区(内含 .geocode-version 标记)
├── models.json                  模型目录快照
└── geo/                       ★ 地理内核的全部缓存,一眼可辨
    ├── preview/raster|vector/<键>/   预览产物,**每次启动整体清空**(GEOKERNEL.md §7.6)
    ├── scripts/                 Python 脚本的物化产物,内容哈希命名
    ├── qgis-pyhome/             符号链接农场,给 QGIS 子进程当 HOME
    └── gee-runtime/             随执行注入的 GEE 运行时库

~/.local/state/GeoCode/          状态根:小而重要,记"上次选了什么"
├── model.json                   上次使用的模型
├── plugin-meta.json             插件元信息
└── locks/                       跨进程文件锁

$TMPDIR/GeoCode/                 临时根:进程内的短命文件

<appData>/ai.geocode.desktop/    Electron 壳自己的数据(与上面四根分离,是上游的设计)
└── logs/                        壳侧日志

<用户项目>/                       GeoCode 在用户项目里的全部接触面
├── .git/geocode              ★ 项目 id 标记(一行文本,见下),始终写入
└── .geocode/                    项目级配置,与全局同构;用户自建,GeoCode 不主动创建
    ├── geocode.json / .jsonc    覆盖全局设置
    ├── agent/  command/  skill/ 项目专属定义
    └── plans/                   计划模式的产物(仅当实验性计划模式启用)
```

三条值得单独记住:

- **地理数据从不进快照仓库**。用户项目里的 `.tif`、`.gpkg`、`.shp` 及其附属文件被检查点排除,否则一景遥感影像就能让 `snapshot/` 比项目本身还大(GEOKERNEL.md §10.1 #6);
- **`cache/geo/` 可以随时整个删掉**。四个成员都是可重建的:预览产物本来就每次启动清空,脚本与运行时库按需物化,链接农场重建即可;
- **写进用户项目的只有 `.git/geocode`**。`.geocode/` 是用户自己建的,GeoCode 不主动创建它;写进去的只有计划文件,而且要实验性计划模式启用才会发生。上游会往每个配置目录(**含项目里的那个**)装 `@opencode-ai/plugin` 并写一份 `.gitignore`,那是为了让用户自写的插件能 import SDK——GeoCode 不加载插件,这两件事一并去掉了(KERNEL.md 屏蔽清单)。项目目录里因此不会出现 `node_modules/`。

#### `.git/geocode`:项目身份

内容是一行 id。会话、检查点仓库、工作树全部以它作键(`data/snapshot/<项目id>/…`),所以这个
id **必须跨时间稳定**——一旦变了,用户之前的会话就还在磁盘上但没人找得到。

id 按三档推导:**远端 URL 的哈希** → **本文件记的值** → **首个根提交的哈希**。既然一三档都能
算出来,为什么还要存文件?**因为它们都会变**:本地 `git init` 起步的项目用根提交推导,等用户
某天把它推上 GitHub,规则改用远端——若无本文件,那一刻之前的全部历史就此失联。文件记住上次
用的是哪个,解析时一并返回,调用方据此迁移。改写过历史(rebase 到根)是同一类情形。

**放在 `.git/` 内部而非项目根目录**,因为 git 不跟踪自己的元数据目录:它不出现在 `git status`
里、不会被误提交、同事 clone 时也不会带走你的项目 id。写入位置取 git 的 common directory,
因此一个仓库的多个工作树共享同一个 id,而不是各记各的。

### 3.4 系统身份

| 项 | OpenCode | GeoCode | 影响面 |
|---|---|---|---|
| bundle id / appId | `ai.opencode.desktop` | `ai.geocode.desktop` | macOS 包标识;Windows 注册表键名 |
| 通道变体 | `.dev` / `.beta` 后缀 | 同构 | |
| URL 协议 | `opencode://` | `geocode://` | 深链;注册在系统 |
| 产品名 | `OpenCode` | `GeoCode` | 显示名 |
| Windows 安装目录 | 由 package.json `name` 推导 | 经 `extraMetadata` 改写为 `GeoCode` | **必须显式改写**,否则与上游同目录 |
| Electron userData | `<appData>/<appId>` | 同构 | 壳自己的数据 |
| 应用日志 | `<userData>/logs` | 同构 | 需显式 `setAppLogsPath`,否则回落到包名派生的共享目录 |
| mDNS 服务名 | `opencode-<port>` | `geocode-<port>` | 局域网发现 |
| mDNS 默认域名 | `opencode.local` | `geocode.local` | 用户可在配置中覆盖 |
| macOS MDM plist 域 | `ai.opencode.managed` | `ai.geocode.managed` | `/Library/Managed Preferences/` 下的策略文件名 |
| 系统托管配置目录 | `/Library/Application Support/opencode`(macOS)/ `%ProgramData%\opencode`(Windows) | 同构,`GeoCode` | 目录内的配置文件同样按 `geocode.json(c)` 命名 |
| 环境变量(对外) | `OPENCODE_*` | `GEOCODE_*` | 产品的公开环境变量一律 `GEOCODE_*`,在进程边界映射(见 §3.6) |
| 环境变量(内核内部) | `OPENCODE_*` | **原样保留** | 降格为壳与内核之间的内部 ABI,人类不再直接书写 |
| npm 包名 / User-Agent / config schema URL | 上游值 | **原样保留** | 同上 |

### 3.5 Windows 注册表

NSIS 单击、按用户安装(`oneClick: true`, `perMachine: false`)会写入以下位置,全部在 `HKCU` 下,不触碰 `HKLM`:

| 键 | 内容 | 隔离要点 |
|---|---|---|
| `HKCU\Software\Microsoft\Windows\CurrentVersion\Uninstall\<appId>` | 卸载信息、`InstallLocation`、显示名与版本 | 键名即 appId,改了 appId 就天然隔离 |
| `HKCU\Software\Classes\<scheme>` | `geocode://` 协议处理器 | scheme 必须改,否则抢注上游深链 |
| `HKCU\Software\Classes\Applications\<exe>` | 可执行文件关联 | 随可执行文件名变化 |
| AppUserModelId | 任务栏图标归并与通知归属 | 壳启动时显式设置为 appId |

`InstallLocation` 的固化行为需要特别记住:安装器在决定目标目录时优先读这个键,而不是重新推导默认值。这意味着一次错误的安装目录会跨版本延续,唯一的纠正方式是完整卸载后重装。

### 3.6 环境变量:对外 `GEOCODE_*`,边界翻译

产品的公开环境变量命名空间是 `GEOCODE_*`。但内核源码里从环境读 `OPENCODE_*` 的位置有**数十处、散布二十余个文件**,其中三个落在 OAuth 冻结区(口径:非测试源码中 `process.env` / `Bun.env` 上的 `OPENCODE_*` 访问,按这个口径随时可重数)。在源码层改名既违背薄内核铁律,还有一个更隐蔽的恶果:上游每个版本都在新增 `OPENCODE_*` 变量,合并后它们不会自动跟随改名,产品会退化成一半 flag 听新名、一半听旧名的混杂态。

因此改名做在**进程边界**而非内核:凡拉起内核的入口(开发沙箱脚本、Electron 壳)执行两条规则——

1. **剥离**继承来的一切 `OPENCODE_*`。这台机器可能同时在用真 OpenCode,它的 `OPENCODE_CONFIG(_DIR)`、`OPENCODE_DB` 若泄入,GeoCode 会被另一个产品的设置牵走(macOS Dock 启动不继承 shell 变量,风险被掩盖;Windows 用户级变量会继承,终端启动则完全暴露);
2. **通用映射** `GEOCODE_X → OPENCODE_X`,让内核读到它认识的名字。映射是无差别循环,上游新增任何 flag 自动获得 `GEOCODE_` 别名,零维护。

效果:`OPENCODE_*` 降格为壳与内核之间的内部 ABI(如同 npm 包名只存在于模块解析层),任何人类可见的文档、脚本与配置只出现 `GEOCODE_*`。沙箱脚本已实现并经端到端验证(`GEOCODE_SERVER_PASSWORD` 成功驱动内核 HTTP 认证);壳侧同两条规则,列为壳的验收项。

对全量源码的尽调(2026-07)确认了此方案的边界条件。用户高频接触的环境变量——供应商密钥
(`ANTHROPIC_API_KEY` 等,名字多来自 models.dev 元数据)、代理、编辑器——本就不带
`OPENCODE_` 前缀,机制零干预,体验逐字节一致。内核读取时机虽是"import 一次 / getter 热读 /
调用时读"三态混合,但翻译发生在 exec 之前,进程出生时环境已定,三态看到同一份值。

同一次尽调查出三条副作用,均为接受项:

- **十处 CLI 文案会点名 `OPENCODE_*` 变量**(如 serve 的无密码警告),用户照做会因剥离而
  无效。桌面形态不暴露这些面;若将来某条进入产品界面,归品牌层文案处理;
- **子进程环境里 `GEOCODE_*` 与映射出的 `OPENCODE_*` 并存**,且内核自写 `OPENCODE=1` /
  `OPENCODE_PID` / `OPENCODE_TERMINAL=1` 标记。这属保留指纹的自然延伸,副产品是依赖这些
  标记的生态工具与 in-process 插件原生兼容;
- **内核在特定登录态会把真实凭证写入 `process.env` 传给子进程**(`OPENCODE_CONSOLE_TOKEN`
  等)。上游固有行为,非本机制引入,记档备安全审计。

## 4. 与旧版 0.9.x 的交接

命名空间不做通道派生,也不为新旧共存设计任何机制:新版直接占用 `GeoCode`,内核里的改动就是一个字符串。这个决定有一个前提——**旧版在开发机上就地退役**。macOS 的 APFS 与 Windows 的 NTFS 默认对大小写不敏感,`GeoCode` 与旧版的 `geocode` 解析为同一个目录,共存不可能靠大小写实现;与其为过渡期发明一套派生命名,不如清场。开发机上旧版的 data、config、state 三根已归档(cache 可再生,不留),归档件保存在家目录,此后该目录由新版独占。**旧版应用从此不再启动**——一旦启动它会重建 `geocode` 目录,与新版数据混写在同一个物理位置。

日常开发照旧不落真实目录:沙箱脚本(`scripts/kernel-tui.sh`)通过 `XDG_*` 环境变量把一切收进独立沙箱,删目录即工厂重置。真实的 `GeoCode` 目录只由打包后的应用写入。

真正的交接义务是**消息迁移**。用户的会话消息是最重要的资产,正式版必须提供从旧版(内核 v1.15.6 世代)到新版(v1.18.18 世代)的迁移通道。会话数据存在于数据库与 `storage/` 两处,中间隔着十几个内核 schema 迁移版本,直接拷贝文件不可行;迁移工具是一项独立工程,排期在界面可用之后、正式发布之前。开发机的归档备份同时充当这个工具的第一份真实测试数据。

## 5. 实现方式

身份字符串集中到 `core/src/brand.ts` 这一个模块,所有消费点引用它,不再散落字面量。全部字段由**两个基串**派生:

```ts
const dirName = "GeoCode"   // XDG 各根与系统目录的命名空间(大小写形态)
const name = "geocode"      // 文件名与网络标识的基串,也是配置文件的基名
```

派生出的是数据库文件名、日志文件名、两个配置文件名、项目配置目录、计划文件路径片段、
mDNS 主机与服务名、macOS 托管配置域、项目 id 标记文件、技能暂存版本标记、临时目录前缀。

**不写平铺字面量。** 这不是简洁的问题:文件名与"扫描它的那个基名"必须一致,写成两个字面量就是两处需要人工保持同步的地方。派生之后它们是同一个表达式。

其中两项是这条原则的具体后果,值得单独说明。`projectDir` 与 `configJson` 同源,因为**加载器先判断"这个目录是不是项目配置目录",再进去找配置文件**——两者若分别写死,判断会通过而文件永远找不到,且不报错。`plansSegments` 给的是**路径片段数组而非字符串**,因为有两个调用点必须一致:一处把它接在 worktree 下面写文件,另一处把它接成 glob 作为计划 agent 的编辑授权。展开同一个数组,"写到哪"与"允许改哪"就不可能分家。

这类"写入方与读取方必须成对"的要求不是理论:全局 `mcp add` 曾经写 `opencode.json`、而加载器早已改读 `geocode.json`,于是命令报告成功、服务器永不出现。现在每一处改名都配一个往返测试。

这样做的收益不在少写几行,而在审计:上游将来新增一处硬编码 `opencode` 字面量时,typecheck 不会报错,但只要对照这个模块做一次 grep 就能发现遗漏。路径层的正确性无法靠类型系统保证,只能靠可审计性保证。

路径补丁之外还有一处成对的摘除。内核内置的 GitLab Duo 与 Poe 登录插件(`opencode-gitlab-auth` / `opencode-poe-auth`)以 npm 发布包的形式随内核加载,其打包产物**内嵌了一份发布版 core 的路径代码**——插件一加载就在用户磁盘上创建 `opencode` 命名的空目录,而这份副本是编译产物,源码补丁永远够不到。GeoCode 不提供这两种登录方式,已在 `plugin/index.ts` 的内置插件清单中摘除;Anthropic、OpenAI、Copilot 等其余登录链路不受影响,对应绊线测试防上游合并悄然复活。**给界面阶段的提醒:对接 UI 时,登录/供应商界面中 GitLab Duo 与 Poe 的入口元素必须一并移除**——内核侧已经没有这两个认证方法,留下入口就是点了没反应的死按钮。

注入点:`core/src/global.ts` 的命名空间常量、`core/src/database/database.ts` 的库名、日志与配置文件名各一处,以及壳侧的 `electron-builder.config.ts` 与 `src/main/index.ts` 的身份配置。壳与内核必须使用同一套常量来源,避免两侧各自演化。

## 6. 验证

路径正确性不能靠阅读代码确认,必须实测落盘:在干净沙箱中启动内核,遍历产生的全部文件,逐一对照本文档的表格;再以打包后的应用重复一次,确认生产态与开发态一致。Windows 侧额外检查注册表三个键的实际写入值。任何一处对不上,都说明存在未被发现的硬编码。

对账会话必须**真正进入项目、加载过插件**——健康检查级别的冒烟不会触发插件层,而内置插件恰恰以这种方式漏检过一次(GitLab/Poe 插件的内嵌 core 副本只在插件加载时落盘)。

## 7. 挂起项

以下与"独立于 OpenCode"相关、但刻意不在路径阶段处理的事项,记录在此防止遗忘:

- **内核自动更新检查**指向上游的 npm/brew/scoop 通道(`opencode-ai` 等),桌面形态必须关闭,归装配阶段(`OPENCODE_DISABLE_AUTOUPDATE` 或配置层)。
- **CLI scriptName 与 OTLP serviceName** 等非磁盘品牌字符串,归界面/品牌阶段。

原先挂在这里的两条已经处理,去向记在此处以免再被当作待办:

- **项目目录的 `.opencode/` 与 `opencode.json`** 已改名为 `.geocode/` 与 `geocode.json`,家目录那条没有开关保护的 `~/.opencode` 扫描直接删除(我们只有一个全局根)。跨产品执行代码的那一半由屏蔽清单解决——插件与文件式工具都不再加载,见 KERNEL.md。
- **`~/.agents` 与项目内 `.agents/skills`** 决定**保留**。它与 `AGENTS.md` 同属跨产品的开放约定,内容是用户自己刻意放的;关掉的是**其他产品专有**的位置(`.claude/`、`~/.opencode/`)。这条分界同时解释了为什么 `CLAUDE.md` 与 `.claude/skills` 默认不读。
