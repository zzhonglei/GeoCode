# 桌面应用

本文档说明 GeoCode 怎样把 OpenCode 与 OpenChamber 组装成一个应用:进程怎样组成,内核怎样托管与打包,应用对外的边界在哪里,屏蔽了哪些上游功能,本机上谁能访问它,接受哪些环境变量。

## 1. 组成

GeoCode 是一个应用,安装、启动、退出都只有一个入口,用户不需要另装 OpenCode。

```
Electron 主进程
 ├─ 壳服务端(OpenChamber 的服务端,在主进程内运行)
 │    └─ 子进程:内核(OpenCode,serve --stdio)
 └─ 界面(渲染进程)── HTTP、SSE、WebSocket ──→ 壳服务端
```

界面只与壳服务端通信,壳服务端把内核的接口代理给界面,转发时附上内核的口令,界面拿不到这个口令。两个服务都只监听 127.0.0.1,壳服务端只接受 GeoCode 自己的窗口(第 5 节)。

## 2. 内核

内核是壳的私有组件:只由这个壳启动,只为这个壳服务,随壳退出。壳以 `serve --stdio` 启动它,这是 OpenCode 为私有内核设计的运行方式。壳每次启动内核时随机生成口令,以 `OPENCODE_PASSWORD` 显式传入,优先于用户环境里的同名变量;内核读取后把口令从自己的环境里删掉,agent 执行的命令读不到它。内核把标准输入当作租约,壳正常退出或被强制结束时管道关闭,内核随之退出,不会留下无主的进程。

另外两种方式不采用。上游 OpenChamber 用的普通 `serve` 把口令留在内核的环境里,会被 agent 执行的命令继承,也会被用户导出的同名变量覆盖;OpenCode 桌面版用的 `serve --service` 是每个用户共用的常驻服务,应用退出后仍在运行,默认还与用户自己安装的 OpenCode 共用服务与数据。

安装包里的内核由本仓库的 `kernel/` 构建,版本与 `kernel/` 一致。上游在打包时从 npm 下载 OpenCode 发布的内核,GeoCode 不用这一步,否则对内核的修改进不了安装包。壳只使用安装包里的内核,不读设置里的内核路径、环境变量指定的内核或 `PATH` 上的 `opencode`;内核缺失或起不来时报错,不引导用户安装 OpenCode。构建与暂存的方法见 `DEVELOPMENT.md` 第 4 节,暂存脚本是 POSIX sh,只有 macOS 的打包流程能用。

内核只从两处读配置:全局配置目录,以及会话所在的目录本身。会话所在的目录是用户添加的项目文件夹或它的 worktree,「对话」则是它自己的聊天目录;OpenChamber 的项目级设置也写在会话目录里。两处读的是 `opencode.json(c)`、`AGENTS.md`,以及技能、agent 与命令的目录(全局配置目录里的,和会话目录 `.opencode/` 里的);壳交给内核的托管配置照常读。上游还会从会话目录一路往上找到文件系统的根目录,读每一级的配置与 `.opencode/`(`AGENTS.md` 在主目录下时找到主目录为止,否则找到项目根目录),读 Claude Code 等其他应用的技能目录(`~/.claude/skills`、`~/.agents/skills` 与各级的同名目录),读配置里 `skills` 列出的路径与网址,接入远程下发的配置,这些 GeoCode 都不读。插件的增减只看托管配置:壳注入的工具,以及壳关掉的内核自带插件;插件目录、配置里 `plugins` 列出的插件与 npm 插件包都不加载,其余只有编译进内核的插件。会话被 agent 用 `session_move` 搬到别的目录后,按新目录重新读取。agent 读取会话目录里的文件时,内核会顺带载入文件所在目录及其上各级(不含会话目录本身)的 `AGENTS.md`,这一点与上游相同;文件在会话目录之外时不载入,例如经符号链接读到的文件,或会话目录只是某个 git 仓库的子目录时读到的仓库里的其他文件。

壳也按这两处读写:「技能」页只列出、只编辑、只删除全局配置目录与会话目录 `.opencode/` 下 `skill(s)` 里的技能,另外列出内核自带的只读技能,新建技能也只能放在这两处之一;agent、命令与网页搜索设置里项目级的部分只看会话目录本身。上游的壳还会往上找到 git 仓库根目录,并把 Claude Code 等其他应用的技能目录、`~/.opencode`、配置列出的技能路径与网址技能的下载缓存一并列出,删除技能时连带删掉 `.claude`、`.agents` 里的同名技能,这些 GeoCode 都不做。

## 3. 对外边界

