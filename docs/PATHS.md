# 路径与存储

本文档列出 GeoCode 在用户电脑上与项目里产生的全部文件、各自的用途,以及删除它们的后果。GeoCode 调用的外部软件(如 QGIS)运行时写它自己的配置与缓存,照它的默认位置,不在此列。

GeoCode 与用户自己装的 OpenCode、OpenChamber 可以同时安装、同时运行,互不读写对方的文件:GeoCode 的会话与登录不出现在它们里面,它们的配置也不改变 GeoCode 的行为;卸载或重置其中一个,其余的不受影响。所以内核与壳的目录、文件名和应用在操作系统上的身份都换成 GeoCode 的,两个上游合用一个名字 `geocode`。GeoCode 不迁移、不导入 OpenCode、OpenChamber 与 GeoCode 第一版的任何数据。守住这一点的约束见第 9 节。

## 1. 位置

| 用途 | macOS | Windows |
|---|---|---|
| 配置 | `~/.config/geocode/` | `C:\Users\<用户>\.config\geocode\` |
| 数据 | `~/.local/share/geocode/` | `C:\Users\<用户>\.local\share\geocode\` |
| 缓存 | `~/.cache/geocode/` | `C:\Users\<用户>\.cache\geocode\` |
| 状态 | `~/.local/state/geocode/` | `C:\Users\<用户>\.local\state\geocode\` |
| 临时文件 | `$TMPDIR/geocode/` 与 `$TMPDIR` 下 `geocode-` 开头的文件 | `%TEMP%\geocode\` 与 `%TEMP%` 下 `geocode-` 开头的文件 |
| 窗口数据 | `~/Library/Application Support/GeoCode/` | `%APPDATA%\GeoCode\` |
| 日志 | `~/Library/Logs/GeoCode/main.log` 与数据目录的 `log/` | `%APPDATA%\GeoCode\logs\main.log` 与数据目录的 `log\` |
| 程序 | `/Applications/GeoCode.app` | `%LOCALAPPDATA%\Programs\geocode\` |

环境里设了 `XDG_CONFIG_HOME`、`XDG_DATA_HOME`、`XDG_CACHE_HOME`、`XDG_STATE_HOME` 的,配置、数据、缓存、状态目录改在它们下面的 `geocode/`。

## 2. 配置目录

放用户自己编辑的配置。GeoCode 启动时建立这个目录;在设置里修改配置时,会在配置文件旁边留一份改动前的副本(如 `geocode.json.geocode.backup`),只供手动恢复;GeoEngine 写入 `machine.json` 时先写同目录的 `machine.json.tmp` 再改名;写到一半时应用崩溃,它会留到下一次写入。此外不往里面放别的文件。

```
~/.config/geocode/
├── geocode.json        全局配置:模型与服务商、权限、MCP 服务、网页搜索等。也可以写成 geocode.jsonc(允许注释)
├── machine.json        本机地理执行环境的配置:QGIS、Python 等软件的位置与 GEE 的 Cloud 项目,GeoEngine 写入,也可以手改(见 GEOENGINE.md 第 3.2 节)
├── AGENTS.md           写给所有项目的指示,每次对话都会带上
├── agents/             自定义 agent,每个一份 .md
├── commands/           自定义命令,每个一份 .md
└── skills/             技能,每个一个目录
```

设置界面里的全局设置(服务商、agent、命令、MCP、全局指示)写的也是这里的文件,手写与界面修改是同一份。删掉整个目录,全局配置回到默认。

## 3. 数据目录

会话、登录与应用状态都在这里。删掉它,所有会话记录、模型服务商的登录与应用设置都会丢失。

```
~/.local/share/geocode/
├── geocode.db            数据库:会话与消息、模型服务商的登录凭据、MCP 服务的授权、「始终允许」的权限、模型目录、各会话建过的 GEE 任务名
├── geocode.db-wal, -shm  数据库运行时的附属文件,随数据库一起存在
├── log/geocode.log       内核日志,超过 50 MB 时自动截去旧内容
├── snapshot/             每个项目的检查点仓库,用于撤销 agent 的修改;只保存差异,复用项目自己的 git 对象
├── tool-output/          过长的工具输出的完整内容,7 天后清理
├── shell/                agent 执行命令的输出
├── worktree/             为并行任务建立的 git 工作树
├── repos/                agent 查阅外部代码时克隆的仓库
├── plan/                 计划模式写下的计划
└── desktop/              应用的设置与状态
    ├── settings.json         这台电脑上的状态:窗口位置等
    ├── preferences.json      个人偏好:界面、默认模型等
    ├── projects/             每个项目的设置、定时任务、上下文与计划
    ├── project-icons/        项目图标
    ├── chats/                不属于任何项目的对话各自的工作目录,agent 在这类对话里生成的文件都在这里
    ├── themes/               自定义主题:放进来的主题文件直接可选,在设置里导入的也存在这里
    ├── speech-models/        下载的本地语音输入模型
    ├── goals/                会话目标
    ├── walkthroughs/         生成的改动导览
    ├── sessions-archive.json      会话的归档状态
    ├── sessions-directories.json  会话分组
    ├── message-queue.json         排队等待发送的消息
    ├── discovered-apps.json       本机可用来打开文件的应用列表
    ├── git-identities.json        保存的 git 身份
    ├── github-auth.json           GitHub 登录
    ├── source-control-bindings.json  每个仓库绑定的身份
    ├── source-control-mutations.json, source-control-audit.json  对拉取请求与议题所做操作的进度与记录
    ├── git-ssh-credentials.json   托管的 SSH 密钥的清单
    ├── git-ssh-private-keys/      托管的 SSH 私钥,从 ~/.ssh 导入时复制而来
    ├── git-ssh-operation-keys/    一次拉取或推送期间临时取出的私钥
    ├── git-network-operations.json  经应用执行的克隆、拉取与推送的记录
    ├── git-contributor-provenance.json  从贡献者的拉取请求建立的工作树的来源
    ├── git-worktree-bootstrap.json  新工作树执行启动命令的进度
    ├── git-credential-endpoint.json, bin/git-credential-geocode  git 凭据助手与它调用的接口地址和密钥
    ├── tracked-items.json         会话关联的议题与拉取请求的状态
    ├── dispatch-results.json      等待交回发起会话的子会话结果
    ├── message-search.sqlite      消息搜索的索引,在设置里打开后才建立
    ├── voice-keys.json            语音朗读与转写服务的密钥
    ├── quota/                     查询用量所用的密钥
    ├── remote-clients.json        窗口的访问令牌记录
    ├── geocode.managed.json       应用交给内核的配置,每次启动重新生成
    ├── agent-tool/                让 agent 使用应用功能(浏览器、通知等)的插件,每次启动重新生成
    ├── managed-kernel/            正在运行的内核进程的登记,用来清理异常退出后留下的进程
    └── tmp/                       合并分支时的临时工作树
