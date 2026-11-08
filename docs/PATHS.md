# 路径与存储

本文档列出 GeoCode 在用户电脑上与项目里产生的全部文件、各自的用途,以及删除它们的后果;还列出它读取的、用户为别的工具准备的配置。GeoCode 调用的外部软件(如 QGIS)运行时写它自己的配置与缓存,照它的默认位置,不在此列。

本文档的目录树由打包版的检查读取,对照应用实际写下的文件(`development/TESTING.md` 第 7 节):每行先写名字,再隔两个空格写说明;一行列几个目录时,目录之间也隔两个空格。

## 1. 位置

| 用途 | macOS | Windows |
|---|---|---|
| 配置 | `~/.config/geocode/` | `C:\Users\<用户>\.config\geocode\` |
| 数据 | `~/.local/share/geocode/` | `C:\Users\<用户>\.local\share\geocode\` |
| 缓存 | `~/.cache/geocode/` | `C:\Users\<用户>\.cache\geocode\` |
| 状态 | `~/.local/state/geocode/` | `C:\Users\<用户>\.local\state\geocode\` |
| 临时文件 | `$TMPDIR/geocode/` 与 `$TMPDIR` 下 `geocode-` 开头的文件 | `%TEMP%\geocode\` 与 `%TEMP%` 下 `geocode-` 开头的文件 |
| 窗口数据 | `~/Library/Application Support/GeoCode/` | `%APPDATA%\GeoCode\` |
| 日志 | `~/Library/Logs/GeoCode/` 与数据目录的 `log/` | `%APPDATA%\GeoCode\logs\` 与数据目录的 `log\` |
| 程序 | `/Applications/GeoCode.app` | `%LOCALAPPDATA%\Programs\geocode\` |

配置、数据、缓存、状态目录固定在主目录下,环境里设了 `XDG_*` 也不变(`ENVIRONMENT.md` 第 2.2 节)。

## 2. 配置目录

放用户自己编辑的配置。GeoCode 每次启动都建立这个目录,设置界面里的全局设置(服务商、agent、命令、技能、MCP、全局指示)写的也是这里的文件,手写与界面修改是同一份。删掉整个目录,全局配置回到默认。

```
~/.config/geocode/
├── geocode.json        全局配置:模型与服务商、权限、MCP 服务、网页搜索等。也可以写成 geocode.jsonc(允许注释)
├── machine.json        本机地理执行环境的配置:QGIS 的位置与 GEE 的 Cloud 项目,GeoEngine 写入,也可以手改(见 GEOENGINE.md 第 3.3 节)
├── AGENTS.md           写给所有项目的指示,每次对话都会带上
├── agents/             自定义 agent,每个一份 .md
├── commands/           自定义命令,每个一份 .md
└── skills/             技能,每个一个目录
```

在设置里修改配置文件时,旁边留一份改动前的副本(如 `geocode.json.geocode.backup`),只供手动恢复。

## 3. 数据目录

会话、登录、应用状态与内置的 Python 环境都在这里。删掉它,所有会话记录、模型服务商的登录与应用设置都会丢失。

### 3.1 内核

```
~/.local/share/geocode/
├── geocode.db            数据库:会话与消息、模型服务商的登录凭据、MCP 服务的授权、「始终允许」的权限、模型目录、各会话建过的 GEE 任务名
├── geocode.db-wal, -shm  数据库运行时的附属文件,随数据库一起存在
├── log/                  内核日志 geocode.log,超过 50 MB 时自动截去旧内容;收到调试信号时还写堆快照(heap-*.heapsnapshot)与 CPU 剖析(cpu-*.cpuprofile)
├── shell/                agent 执行命令的输出,打开项目时建立每个项目的目录,7 天后清理
├── tool-output/          过长的工具输出的完整内容(地理工具的不存这里),7 天后清理
├── snapshot/             每个项目的检查点仓库,用于撤销 agent 的修改;只保存差异,复用项目自己的 git 对象
├── worktree/             为并行任务建立的 git 工作树,在应用里新建的(项目配置里另指了位置的除外)与 agent 建立的都在这里
├── repos/                配置的 references 列出的仓库,由内核克隆
├── plan/                 计划模式写下的计划
└── artifacts/            agent 发布的页面与文件,只在配置里打开 experimental.artifacts 后出现
```

`geocode.db`、`log/` 与 `repos/` 每次启动就建立,其余的用到对应功能时才出现。

### 3.2 内置的 Python 环境

```
~/.local/share/geocode/python/
├── base/                 环境本体,第一次启动时从应用里安装;GeoEngine 往里写自己的启动文件、Python 包 geocodekit 与「不要用 pip 改这里」的标记(见 PYTHON.md 第 3 节)
├── envs/default/         工作环境,GeoAgent 装的包在这里
├── base.json             装好的环境的标识,与应用自带的不同时重新安装
└── proj/                 PROJ 下载的坐标转换网格的缓存(见 PYTHON.md 第 6 节)
```

每次启动只检查环境,第一次安装、应用自带的环境变了或工作环境缺失时才写。安装期间解开的包与装好的环境同时在,占用约 2.3 GB。Python 第一次导入模块时在各包旁边写 `__pycache__/`。

### 3.3 应用的设置与状态

```
~/.local/share/geocode/desktop/
├── settings.json              这台电脑上的状态:窗口位置等
├── preferences.json           个人偏好:界面、默认模型等
├── chats/                     不属于任何项目的对话各自的工作目录,agent 在这类对话里生成的文件都在这里
├── run/instances/             每次运行一个以进程号命名的目录,放这次运行的应用交给内核的配置 geocode.managed.json,与让 agent 使用应用功能(浏览器、通知等)的插件 agent-tool/,每次启动重新生成;给新会话起标题的插件 session-title/geocode-session-title/ 也在这里;在设置里打开用量超限时换账号或换模型后,还有替内核做这件事的插件 limit-failover/;已退出的进程留下的目录在启动时删掉
├── managed-kernel/            正在运行的内核进程的登记,用来清理异常退出后留下的进程
├── remote-clients.json        窗口的访问令牌的记录(只存摘要)
├── git-credential-endpoint.json, bin/git-credential-geocode  git 凭据助手与它调用的接口地址和密钥
├── environment.json           设置里填的环境变量,以及各项目的环境变量与环境命令
├── projects/                  每个项目的设置、定时任务、上下文与计划,以及 agent 记下的关于这个项目的记忆 memory.json
├── memory.json                agent 记下的关于用户本人的记忆,所有项目共用
├── project-icons/             项目图标
├── themes/                    自定义主题:放进来的主题文件直接可选,在设置里导入的也存在这里
├── speech-models/             下载的本地语音输入模型
├── goals/                     会话目标
├── walkthroughs/              生成的改动导览
├── sessions-archive.json      会话的归档状态
├── sessions-directories.json  会话分组
├── sessions-unread.json       从哪一刻起标出未读的会话,此前结束的回合算已读;第一次启动时写一次
├── session-drafts.json, session-drafts/  没发出的消息草稿;草稿附带的文件放在 session-drafts/ 下每份草稿一个的目录里(按路径附加的只记路径),每台连上的设备都看得到
├── geocode-trust.json         信任过的项目配置,按仓库记下指纹(DESKTOP.md 第 3 节);检查初次运行时记下项目列表里已有的项目
├── session-warming.json       保持服务商提示缓存的会话与时长,在设置里打开后才有
├── message-queue.json         排队等待发送的消息
├── dispatch-results.json      等待交回发起会话的子会话结果
├── tracked-items.json         会话关联的议题与拉取请求的状态
├── pr-watch.json              agent 在等的拉取请求,等到有变化就交回它的会话;应用重启后接着等
├── auto-review.json           自动审查的进度与结果,连同交给两个会话的提示词;关掉窗口也接着审,至多留 100 次,先删最早结束的
├── message-search.sqlite(及 -wal、-shm)  消息搜索的索引,在设置里打开后才建立
├── discovered-apps.json       本机可用来打开文件的应用列表
├── voice-keys.json            语音朗读与转写服务的密钥
├── quota/                     查询用量所用的密钥
├── github-auth.json           GitHub 登录
├── source-control-auth.json   GitHub 企业版服务器的令牌
├── git-identities.json        保存的 git 身份
├── source-control-bindings.json   每个仓库绑定的身份
├── source-control-mutations.json, source-control-audit.json  对拉取请求与议题所做操作的进度与记录
├── git-ssh-credentials.json   托管的 SSH 密钥的清单
├── git-ssh-private-keys/      托管的 SSH 私钥,从 ~/.ssh 导入时复制而来
├── git-ssh-operation-keys/    导入、核对、拉取或推送期间临时取出的私钥
├── git-network-operations.json    经应用执行的克隆、拉取与推送的记录
├── git-contributor-provenance.json  从贡献者的拉取请求建立的工作树的来源
├── git-worktree-bootstrap.json    新工作树执行启动命令的进度
└── tmp/                       合并分支时的临时工作树
```

从 `settings.json` 到 `bin/git-credential-geocode` 每次启动就写,其余的用到对应功能时才出现,在没用过的电脑上不存在。

## 4. 缓存、状态与临时文件

缓存目录里的东西都能重新生成,可以随时删除,下次需要时重新下载。

```
~/.cache/geocode/
├── bin/          本机没有 ripgrep 时下载的 rg;目录每次启动就建立
├── npm/          按需安装的服务商 SDK 与格式化工具,7 天没用的旧版本自动清掉
└── npm-cache/    下载 npm 包的缓存
```

使用 GitLab 服务商时,这里还有两份 GitLab 模型信息的缓存;GitLab 的 SDK 在内核没有交给它密钥时,还读写数据目录里的 `auth.json`。

状态目录 `~/.local/state/geocode/` 每次启动就建立。里面有 `locks/` 下的锁,安装 npm 包与克隆外部仓库时使用,OSM 的工具用其中的 `osm-nominatim` 记下上一次请求 Nominatim 的时刻(`OSM.md` 第 3 节)。

临时目录 `$TMPDIR/geocode/` 每次启动就建立,是提示 agent 存放临时文件的地方,agent 可以不经询问读写;在设置里打开「将粘贴的图像保存为文件」后,粘贴的图片存在其中的 `attachments/<随机名>/`;agent 生成图片而没有指定位置时,壳的图像工具把图片存在其中的 `generated-images/`,内核的实验性生图工具(`experimental_image_generate`)存在 `images/<会话 ID>/`。系统临时目录下另有几类以 `geocode-` 开头的短期文件,用完即删:查看与暂存 git 改动、列出未跟踪的文件、多方案运行保存快照、经应用推送 Git LFS 文件与执行检出钩子时的中间文件;macOS 上还有转换应用图标时的 `geocode-icon-*.png`。例外是 `geocode-git-trust-*`:用户的 git 配置里有 `safe.directory` 条目时,经应用拉取或推送前把这些条目抄进去,每次运行至多一个,不删。macOS 上用系统语音朗读时,另有读完即删的 `say-*.m4a`;运行期间,窗口的单实例锁在 `$TMPDIR` 下的 `scoped_dir*/` 里放一个套接字。

内核的运行时(Bun)在系统临时目录解出它要加载的原生库与原生模块(`.bun-*.dylib`、`.bun-*.node`),并把插件的转译结果缓存在它自己的共享缓存目录里(macOS 是 `~/Library/Caches/bun`,设了 `XDG_CACHE_HOME` 时是它下面的 `bun/`),与本机其他使用 Bun 的程序共用,按内容命名。两者删除都不影响使用。

## 5. 窗口数据、日志与系统登记

窗口数据目录是 Electron 的存储:界面记住的状态(打开的标签页、草稿、折叠状态等)、网页缓存,以及内置浏览器面板的 Cookie 与网站数据(`Partitions/geocode-browser`,对话里展开的 QGIS 手册网页也用它)。删掉它,界面回到初始的布局,浏览器面板里登录过的网站需要重新登录,会话与设置不受影响。其中:

- `v8-compile-cache/` 是主进程代码的编译缓存,每次启动后重写,别的 Electron 版本留下的部分自动清掉,删除只让下一次启动慢一点。
- `electron-log-preload.js` 是日志库给窗口用的脚本,每次启动写一次。
- `IndexedDB/openchamber-ui_app_0.indexeddb.leveldb/` 是界面存在浏览器里的数据,名字来自界面内部的协议,属于 GeoCode,不是用户装的 OpenChamber 的。
- `SingletonLock`、`SingletonCookie`、`SingletonSocket`(Windows 上是 `lockfile`)保证只运行一个 GeoCode,只在运行期间存在。

应用日志 `main.log` 记录窗口与进程的运行,超过 5 MB 时换成 `main.old.log`,日志目录里 7 天前的文件自动删除;会话与工具执行记在数据目录的 `log/geocode.log`。排查问题时两份一起看。

操作系统按应用标识 `io.github.zzhonglei.geocode` 记录 GeoCode:

- macOS:偏好设置 `~/Library/Preferences/io.github.zzhonglei.geocode.plist`(文件对话框的位置等),以及在系统设置里授予的权限(麦克风、文件夹访问、通知、本地网络);开机启动打开时,还有一项登录项。
- Windows:安装目录、开始菜单与桌面的快捷方式、注册表 `HKEY_CURRENT_USER` 下的卸载信息与安装位置,系统按应用标识记下的通知设置;开机启动打开时,还有一项启动项,卸载程序不删它。

## 6. 项目里

项目里的配置由用户建立:手写,或在设置里把 agent、命令、技能、MCP 服务等设为项目范围时写入。除此之外,GeoCode 自己写入的只有下面标明的备份、截图与 git 里的几处。

```
<项目>/
├── geocode.json        项目配置,覆盖全局配置;它与 .geocode/ 里的那份都可以写成 geocode.jsonc(允许注释)
├── AGENTS.md           写给这个项目的指示
├── .geocode/
│   ├── geocode.json    项目配置的另一个位置
│   ├── geocode.json.geocode.backup   在设置里改项目范围的配置时留下的改动前副本(第 2 节),只供手动恢复
│   ├── agents/  commands/  skills/   项目专属的 agent、命令与技能
│   └── screenshots/    agent 使用浏览器时保存的截图
└── .git/
    ├── geocode         项目标识(根提交),在新建工作树的对话框里检查名字、建立或删除工作树时写入;壳用它给工作树的目录命名,仓库没有远程地址时内核也用它认出项目
    ├── config          见下
    ├── worktrees/      git 为工作树记录的信息,建立工作树时由 git 写入;合并分支时的临时工作树也在这里登记,合并结束后删除
    └── refs/
        ├── heads/geocode/   在应用里新建工作树而没有指定分支名时建立的分支(agent 建立的工作树不建分支)
        ├── geocode/archive/ 归档的工作树:删掉文件夹之前的全部状态(包括未提交的改动),在归档页恢复时取回;删除归档时删掉,可选一并删掉它的分支
        └── geocode/runs/    多方案运行里选定一个后,其余方案的工作树删除前留下的快照