GeoCode 是单机、单用户的应用,三类机制一律关闭:让其他设备连进来的(局域网访问、用户设置的界面口令、设备配对与设备令牌、Private Relay、公网隧道),连到本机内核以外主机的(多主机与主机切换、SSH 远程实例、外部内核),以及不经用户操作就发往上游服务器的(OpenCode 的安装与升级、OpenChamber 的更新检查与使用上报、推送)。`openchamber://` 深链不注册也不处理。移动端、VS Code 扩展、独立的网页服务(包括安装为 PWA)与 `openchamber` 命令行不构建、不打包,用户只通过 GeoCode 的窗口操作应用。

关闭遵循 `DESIGN.md` 的「边界靠装配,不靠删除」:源码保留,入口在三层分别关掉。壳服务端对这些接口回 404,由它自己回答,因为未匹配的 `/api` 路径会落到内核代理;主进程拒绝相应的 IPC 命令;界面隐藏相应的设置页与入口,并在源头停掉自动发出的请求。界面的隐藏只是配合,拒绝发生在壳服务端与主进程。

模型服务的连接是内核的正常工作,不在此列。

## 4. 屏蔽的上游功能

对外机制之外,GeoCode 用不到的上游功能也按同样的方式屏蔽:不启用、不显示,源码保留,入口在壳服务端、主进程与界面三层分别关掉。取舍逐项决定,贯穿其中的有两条:不让第三方代码与外部文件改变应用的行为,不在用户没有需要时把对话或凭据交给第三方。被关掉的设置页即使是上次停留的页面或链接指向的页面,打开设置时也显示「通用」。

### 4.1 第三方代码与外部配置

OpenChamber 的扩展关掉了。扩展从文件夹、压缩包或 git 地址安装,能往界面里加面板、菜单与命令,还能在本机起一个服务进程,这个进程没有沙箱,拥有用户的全部权限。它让第三方代码从界面这一侧进入应用,地理用户用不到,也不该随手装。设置里没有扩展页,也没有把内置浏览器交给扩展的选项,扩展装不进来;数据目录里已经装好的扩展,在 GeoCode 里既不显示也不运行。

插件页关掉了。OpenCode 的插件是在内核进程里以用户全部权限运行、不经权限确认的代码,这一页让人从 npm 装插件或直接手写一段插件代码,是给 agent 写扩展的开发者用的;地理用户写代码是为了处理数据,用不到它。GeoCode 里没有插件页,也不能从设置里增删插件。

魔法提示词页关掉了。魔法提示词是界面内置的一批提示词模板,生成提交信息、解决冲突、斜杠命令与新聊天的起始按钮都靠它们,这些功能照常可用。这一页让人改写这些模板(发出的消息与附带的指令),是给调提示词的人用的,地理用户用不到,改坏了还会让这些功能失常。模板也不接受从外部改写:OpenChamber 把改写存在数据目录的 `magic-prompts.json` 里,GeoCode 不读这个文件,手改它、调用接口或让 agent 改它都不起作用,模板只用源码里内置的那一份。

代码片段停用了。它其实是提示词里的文本宏(中文界面的译名有误):消息里的 `#名字` 在发送前换成事先写好的一段文字,还能往消息前后插入内容。片段是全局配置目录与项目 `.opencode/` 里的文件,等于让外部文件改写用户发出的话,下载来的项目也能带上几段;输入框里打出 `#` 加任何词(比如一个编号)再按回车,消息不会发出,而是打开新建片段的设置页。GeoCode 里没有片段:`#` 不再弹出选择器,消息按输入的原样发出,计划任务与会话接口也不展开。

技能目录关掉了。它从几个写死的 GitHub 仓库浏览、安装现成的技能,这些仓库里多是编程技能,与地理数据处理关系不大;打开「技能」页时,界面还会在后台请求目录,由壳服务端向 api.github.com 查询这些仓库。GeoCode 里没有「技能目录」页,界面不再加载目录,目录、扫描与安装的接口都被拒绝,也就不再为它联网或克隆仓库。技能本身照常可用:在「技能」页新建、编辑、删除技能,agent 照常载入它们,读取的范围见第 2 节。

### 4.2 发给第三方的对话与凭据

路由关掉了。它有两部分:选「Auto」模型时,每条消息连同最近几轮对话先交给第三方的判定模型 Jev 分类,再换成这一类配置的模型;「安全网」在自动接受权限之前,把请求交给 Jev 打分。两者都把对话或文件改动发到 opencode.ai 或 typesafe.ai;它的分类是为编程任务设计的,地理数据处理用不上,安全网在 GeoCode 用的内核上也读不到要执行的命令。GeoCode 里没有路由页,模型选择器里不提供 Auto,以前存下的路由配置不起作用;权限的安全要靠内核的权限规则。

