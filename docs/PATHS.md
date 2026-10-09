# 路径与存储

本文档列出 GeoCode 在用户电脑上与项目里产生的全部文件、各自的用途,以及删除它们的后果。GeoCode 调用的外部软件(如 QGIS)运行时写它自己的配置与缓存,照它的默认位置,不在此列。

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
├── machine.json        本机地理执行环境的配置:QGIS、Python 等软件的位置,GeoEngine 写入,也可以手改(见 GEOENGINE.md 第 3.2 节)
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
├── geocode.db            数据库:会话与消息、模型服务商的登录凭据、MCP 服务的授权、模型目录、各会话建过的 GEE 任务名
├── geocode.db-wal, -shm  数据库运行时的附属文件,随数据库一起存在
├── log/geocode.log       内核日志,超过 50 MB 时自动截去旧内容
├── snapshot/             每个项目的检查点仓库,用于撤销 agent 的修改;只保存差异,复用项目自己的 git 对象
├── tool-output/          过长的工具输出的完整内容,7 天后清理
├── shell/                agent 执行命令的输出
├── worktree/             为并行任务建立的 git 工作树
├── repos/                agent 查阅外部代码时克隆的仓库
├── plan/                 计划模式写下的计划
└── desktop/              应用的设置与状态
    ├── settings.json         应用设置:界面、默认模型、窗口位置等
    ├── preferences.json      个人偏好
    ├── projects/             每个项目的设置、定时任务、上下文与计划
    ├── project-icons/        项目图标
    ├── chats/                不属于任何项目的对话各自的工作目录,agent 在这类对话里生成的文件都在这里
    ├── themes/               自定义主题,可以把主题文件放进来再在设置里导入
    ├── speech-models/        下载的本地语音输入模型
    ├── goals/                会话目标
    ├── walkthroughs/         生成的改动导览
    ├── sessions-archive.json      会话的归档状态
    ├── sessions-directories.json  会话分组
    ├── message-queue.json         排队等待发送的消息
    ├── discovered-apps.json       本机可用来打开文件的应用列表
    ├── git-identities.json        保存的 git 身份
    ├── github-auth.json           GitHub 登录
    ├── quota/                     查询用量所用的密钥
    ├── remote-clients.json        窗口的访问令牌记录
    ├── geocode.managed.json       应用交给内核的配置,每次启动重新生成
    ├── agent-tool/                让 agent 使用应用功能(浏览器、通知等)的插件,每次启动重新生成
    ├── managed-kernel/            正在运行的内核进程的登记,用来清理异常退出后留下的进程
    └── tmp/                       合并分支时的临时工作树
```

用到对应功能时才会出现的文件,在没用过的电脑上不存在。

## 4. 缓存、状态与临时文件

缓存目录里的东西都能重新生成,可以随时删除,下次需要时重新下载。

```
~/.cache/geocode/
├── bin/          本机没有 ripgrep 时下载的 rg,终端所用的 geocode-pty
├── npm/          按需安装的服务商 SDK 与格式化工具
└── npm-cache/    下载 npm 包的缓存
```

使用 GitLab 服务商时,这里还有两份 GitLab 模型信息的缓存。

状态目录 `~/.local/state/geocode/` 只有安装 npm 包时用的锁文件。

临时目录 `$TMPDIR/geocode/` 是提示 agent 存放临时文件的地方,agent 可以不经询问读写。系统临时目录下另有几类以 `geocode-` 开头的短期文件:终端的通信套接字(`geocode-pty-*`)、agent 用浏览器时的截图(`geocode-browser-*`)、查看 git 差异与暂存部分修改时的中间文件(`geocode-branch-diff-*`、`geocode-hunk-*`、`geocode-snapshot-*`),macOS 上还有转换应用图标时的 `geocode-icon-*.png`。每次启动时,运行时还会在系统临时目录解出一个 `.bun-*.dylib` 库文件。这些都是临时文件,删除不影响使用。

内核的运行时(Bun)另把插件的转译结果缓存在它自己的共享缓存目录里(macOS 是 `~/Library/Caches/bun`),与本机其他使用 Bun 的程序共用,按内容命名,删除不影响使用。

## 5. 窗口数据、日志与系统登记

窗口数据目录是 Electron 的存储:界面记住的状态(打开的标签页、草稿、折叠状态等)、网页缓存,以及内置浏览器面板的 Cookie 与网站数据(`Partitions/geocode-browser`,对话里展开的 QGIS 手册网页也用它)。删掉它,界面回到初始的布局,浏览器面板里登录过的网站需要重新登录,会话与设置不受影响。

应用日志 `main.log` 记录窗口与进程的运行,7 天前的日志自动删除;会话与工具执行记在数据目录的 `log/geocode.log`。排查问题时两份一起看。

操作系统按应用标识 `io.github.zzhonglei.geocode` 记录 GeoCode:

- macOS:偏好设置 `~/Library/Preferences/io.github.zzhonglei.geocode.plist`(文件对话框的位置等),以及在系统设置里授予的权限(麦克风、文件夹访问、通知、本地网络)。
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
    ├── geocode         项目标识,GeoCode 用它把会话归到这个项目
    ├── worktrees/      git 为工作树记录的信息,建立工作树时由 git 写入
    └── refs/
        ├── heads/geocode/   新建工作树而没有指定分支名时建立的分支
        └── geocode/runs/    多方案运行里选定一个后,其余方案的工作树删除前留下的快照
```

在设置里修改项目配置时,项目配置旁边同样会留一份 `.geocode.backup` 副本。agent 按任务修改的文件与运行命令产生的文件,由任务本身决定,不在此列;哪些操作要先征得用户同意,由权限设置决定。GeoCode 只认上面这些名字,给其他工具准备的配置(如 `.opencode/`、`.claude/`)不会改变 GeoCode 的行为。

## 7. 读取的用户环境

为了让 git、npm 与云服务照常工作,GeoCode 会读用户为这些工具配置的内容:git 的全局配置与 `~/.git-credentials`,GitHub CLI 的登录(`gh auth token`),`~/.npmrc`,以及选用对应服务商时 AWS 与 Google Cloud 的凭据。启动时读取登录 shell 的环境变量,agent 执行的命令与终端因此能找到 conda、GDAL 等工具。这些只读不写。

## 8. 删除与重置

- 回到默认配置:删除 `~/.config/geocode/`。
- 清空会话、登录与应用设置:退出 GeoCode 后删除 `~/.local/share/geocode/`。
- 释放空间:删除 `~/.cache/geocode/`。
- 重置界面:删除窗口数据目录。
- 完全卸载:删除程序,再删除第 1 节表里的全部位置。