```

为拉取请求建立工作树时,同名的旧本地分支若已与请求分叉,移动它之前在 `refs/heads/` 下留一个备份分支 `<分支>-backup-<提交>`。

GeoCode 在 `.git/config` 里写入的:

- 建立工作树时的 `core.longpaths`。
- 在设置里给项目套用 git 身份时的用户名、邮箱与签名设置。
- 仓库绑定了账号时的两条 `credential.helper`(先一条空的,让用户自己的凭据助手在这个仓库里不起作用,再一条指向 GeoCode 的凭据助手)、`credential.useHttpPath` 与标记它的 `geocode.credentialusehttppath`;绑定了托管的 SSH 密钥时,经 GeoCode 运行的 `core.sshCommand`。
- 从贡献者的拉取请求建立工作树时,那个贡献者仓库的 `remote.<名字>.*`。
- 经应用推送并设置上游时,以及 agent 把会话挪进远程已有分支的工作树时的 `branch.<分支>.remote` 与 `branch.<分支>.merge`。
- 在应用里建立工作树、从一个分支开出新分支时,记下它从哪个分支开出的 `branch.<新分支>.gh-merge-base`(GitHub CLI 的约定,`gh pr create` 也拿它作拉取请求的默认目标);叠放的拉取请求与改动对比靠它找到上一层分支。
- 工作树的任务名:用户在侧栏改名或 agent 给任务起名时写进 `branch.<分支>.description`(git 自己的键);agent 起的名字另记在 `branch.<分支>.geocodeAgentTitle`,用来分辨用户改过没有。
- 新建工作树时自动生成的分支名,记在 `branch.<分支>.geocodeGeneratedName`(为议题建立时,要保留的前缀记在 `geocodeGeneratedPrefix`)。这样的分支还没推送时,agent 给任务起名会用 `git branch -m` 把它改成按任务取的名字;改名后记录不再对应,分支不会再被改。
- 在侧栏置顶的工作树,置顶的时刻记在 `branch.<分支>.geocodePinned`,取消置顶时删去。

agent 把会话挪进新的工作树时,未提交的改动经一条 `GeoCode: session … moved to worktree …` 的 stash 带过去,带过去之后删掉;迁移失败、改动又放不回原处时这条 stash 留着,报给 agent 的错误里写着它。在 Git 面板里暂存改动而没写说明时,stash 的说明是 `GeoCode stash <时间>`。

agent 按任务修改的文件与运行命令产生的文件,由任务本身决定,不在此列;哪些操作要先征得用户同意,由权限设置决定。GeoCode 只认 `geocode` 这个名字下的配置(内核还兼容 `agent/` 这类单数的旧目录名)。

## 7. 可能留下的残留文件

GeoCode 写文件多是先写旁边的临时文件、再改名替换,有的另建锁文件;写到一半时应用崩溃或被强制结束,这些中间文件会留下。它们都可以删除。

| 位置 | 名字 | 来源 |
|---|---|---|
| 配置目录、项目的 `.geocode/`、`desktop/` 与它的子目录 | 原名后接 `.tmp`、`.<进程号>.tmp`、`.<随机串>.tmp` 或 `.tmp-<进程号>-…` | 保存设置、配置、agent 与命令文件、各种存储时的临时副本。下次启动只清掉 `settings.json` 与 `preferences.json` 的 |
| 同上 | 原名后接 `.lock`、`.lock.guard`、`.renew.lock`、`.execution-<摘要>.lock` | git、代码托管与项目设置的存储的锁 |
| `desktop/` | 原名后接 `.corrupt-<时间>` | 排队的消息、会话的归档、等待交回的子会话结果、保持提示缓存的会话读不出时,原文件改名留下 |
| `desktop/speech-models/` | `.downloads/`、`.staging-*` | 下载语音模型的中间文件 |
| 数据目录的 `log/` | `geocode.log.trim/` | 截短日志时的锁,每次启动与每小时建立又删掉 |
| 数据目录的 `snapshot/` | `*.init-*`、`index.geocode-*`、`geocode-pack.lock`、`geocode.gitconfig.*` | 建立与更新检查点仓库时的中间文件,过时的下次自动清掉 |
| `python/` | `.unpack-<随机名>/`、`activate.*`、`.writing-<随机名>` | 安装环境与重写 `base` 里的文件时的中间文件,下次启动时清掉 |
| 缓存目录的 `npm/`、`bin/` | `.staging-*`;`ripgrep-*` | 安装 npm 包与下载 ripgrep 的中间文件,前者过时后自动清掉 |
| 配置目录 | `machine.json.tmp` | GeoEngine 写 `machine.json` 的临时副本,下一次写入时覆盖 |
| 项目里被编辑或上传的文件旁 | 原名后接 `.tmp-<进程号>-…`、`.upload-<随机串>` | 在应用里保存或上传文件时的临时副本 |
| 地理工具的输出旁 | `.<名字>.<进程号>.part`、`.<名字>.<进程号>.part.gpkg` | GEE 与 OSM 下载到一半的文件,运行结束时删掉,文件被别的程序占着时留下 |
| 克隆与工作树的旁边与仓库里 | 名字里带 `.geocode-` 的条目、`refs/geocode/network/` 下的引用 | 经应用执行的克隆、拉取与工作树操作的中间产物 |

## 8. 读取的用户环境

为了让 git、npm 与云服务照常工作,GeoCode 读用户为这些通用工具准备的配置,只读不写:

- 环境变量:macOS 上启动时以交互的登录 shell 读一次环境(它会执行 `.zprofile`、`.zshrc` 这类启动文件),Windows 上从注册表读用户与系统的 `PATH`(`ENVIRONMENT.md` 第 2.1 节)。agent 执行的命令与终端因此能找到 conda、GDAL 等工具。
- git:全局配置(身份、`core.sshCommand`、`safe.directory`);没有设 `SSH_AUTH_SOCK` 时,用 `gpgconf` 与 `~/.gnupg` 找 GPG 代理提供的 SSH 套接字;仓库没有绑定账号时,git 照常用用户自己的凭据助手与 SSH。
- GitHub CLI 的登录(`gh auth token`);gh 运行时会在它自己的状态目录写下一个设备标识。列出 GitHub 企业版的服务器时,读 gh 记下的登录主机(`GH_CONFIG_DIR` 或 `~/.config/gh` 下的 `hosts.yml`)与 `GH_HOST`。gh 交出的令牌在它的 `hosts.yml` 没变时重用至多 5 分钟,为此按 gh 自己的顺序找这个文件:`GH_CONFIG_DIR`、`XDG_CONFIG_HOME/gh`、Windows 上的 `%APPDATA%\GitHub CLI`、`~/.config/gh`,只看文件信息(修改时间等),不读内容。
- 在设置里查找可导入的 SSH 密钥时,`~/.ssh` 下的密钥,选中的复制进数据目录。
- npm:安装服务商 SDK 与格式化工具时,`~/.npmrc`、npm 自己的全局配置与 `npm_config_*` 变量。
- 模型服务商:内核启动时为登录选项读 AWS 的配置名(`~/.aws/config` 与 `~/.aws/credentials`);为 Google Vertex AI 的登录选项读 gcloud 配置里的项目号与区域,以及默认凭据文件 `application_default_credentials.json` 里的项目号,不联网,登录时也可以自己填;选用 Azure 并以 Azure CLI 登录时,调用 `az` 取令牌;选用 GitLab 时读 `GITLAB_TOKEN` 与项目的远程地址。配置文件里以 `{file:…}` 引用的密钥文件,用到时读取。
- QGIS:查找安装时,macOS 上看 `/Applications` 与 `~/Applications`、用 Spotlight 按应用标识搜索并读各应用的 `Info.plist`,Windows 上看各个固定磁盘根目录下的 `OSGeo4W*`、`QGIS*` 与 `Program Files` 下的 QGIS。
- GEE:检查与运行读 Earth Engine 自己的凭据 `~/.config/earthengine/credentials`,不读 Google Cloud 的默认凭据。
- 内置 Python 环境里的 requests 与 aiohttp 联网时照惯例读 `~/.netrc`,有对应主机的账号就带上(`PYTHON.md` 第 6 节)。
- 打开文件的应用:macOS 上用 Spotlight 列出本机可用来打开文件的应用,并读它们的图标。
- 系统信任的证书:应用自己联网(连 GitHub 企业版等)时,除了自带的证书,也信任系统证书库(macOS 的钥匙串、Windows 的证书库)里的证书,公司证书签发的服务器因此能连上。内核、git 与 GeoEngine 是各自的进程,不受影响。

例外是在设置里登录 GEE 时,由 earthengine-api 写入它的凭据文件。

## 9. 删除与重置

- 回到默认配置:删除 `~/.config/geocode/`。
- 清空会话、登录与应用设置:退出 GeoCode 后删除 `~/.local/share/geocode/`。
- 释放空间:删除 `~/.cache/geocode/`。
- 重建 Python 环境:退出 GeoCode 后删除数据目录里的 `python/envs/default/`(只重建工作环境,GeoAgent 装的包随之清空)或整个 `python/`(重新安装),下次启动时自动准备。
- 重置界面:删除窗口数据目录。
- 完全卸载:删除程序与第 1 节表里的全部位置,再删除第 5 节的系统登记(macOS 的偏好文件,并在系统设置里撤销权限与登录项;Windows 上先在设置里关掉开机启动)。

仓库绑定了账号或托管的 SSH 密钥时,它的 `.git/config` 指向数据目录里的凭据助手与 GeoCode 程序本身(第 6 节)。删除数据目录或卸载之前先在设置里解除绑定,否则在终端里对这个仓库拉取与推送会失败。

## 10. 约束

- 应用标识 `io.github.zzhonglei.geocode` 发布之后不再改:Windows 的安装目录与注册表项在第一次安装时按它写定,之后的安装沿用;macOS 的偏好设置与权限也按它记录。
- 写进用户仓库 `.git/config` 的凭据助手名(`git-credential-geocode`)、标记键(`geocode.credentialusehttppath`)与 SSH 包装的路径,是 GeoCode 认出自己写的条目的依据,发布之后不再改。凭据助手经数据目录里的启动脚本运行,每次启动按程序当前的位置重写;SSH 命令直接写着程序与包装脚本的路径,程序换了位置,绑定了托管 SSH 密钥的仓库要重新绑定;这时直接解除绑定认不出旧命令,要先重新绑定再解除。