Linear 集成关掉了:它把会话接到软件团队的任务管理上,地理数据处理用不到,授权还要经过 OpenChamber 的云端中转。关掉的除了连接 Linear 的设置,还有会话完成或出错时往关联 Issue 留言,以及扩展借用这份 Linear 登录。

用量页不查询 Claude 与 Cursor 的额度。这两家的订阅不能拿到第三方应用里用,查额度却要读别的应用的凭据:Claude 读 Claude Code 存在钥匙串里的登录信息,Cursor 读它本机数据库里的登录信息。其他服务商的额度照常显示。

### 4.3 界面语言

界面语言只提供英文、简体中文与繁体中文,GeoCode 自己的界面文字只写这三种;其他语言的翻译留在源码里,以前选过的退回英文,导读的撰写语言也只在这三种里选。

### 4.4 隔离空间

OpenChamber 还在开发一个「隔离空间」功能:用 Docker 为项目起一个容器,在容器里另跑一个服务端,把这个项目的请求交给它处理。GeoCode 不需要它,而且它一打开,发往空间的请求就由容器里的服务端处理,第 3、4 节关掉的接口在那里都不起作用。上游默认关着它,也藏起了设置里的开关,但设置文件里的一个键或一个接口仍能把它打开。GeoCode 把这两条路都堵上:设置文件里即使开着,应用也不建空间、不调用 Docker,开关与空间的接口都被拒绝。

### 4.5 尚未关闭的

内核只读全局配置目录与会话目录本身(见第 2 节),但这两处的内容仍能改变 agent 的行为,下载来的项目也能带上它们:命令模板里的 `` !`命令` `` 在展开时直接执行 shell,不经权限确认;项目配置能启动 MCP 服务与格式化命令、放宽权限、改模型服务的地址,`references` 还能让内核克隆 git 仓库。接入 OpenCode Console 账号后,内核还会从 opencode.ai 拉取组织下发的服务商、远程 MCP 服务与策略,这个内核插件受保护,托管配置关不掉它。打开带配置的项目时不询问是否信任,`` !`命令` `` 也照常执行。

计划任务读取项目文件夹 `.agents/loops` 与 `~/.agents/loops` 里的 loop 文件,按其中的设置定时运行提示,开关任务时还会写回这些文件;项目文件夹上级的 loop 文件不读取,由它们生成的计划任务在下次同步时被移除。

## 5. 本机访问控制

只监听 127.0.0.1 挡不住本机:任何程序都连得上壳服务端,浏览器里的网页也能,因为 WebSocket 不受跨域限制,DNS 重绑定还能让网页以同源的身份发请求。而壳服务端转发时替调用方附上内核的口令,能调用它,就能让 agent 以用户的身份执行命令、读写文件。防护的对象是浏览器里的网页、其他用户与沙箱内的程序、扫描本机端口的脚本。以用户身份运行、不受沙箱限制的程序不在此列,它本来就能修改用户的文件与配置。

做法是让壳服务端只认 GeoCode 自己的窗口。壳服务端运行在上游的口令模式下,口令每次启动随机生成,只在主进程的内存里,没有人输入或使用它,作用只是让上游对 HTTP、WebSocket 与临时 url-token 的认证按完整逻辑执行。上游另有「无口令、只要令牌」的模式,不采用:多数 WebSocket 在那个模式下不做认证,会话 cookie 也可以伪造。主进程在进程内为窗口签发一个令牌,它不过期,但每次启动换新,只存在于主进程与窗口的内存里,磁盘上只有它的哈希。设备令牌与会话重置的接口关闭,会话 cookie 的签名密钥也每次启动随机生成,所以窗口以外没有取得令牌或会话的途径。不要求这个令牌的,只有登录状态、健康检查、版本这类状态接口与以 `state` 参数校验的 OAuth 回调;内核回调壳的通道(agent 工具与插件通知)用壳每次启动内核时另生成的令牌。

令牌之外还有两道防线。壳服务端只接受 Host 为 `127.0.0.1` 或 `localhost` 的 HTTP 请求,DNS 重绑定的网页连不需要令牌的接口也读不到;WebSocket 的升级请求不经过这道检查,而 DNS 重绑定时 Origin 与 Host 一致,Origin 检查也拦不住,所以 WebSocket 只靠令牌。内核的口令不留在壳服务端的环境变量里,壳启动的终端与其他子进程读不到它,无法绕过壳直接访问内核。令牌失效时(令牌记录被删,或启动时签发失败),界面提示重启应用,不出现上游的口令登录页。