```

`log/`、`repos/` 与 git 凭据助手的两份文件每次启动就建立,其余的用到对应功能时才会出现,在没用过的电脑上不存在。设置或偏好写到一半时应用崩溃,会留下名字里带 `.tmp-` 的副本;git 与代码托管的几份存储写入时在旁边建 `.lock` 锁文件与临时副本,崩溃时可能留下;排队的消息读不出时,原文件改名为 `message-queue.json.corrupt-<时间>` 留下。

## 4. 缓存、状态与临时文件

缓存目录里的东西都能重新生成,可以随时删除,下次需要时重新下载。

```
~/.cache/geocode/
├── bin/          本机没有 ripgrep 时下载的 rg,内核的持久终端所用的 geocode-pty
├── npm/          按需安装的服务商 SDK 与格式化工具
└── npm-cache/    下载 npm 包的缓存
```

使用 GitLab 服务商时,这里还有两份 GitLab 模型信息的缓存。

状态目录 `~/.local/state/geocode/` 每次启动就建立。里面有 `locks/` 下的锁文件,安装 npm 包与克隆外部仓库时使用;内核的持久终端启动过时,还有它的运行目录 `pty/`。

临时目录 `$TMPDIR/geocode/` 是提示 agent 存放临时文件的地方,agent 可以不经询问读写。系统临时目录下另有几类以 `geocode-` 开头的短期文件:查看 git 差异与暂存部分修改时的中间文件(`geocode-branch-diff-*`、`geocode-hunk-*`)、内核列出项目改动时未跟踪文件的中间文件(`geocode-untracked-*`)、多方案运行保存快照时的中间文件(`geocode-snapshot-*`),经应用推送 Git LFS 文件与在贡献者的工作树里执行检出钩子时的中间目录(`geocode-lfs-upload-*`、`geocode-checkout-hook-*`),macOS 上还有转换应用图标时的 `geocode-icon-*.png`。macOS 上用系统语音朗读时,另有读完即删的 `say-*.m4a`。每次启动时,运行时还会在系统临时目录解出一个 `.bun-*.dylib` 库文件。这些都是临时文件,删除不影响使用。

内核的持久终端只在调用内核的终端接口时启动,GeoCode 界面里的终端不经过它;Windows 上没有它。它的守护进程在 macOS 上把通信套接字固定放在 `/tmp/opencode-pty-<用户编号>/`,不随 `TMPDIR`。这样路径才短于系统对套接字路径的上限;目录名由上游的守护进程写死,改不了。用户自己的 OpenCode 也用这个目录,套接字按各自的运行目录命名,互不相碰;退出时套接字删除,目录留下。

内核的运行时(Bun)另把插件的转译结果缓存在它自己的共享缓存目录里(macOS 是 `~/Library/Caches/bun`),与本机其他使用 Bun 的程序共用,按内容命名,删除不影响使用。

## 5. 窗口数据、日志与系统登记

窗口数据目录是 Electron 的存储:界面记住的状态(打开的标签页、草稿、折叠状态等)、网页缓存,以及内置浏览器面板的 Cookie 与网站数据(`Partitions/geocode-browser`,对话里展开的 QGIS 手册网页也用它)。删掉它,界面回到初始的布局,浏览器面板里登录过的网站需要重新登录,会话与设置不受影响。

应用日志 `main.log` 记录窗口与进程的运行,超过 5 MB 时换成 `main.old.log`,日志目录里 7 天前的文件自动删除;会话与工具执行记在数据目录的 `log/geocode.log`。排查问题时两份一起看。

操作系统按应用标识 `io.github.zzhonglei.geocode` 记录 GeoCode:

- macOS:偏好设置 `~/Library/Preferences/io.github.zzhonglei.geocode.plist`(文件对话框的位置等),以及在系统设置里授予的权限(麦克风、文件夹访问、通知、本地网络);开机启动打开时,还有一项登录项。
- Windows:安装目录、开始菜单与桌面的快捷方式、注册表 `HKEY_CURRENT_USER` 下的卸载信息与安装位置;开机启动打开时,还有一项启动项。

## 6. 项目里

项目里的配置由用户建立:手写,或在设置里把 agent、命令、技能、MCP 服务等设为项目范围时写入。除此之外,GeoCode 自己写入的只有下面标明的截图与 git 里的几处。

```
<项目>/
├── geocode.json        项目配置,覆盖全局配置
├── AGENTS.md           写给这个项目的指示
├── .geocode/
│   ├── geocode.json    项目配置的另一个位置
│   ├── agents/  commands/  skills/   项目专属的 agent、命令与技能
│   └── screenshots/    agent 使用浏览器时保存的截图
└── .git/
    ├── geocode         项目标识(根提交),建立或删除工作树时写入;壳用它给工作树的目录命名,仓库没有远程地址时内核也用它认出项目
    ├── config          建立工作树时写入 core.longpaths;在设置里给项目套用 git 身份时写入用户名、邮箱与签名的设置;仓库绑定了账号时写入两条 credential.helper(先一条空的,让用户自己的凭据助手在这个仓库里不起作用,再一条指向 GeoCode 的凭据助手)、credential.useHttpPath 与标记它的 geocode.credentialusehttppath,绑定了托管的 SSH 密钥时写入经 GeoCode 运行的 core.sshCommand
    ├── worktrees/      git 为工作树记录的信息,建立工作树时由 git 写入
    └── refs/
        ├── heads/geocode/   新建工作树而没有指定分支名时建立的分支
        └── geocode/runs/    多方案运行里选定一个后,其余方案的工作树删除前留下的快照