口令模式也让上游「没有口令就不能开隧道、不能监听非本机地址」的两道保险不再起作用,第 3 节对隧道的关闭与只监听 127.0.0.1 因此不能放开。已知的例外有三个:文件预览里的 HTML 以壳服务端的来源运行,地址里带着 60 秒有效的临时令牌,页面脚本能用它读取壳服务端可读的任意文件,这是上游的设计;CORS 放行 `localhost` 与 `127.0.0.1` 的任意端口,这些端口上的网页能跨域读取不要求令牌的接口,其中健康检查会返回内核的路径与最近的错误输出;与本机安装的 OpenChamber 共用数据目录(见 `DESIGN.md` 第 4 节)时,两者的令牌记录在同一个文件里,互相有效,同时运行时还会无锁地互相覆盖,可能让 GeoCode 的窗口转到重启提示,也可能恢复 OpenChamber 刚撤销的设备。校验令牌时还会写这个文件,写不进去(磁盘满、文件无权限)时所有请求都被拒绝。

## 6. 环境变量

GeoCode 通过界面配置,不接受以环境变量给出的配置。用户环境里名字以 `OPENCODE_`、`OPENCHAMBER_`、`OTEL_`、`BUN_`、`ELECTRON_` 开头的变量,是内核、壳与两个运行时的设置:它们能把配置与数据改到别处、从指定路径加载程序、把数据发往别处(包括遥测)、打开未发布或调试用的功能,少数还会让内核起不来。打包出的应用不接受这些变量(挡不住的几个见本节末尾),按前缀认定,上游以后新增的同前缀变量也在内。其余变量是用户自己的环境,包括 `PATH`、语言、时区、代理、证书、SSH 与各种工具链的变量,照常交给内核、agent 执行的命令、MCP 与终端:agent 调用 conda、GDAL、PROJ 这些地理工具,靠的就是它们。

用户环境从两处进入应用,两处都要清理。启动环境在主进程执行的第一段应用代码里清理,那时应用还没读过它,也还没写入自己的变量;这也让「重启应用」不会把前一个进程合并进来的变量带进新进程。登录 shell 的快照在并入主进程、交给壳服务端之前清理,只清快照,不碰主进程的环境,因为后台启动时这次合并发生在应用写入自己的变量之后。应用自己的同前缀变量(壳服务端的运行参数,给内核的口令、托管配置与回调地址,内核给子进程的变量)都在清理之后写入,不受影响。开发模式的启动脚本正是用这些变量传参数,所以规则只在打包出的应用里生效。

代价有两处。上游只能用环境变量打开或调整的功能不再可用:尚未发布的 agent 记忆、内核的几个管理开关(不读项目配置、不联网获取模型目录、日志级别等)、壳的超时与上限(取上游默认值),内核的 OpenTelemetry 遥测也完全关闭;OpenCode 自家模型服务的密钥 `OPENCODE_API_KEY` 不再从环境识别,改在服务商页填写。agent 执行命令时新开的 shell 只重读 `~/.zshenv`,用户写在 `.zshrc` 里、同样以这些前缀开头的工具变量(例如 `ELECTRON_MIRROR`、`BUN_CONFIG_REGISTRY`、用户自己程序的 `OTEL_*`)在那里看不到,需要时写进 `~/.zshenv` 或工具自己的配置文件;应用内的终端会重读 `.zshrc`,不受影响。

还有几处没有处理。其余模型服务的密钥仍从环境里自动识别,配置文件里的 `{env:名字}` 仍能读取任意变量,两者留到内核装配时决定。有几个 `ELECTRON_` 变量由 Electron 在应用代码运行之前读取,清理挡不住:`ELECTRON_RUN_AS_NODE` 让应用根本不执行自己的代码,`ELECTRON_DISABLE_SANDBOX` 关掉渲染进程的沙箱,`ELECTRON_ENABLE_LOGGING` 等输出 Chromium 的日志。它们只在从终端启动、或以 `launchctl setenv` 设置时出现在启动环境里,写在 `.zshrc` 里的来得太晚,不起作用;留到打包那一站处理,其中 `ELECTRON_RUN_AS_NODE` 能用 Electron fuses 关掉,但本地听写靠它启动子进程,要先改用 `utilityProcess`(扩展的服务进程原本也靠它)。Windows 上壳服务端自己用 PowerShell 读取用户环境,不经过这里的清理,双平台打包时要补上。代理变量只有内核认,壳不认,这是上游的行为,保持原样。

## 7. 实现与维护

本节的路径以 `desktop/packages/` 为起点,内核的路径从仓库根目录写起。GeoCode 自己的代码放在各包的 `geocode/` 目录里;对上游的补丁怎样标记、怎样列出,见 `CONVENTIONS.md` 第 3.4 节。

壳服务端的补丁多数以 `process.versions.electron` 判断是否在桌面应用里,以 `serve --stdio` 启动内核的补丁(`web/server/lib/opencode/lifecycle.js`)例外,对 OpenChamber 的所有运行方式都生效;界面以 `ui/src/geocode/surface.ts` 的 `isGeoCodeDesktop` 判断,设置页与搜索项以设置上下文的 `isDesktop` 判断。`electron:dev` 在 Electron 之外另起一个壳服务端,壳服务端的这类补丁与访问控制在那里不生效,验证要用 `electron:dev:bundled` 或打包出的应用;环境变量的清理只在打包出的应用里生效。关闭接口、主机名检查、用量的服务商、扩展、路由、代码片段与壳的配置范围各有测试,运行方法见 `DEVELOPMENT.md` 第 7 节;内核的配置来源也有测试,是 `kernel/packages/core/test/` 下 `config/config.test.ts`、`config/skill.test.ts`、`instruction-discovery.test.ts`、`session-instructions.test.ts` 里的 `GeoCode:` 用例与 `kernel/packages/server/test/geocode/profile.test.ts`;上游测试里断言上游这些行为的几项会失败,见 `CONVENTIONS.md` 第 4 节。

关闭与访问控制依靠几份手写的清单,也依赖上游口令模式的行为,上游新增的内容不会自动被覆盖。合并 `chamber-upstream` 之后,重新推导并对照:

- 关闭的接口(`web/server/geocode/closed-surface.js`):在壳服务端里找 `app.get`、`app.post` 等方法与 `app.use` 注册的路径,以及 `server.on('upgrade'` 的处理器,属于第 3、4 节关掉的机制或上游功能的,加进清单;新的 WebSocket 处理器在口令模式下要校验令牌。同一路径上还有别的路由在用时,只关那一个方法、那一条完整路径,另列在 `CLOSED_ROUTES`。
- 关闭的 IPC 命令(`electron/geocode/closed-commands.mjs`):`main.mjs` 里 `handleInvoke` 的命令,以及 `ipcMain.handle` 与 `ipcMain.on` 的频道。
- 不接受的环境变量按前缀认定(`electron/geocode/inherited-env.mjs`),上游新增的同前缀变量自动在内,要找的是另一种前缀的配置变量,例如新引入的运行时或库自带的。
- 隐藏的设置(`ui/src/geocode/settings.ts`):`SETTINGS_PAGE_METADATA` 与 `SETTINGS_SEARCH_ITEMS`;设置会重开上次的页面、也跟随 `?settings=` 链接,两者都不查页面是否可用,而带侧栏的页面只有主体受可用性约束,所以 `ui/src/components/views/SettingsView.tsx` 把停在 `CLOSED_PAGES` 里某一页上的设置转到「通用」,也不渲染它的侧栏、不为它加载数据(侧栏在跳转之前就会挂载并自己加载);路由页不在这份清单里,它由上游的可用性开关隐藏,没有侧栏,停在它上面时只显示「不可用」。
- 侧栏面板(`ui/src/geocode/surface.ts` 的 `CLOSED_SURFACES`):`ui/src/lib/surfaces/registry.ts` 的 `CONTEXT_SURFACES`;被恢复或被扩展打开的 Linear 面板,靠 `ui/src/components/layout/ContextPanelRail.tsx` 里集成断开时关掉面板的那段逻辑关掉。
- 扩展按「一个也没装」关掉:壳服务端里凡是要找到一个扩展才能运行它的地方(面板页、服务进程、共享画面、内置浏览器的转交),都经 `web/server/lib/guests/catalog.js` 的 `listInstalledGuests`,它在桌面应用里返回空,新代码若直接读 `extensions.json`(`web/server/lib/guests/persist.js` 的 `readExtensionStore`)来启动扩展,就绕过了它;安装、上传与检查更新不经这份列表,靠关闭 `/api/guests` 挡住;界面的扩展入口都从 `ui/src/lib/guests/store.ts` 的扩展清单派生,清单只由 `ui/src/lib/guests/load-catalog.ts` 填入,桌面应用里填入空清单、不发请求。
- 插件页:界面里找 `usePluginsStore` 的调用处,写入与 npm 查询都经 `/api/config/plugins`;插件的更新检查与升级是内核的 `/api/plugin/check`、`/api/plugin/update`,经壳服务端转发,这两条也关了,只读的 `/api/plugin` 保留。
- 魔法提示词:改写只经 `/api/magic-prompts` 读写,这组接口关闭;界面读改写只经 `ui/src/lib/magicPrompts.ts` 的 `fetchMagicPromptOverrides`,桌面应用里直接返回没有改写,不发请求。
- 代码片段:壳服务端的片段都经 `web/server/lib/opencode/snippets.js` 的 `loadSnippetRegistry` 读取(界面的展开、计划任务、会话接口的展开都经它),桌面应用里为空,`/api/config/snippets` 关闭;界面的 `#` 选择器有三处触发(在界面里找 `SnippetAutocomplete` 的使用处),`ui/src/components/chat/composer/language/triggers.ts`、`ui/src/components/multirun/MultiRunLauncher.tsx` 与 `ui/src/components/session/ScheduledTaskEditorDialog.tsx` 的 `updateAutocompleteState`,发送前的展开只经 `ui/src/stores/useSnippetsStore.ts` 的 `expandText`,桌面应用里都不起作用。
- 技能目录:界面加载目录经 `ui/src/stores/useSkillsCatalogStore.ts` 的 `loadCatalog`(`ui/src/components/views/SettingsView.tsx` 打开「技能」页时、`ui/src/stores/catalogRefresh.ts` 与 `ui/src/stores/useAgentsStore.ts` 刷新配置时都调用它),桌面应用里直接返回,不发请求;其余的目录请求(`loadSource`、`scanRepo`、`installSkills`)只由已隐藏的技能目录页及其对话框发出。壳服务端关闭 `/api/config/skills/catalog/source`,以及 `/api/config/skills/catalog` 的 GET、`/api/config/skills/scan` 与 `/api/config/skills/install` 的 POST:这三条路径上的其他方法和下级路径是对名叫 `catalog`、`scan`、`install` 的技能的读写,上游照常可用。「技能」页经 `/api/config/skills` 的其余接口读写技能,不受影响。
- 路由:界面的路由入口(设置页、搜索项、命令面板、Auto 选项)都看 `routingFeatureAvailable`,它由 `web/server/lib/opencode/settings-helpers.js` 下发,桌面应用里为假;在界面里找 `routingFeatureAvailable` 的读取处;壳服务端的路由逻辑(Auto 的解析、安全网)都经 `web/server/lib/routing/store.js` 的 `readConfig` 读配置,桌面应用里一律得到默认的关闭状态,新代码若直接读 `routing.json`(`routingConfigPath`),就绕过了它;`/api/routing` 关闭。
- 隔离空间:空间的一切行为都挂在 `web/server/index.js` 的 `spacesHost` 上(请求中间件、WebSocket 升级、会话列表的合并、目录的拒绝)。在 `index.js` 里找 `spacesHost` 的赋值处:启动时读 `isolatedSpacesEnabled` 后调用 `buildSpacesHost`,这一处在桌面应用里跳过;开关接口经 `createSwitchController` 的 `setHost`,开关所在的 `/api/openchamber/spaces` 与发往空间的 `/api/spaces` 关闭。新代码若不经 `spacesHost` 直接用 `web/server/lib/spaces/` 起空间或调用 Docker,就绕过了这层。设置里的开关现在由上游 `ui/src/lib/spaces/release.ts` 的 `ISOLATED_SPACES_RELEASED` 藏着,它变真之后,开关的设置行与搜索项要加进隐藏的设置。
- 内核的配置来源:GeoCode 的替换清单在 `kernel/packages/server/src/geocode/profile.ts`,由 `kernel/packages/server/src/process.ts` 在启动时交给 `createRoutes`,换掉插件来源(`ConfigPluginSource`,只看托管配置)与远程配置(`WellKnown`,为空);另有四处补丁,在 `kernel/packages/core/src/` 下:`config/discovery.ts` 不往上找、不给其他应用的目录,`config/plugin/instruction.ts` 的 `AGENTS.md` 只读会话目录,`config/plugin/skill.ts` 不读配置里的 `skills` 列表,`tool/plugin/read.ts` 读到会话目录之外的文件时不载入附近的 `AGENTS.md`。托管配置由壳以 `OPENCODE_CONFIG` 传入,插件的规则靠这一点:开发模式下用户环境若已设了 `OPENCODE_CONFIG`,壳改用 `OPENCODE_CONFIG_CONTENT` 注入工具,内核就不加载壳的工具,却会按用户那份文件的 `plugins` 加载。合并 `kernel-upstream` 之后,在 `kernel/packages/core/src/config/` 与 `kernel/packages/core/src/plugin/` 里找新的读取目录、向上查找(`fs.up`)、增加技能(`ctx.skill.transform`)与加载插件的地方;替换掉的两个服务若改了接口,替换也跟着改。
- 壳的配置范围:`web/server/lib/opencode/shared.js` 的 `findWorktreeRoot` 在桌面应用里直接返回会话目录,它的调用处都拿它当往上查找的终点(技能、agent、命令、网页搜索设置里的项目覆盖,以及计划任务读取的 `.agents/loops`),所以都只看起点目录本身:会话目录,计划任务则是项目文件夹。`web/server/lib/opencode/skills.js` 里 `getClaudeSkillDir`、`getUserClaudeSkillDir`、`getUserAgentsSkillDir`、`getProjectAgentsSkillDir` 在桌面应用里指向 OpenCode 的对应目录,查找、显示来源、新建与删除都经它们;列表(`discoverSkills`)直接拼路径,改由 `web/server/geocode/kernel-skills.js` 给出;`updateSkill` 拒绝两处之外的目标路径(界面只传列表里的路径,接口能传任意路径)。有一处连带:一个技能同时有 `skills/` 与旧名 `skill/` 两份时,删除会两份都删,日志把第二份标成 claude-compat 或 agents 的目录。界面的新建位置在 `ui/src/components/sections/skills/SkillsPage.tsx` 里只留 OpenCode 的两个。合并 `chamber-upstream` 之后,在壳服务端找新的 `.claude`、`.agents` 路径、`os.homedir()` 下的配置目录,以及不经 `findWorktreeRoot` 的往上查找;已知的几处不必再改:`web/server/lib/opencode/skills.js` 的 `getManagedSkillRoots` 只判断 `discoverSkills` 找到的技能能否改名,`web/server/lib/opencode/shared.js` 的 `resolveSkillSearchDirectories` 只被 `discoverSkills` 里已跳过的上游代码使用,`web/server/lib/opencode/skill-routes.js` 的 `findWorktreeRootForSkills` 与 `inferSkillScopeAndSourceFromPath` 只给内核列出的技能标注来源,`web/server/lib/scheduled-tasks/loops.js` 的 `~/.agents/loops` 见第 4.5 节,`web/server/lib/skills-catalog/install.js` 的接口已关闭。
- 用量的服务商(`ui/src/geocode/quota.ts` 与 `web/server/geocode/closed-quota.js`,两份要一致):界面的 `ui/src/lib/quota/providers/index.ts` 的 `QUOTA_PROVIDERS`,壳服务端的 `web/server/lib/quota/providers/index.js` 的 `registry` 与 `web/server/lib/quota/credentials/providers.js` 的 `normalizers`;上游新增的服务商要读别的应用的凭据时,加进两份清单;`web/server/lib/quota/index.js` 还直接导出 `fetchClaudeQuota`、`fetchCursorQuota`,现在没有调用者,以后有了会绕过 `registry`。
- 自动外发:在壳服务端、界面与 `main.mjs` 里找 `openchamber.dev`、`github.com/openchamber` 等地址。
- 唯一入口仍然唯一:推送只经 `web/server/lib/notifications/runtime.js` 的 `fanoutPush`,深链只经 `electron/main.mjs` 的 `handleDeepLinks`,窗口取令牌只经 `main.mjs` 的 `readDesktopLocalClientToken`,会话密钥只来自 `web/server/lib/ui-auth/ui-auth.js` 的 `getOrCreateJwtSecret` 与 `rotateJwtSecret`。用户环境只从两处进入:启动环境在 `electron/early-startup.mjs` 的模块顶层清理,在它之前执行的代码都不能在加载时读写 `process.env`,包括它 import 的外部模块(打包时不内联、先于它执行,如 `@openchamber/web/server/lib/inherited-env.js`)与打包产物 `electron/dist-bundle/early-startup.mjs` 里排在它前面的内联代码;登录 shell 的快照由 `main.mjs` 的 `inheritUserShellEnv` 清理,壳服务端只经 `provideLoginShellEnvSnapshot` 拿到它,不自己再读登录 shell(Windows 除外)。
- 上游的行为没有变:`createClient` 不传 `expiresAt` 时不过期;令牌不经渲染进程的命令行参数(`electron/early-startup.mjs` 的 `buildRendererAdditionalArguments`);`ui/src/components/auth/SessionAuthGate.tsx` 只在 `locked` 状态显示口令表单;Linear 的界面入口大多以运行时模块 `linear` 是否存在为条件(如 `ui/src/components/sections/integrations/IntegrationsPage.tsx` 的 `hasLinear`),不以它为条件的新入口要另外关掉;侧栏里嵌入的会话聊天仍是主窗口里同源、没有 preload 的 iframe(`ui/src/geocode/surface.ts` 的 `isGeoCodeDesktop` 靠读它的父窗口判断);语言的选项只来自 `ui/src/lib/i18n/context.tsx` 的 `locales`(设置页与导读的选择器都用它),`setLocale` 只由 `ui/src/lib/i18n/store.ts` 的 `initializeLocale` 与设置页调用,桌面版读回保存的语言只经 `ui/src/lib/i18n/runtime.ts` 的 `readStoredLocale`(`ui/src/geocode/languages.ts` 在这两处过滤)。
- `web/server/lib/opencode/compatibility.js` 的 `MINIMUM_OPENCODE_VERSION` 不高于 `kernel/` 的版本,否则壳会拒绝安装包里的内核。