```

经应用执行的克隆、拉取与工作树操作,会在仓库里与它旁边短暂建立名字里带 `.geocode-` 的条目与 `refs/geocode/network/` 下的引用,完成后删除,进程被强制结束时可能留下。在设置里修改项目配置时,项目配置旁边同样会留一份 `.geocode.backup` 副本。agent 按任务修改的文件与运行命令产生的文件,由任务本身决定,不在此列;哪些操作要先征得用户同意,由权限设置决定。GeoCode 只认 `geocode` 这个名字下的配置(内核还兼容 `agent/` 这类单数的旧目录名),给其他工具准备的配置(如 `.opencode/`、`.claude/`)不会改变 GeoCode 的行为。

## 7. 读取的用户环境

为了让 git、npm 与云服务照常工作,GeoCode 会读用户为这些工具配置的内容:git 的全局配置,GitHub CLI 的登录(`gh auth token`),`~/.npmrc`,在设置里查找可导入的 SSH 密钥时 `~/.ssh` 下的密钥(选中的复制进数据目录),以及选用对应服务商时 AWS 与 Google Cloud 的凭据。内核启动时还为服务商的登录选项读 AWS 的配置名(`~/.aws/config` 与 `~/.aws/credentials`)、gcloud 配置里的项目与区域,以及 Azure CLI 的登录信息(`~/.azure/azureProfile.json`);Azure CLI 已登录、又没设 Azure 资源时,内核用 `az` 取令牌,向 Azure 列出这个账号下的资源。启动时读取登录 shell 的环境变量,agent 执行的命令与终端因此能找到 conda、GDAL 等工具。GEE 的检查读 Earth Engine 的凭据 `~/.config/earthengine/credentials`。

这些只读不写,例外是在设置里登录 GEE 时,由 earthengine-api 写入它的凭据文件。

## 8. 删除与重置

- 回到默认配置:删除 `~/.config/geocode/`。
- 清空会话、登录与应用设置:退出 GeoCode 后删除 `~/.local/share/geocode/`。
- 释放空间:删除 `~/.cache/geocode/`。
- 重置界面:删除窗口数据目录。
- 完全卸载:删除程序,再删除第 1 节表里的全部位置。

仓库绑定了账号或托管的 SSH 密钥时,它的 `.git/config` 指向数据目录里的凭据助手与 GeoCode 程序本身(第 6 节)。删除数据目录或卸载之前先在设置里解除绑定,否则在终端里对这个仓库拉取与推送会失败。

## 9. 约束

- 内核与壳各自按 `geocode` 这个名字算出目录,GeoCode 不靠设置 `XDG_*`、`TMPDIR` 这类通用变量来指定它们:这些变量会传给内核启动的所有程序,git 会改读 GeoCode 目录里的 git 配置,用户的工具会把配置与缓存写进 GeoCode 的目录。用户自己的环境里设了它们时,照第 1 节跟随。
- 同一个目录,写入方与所有读取方用同一个来源。壳有好几处直接读写内核的文件(配置文件、工作树;登录凭据则经内核的接口取得),漏掉一处不报错,只会读到用户自己的 OpenCode 的文件,或写进它的目录。
- 应用名与应用标识不与 OpenCode、OpenChamber 相同:Electron 的存储与日志、单实例锁、系统偏好与权限、Windows 的安装目录与注册表项都按它们区分。Windows 的安装目录与注册表项在第一次安装时写定,之后的安装沿用,所以应用标识发布之后不再改。
- 目录名不与已有的名字只差大小写:macOS 与 Windows 的文件系统默认不区分大小写。
- 写进用户仓库 `.git/config` 的凭据助手名(`git-credential-geocode`)、标记键(`geocode.credentialusehttppath`)与 SSH 包装的路径,是 GeoCode 认出自己写的条目的依据,发布之后不再改。凭据助手经数据目录里的启动脚本运行,每次启动按程序当前的位置重写;SSH 命令直接写着程序与包装脚本的路径,程序换了位置,绑定了托管 SSH 密钥的仓库要重新绑定。
- 壳的令牌与登录凭据不能靠存放位置防 agent:内核的默认规则不拦 agent 读写会话目录与项目以外的位置,`shell` 也能读写任何文件。