## 8. 验收

在没有安装 OpenCode 的环境里,打包出的应用启动后可以直接对话,用的是 `kernel/` 构建的内核,即使 `PATH`、设置或环境变量指向别的 `opencode` 也一样;内核缺失时报错。正常退出与强制结束之后,都没有残留的内核进程;agent 执行的命令与应用内的终端都读不到内核的口令。

对外边界与屏蔽的上游功能:

- 设置与界面里没有远程、局域网、配对、隧道等入口(侧栏里嵌入的会话聊天也一样),对应的接口与 IPC 命令被拒绝,路径换了大小写也一样;`openchamber://` 链接不被处理。
- 设置文件里开着隔离空间时,应用也不建空间、不调用 Docker,开关与空间的接口被拒绝。
- 设置与界面里没有 Linear、扩展、路由、插件、魔法提示词、代码片段与技能目录的入口;远程实例、隧道、扩展、插件、魔法提示词、代码片段与技能目录页即使是上次停留的页面或链接指向的页面,打开设置时也显示「通用」。
- 数据目录里已经装好的扩展既不显示也不运行;开着路由的 `routing.json`、`magic-prompts.json` 与全局和项目的片段文件都不起作用:模型选择器里不提供 Auto,不向 Jev 发请求,输入框里的 `#名字` 不弹出选择器、不展开。
- 对话里只有全局配置目录与会话目录本身的 `AGENTS.md` 与技能,以及读到会话目录里的文件时顺带载入的子目录 `AGENTS.md`:项目上级目录与主目录本身的配置、会话目录之外的 `AGENTS.md`、`.claude` 与 `.agents` 里的技能、配置列出的技能路径和网址都不进入对话,插件目录与配置列出的插件不执行;壳注入的工具照常,开关不用重启即生效。
- 「技能」页只列出全局配置目录与会话目录 `.opencode/` 里的技能和内核自带的技能;删除技能不碰 `.claude`、`.agents` 里的同名技能,新建时只有 OpenCode 的两个位置;agent、命令与网页搜索设置不读会话目录上级的配置。
- 打开「技能」页不请求技能目录,不向 api.github.com 查询;技能照常新建、编辑、删除,名叫 `catalog`、`scan`、`install` 的技能,能做的与上游相同。
- 生成提交信息、解决冲突、斜杠命令与新聊天的起始按钮照常可用。
- 用量页里没有 Claude 与 Cursor,也不读取它们的凭据。
- 语言选择里只有英文、简体中文与繁体中文,保存过其他语言的,启动后显示英文。
- 与本机 OpenChamber 共用数据目录时,它设置里的局域网开关、界面口令、主机列表,以及数据目录里的推送订阅,都不起作用。
- 运行期间,应用不自动向 OpenChamber 的服务器发出请求,以监视应用进程的对外连接来确认。

不带令牌的 HTTP 请求与 WebSocket 连接(终端、事件流、听写等)都被拒绝,伪造的或 OpenChamber 签发的会话 cookie 不被接受,Host 不是 `127.0.0.1` 或 `localhost` 的 HTTP 请求被拒绝。窗口带着令牌时,对话、终端、文件预览、迷你聊天、内置浏览器与 agent 的工具回调都正常;令牌失效时显示重启提示,而不是登录页。

打包出的应用从带着第 6 节那些前缀变量的环境启动(Electron 自己先读的几个 `ELECTRON_` 变量除外),或登录 shell 导出了它们,应用的行为都不变:内核照常启动(即使设了 `BUN_BE_BUN`、`OPENCODE_SSH_ASKPASS_PORT`),数据与配置留在原来的位置,内核与 agent 执行的命令里看不到这些变量,后台启动与内核重启之后也一样。其余变量与 `PATH` 照常到达内核与 agent 执行的命令。
