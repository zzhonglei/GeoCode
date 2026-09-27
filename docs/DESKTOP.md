# 桌面应用

本文档说明 GeoCode 怎样把 OpenCode 与 OpenChamber 组装成一个应用:由哪些进程组成、内核怎样托管、内核怎样构建与打包、应用对外的边界在哪里、本机上谁能访问应用。

## 1. 组成与进程

GeoCode 是一个应用,安装、启动、退出都只有一个入口。用户不需要另装 OpenCode,也感知不到两个上游的存在。

```
Electron 主进程
 ├─ 壳服务端(OpenChamber 的服务端,在主进程内运行)
 │    └─ 子进程:内核(OpenCode,serve --stdio)
 └─ 界面(渲染进程)── HTTP / SSE ──→ 壳服务端
```

- 界面只与壳服务端通信。壳服务端把内核的接口代理给界面,并在转发时附上内核的口令;界面拿不到这个口令。
- 两个服务都只监听 127.0.0.1。壳服务端只接受 GeoCode 自己的窗口(见第 5 节)。

## 2. 内核的托管

内核是壳的私有组件:只由这个壳启动、只为这个壳服务,随壳退出。

壳以 `serve --stdio` 启动内核。这是 OpenCode 为私有内核设计的运行方式,OpenCode 自己的终端界面启动私有内核时也用它:

- 口令由壳在每次启动内核时随机生成,以 `OPENCODE_PASSWORD` 显式传给内核,优先于用户环境里导出的同名变量。
- 内核读取口令后,把两个口令变量从自己的环境里删除,agent 执行的命令读不到它。
- 内核把标准输入当作租约:标准输入关闭就退出。壳被强制结束时,操作系统同样会关闭这根管道,所以不会留下无主的内核进程。

不采用的两种方式:

- 普通 `serve`(上游 OpenChamber 的做法):口令留在内核的环境里,会被 agent 执行的命令继承,也会被用户导出的 `OPENCODE_PASSWORD` 覆盖。
- `serve --service`(OpenCode 桌面版的做法):每个用户共用一个常驻后台的服务,应用退出后仍在运行,默认还与用户自己安装的 OpenCode 共用服务与数据。

## 3. 内核的构建与打包

- 安装包里的内核由本仓库的 `kernel/` 构建,是单文件可执行程序,与 `kernel/` 的版本一致。上游 OpenChamber 在打包时从 npm 下载 OpenCode 发布的内核,GeoCode 不用这一步,否则对内核的修改进不了安装包。构建与暂存的方法见 `DEVELOPMENT.md`;暂存脚本是 POSIX sh,只有 macOS 的打包流程能用。
- 壳只使用安装包里的内核:不读取设置里的内核路径,不读取环境变量指定的内核,不在 `PATH` 里查找。内核缺失或启动失败时报错,不引导用户安装 OpenCode。
- 主机只有本机,所以启动时不出现上游「选择本地或远程」的首次引导。只有本机的壳服务端起不来时,上游仍会显示引导页;页上的安装 OpenCode、设置内核路径、连接远程都不起作用,只能重启应用。

## 4. 对外边界

GeoCode 是单机、单用户的应用。让其他设备连进来的机制,以及连到本机内核以外主机的机制,一律关闭:

- 入站:局域网访问、用户设置的界面口令、设备配对与二维码、Private Relay、公网隧道(cloudflared、ngrok)。dev-tunnel 与设备令牌只能经这些入口从其他设备使用,随之失效;设备令牌的接口 `/api/client-auth` 一并关闭,本机窗口的令牌见第 5 节。
- 出站:多主机与主机切换、SSH 远程实例、连接外部内核、安装与升级 OpenCode、OpenChamber 的更新检查与使用上报、推送(网页推送与 APNs)。
- `openchamber://` 深链:不注册,也不处理。

移动端、VS Code 扩展、独立的网页服务(包括安装为 PWA)与 `openchamber` 命令行不构建、不打包;用户只通过 GeoCode 的窗口操作应用。关闭的方式遵循 `DESIGN.md` 的「边界靠装配,不靠删除」。

模型服务的连接(各家 LLM 的接口)是内核的正常工作,不在此列。OpenChamber 其余的集成功能(GitHub、Linear、技能目录、模型目录、内置浏览器等)的去留,另行决定。

## 5. 本机访问控制

壳服务端只监听 127.0.0.1,但本机的任何程序都能连上它,浏览器里的网页也能:WebSocket 不受跨域限制,DNS 重绑定还能让网页以同源的身份发请求。壳服务端转发时替调用方附上内核的口令,所以能调用壳服务端,就能让 agent 以用户的身份执行命令、读写文件。

- 壳服务端只接受 GeoCode 自己的窗口:每个 HTTP 请求与 WebSocket 连接都要出示令牌,没有令牌的一律拒绝。例外见 6.3 节。
- 令牌由主进程在每次启动时签发,只存在于主进程与窗口的内存里,磁盘上只有它的哈希;下次启动换新,旧的随之作废。窗口以外没有取得令牌的途径:用户不设置口令,也不登录。例外是窗口里预览的 HTML 文件,见 6.3 节。
- 壳服务端只接受 Host 为 `127.0.0.1` 或 `localhost` 的 HTTP 请求,DNS 重绑定的网页连不要求令牌的接口也读不到。
- 令牌失效时(例如数据目录里的令牌记录被删,或启动时签发失败),界面显示错误并提示重启应用,不显示上游的口令登录页。
- 内核的口令只交给内核,不留在壳服务端的环境变量里:壳启动的终端与其他子进程读不到它,不能绕过壳直接访问内核。

防护的对象是浏览器里的网页、其他用户与沙箱内的程序、扫描本机端口的脚本。以用户身份运行、不受沙箱限制的程序不在此列:它本来就能修改用户的文件与配置。

## 6. 实现

本节的路径以仓库根目录为起点。

补丁生效的范围:

- 壳服务端的补丁以 `process.versions.electron` 判断是否在桌面应用里(壳服务端在 Electron 主进程内运行);Electron 主进程的补丁本来只在桌面应用里运行。
- 界面以 `desktop/packages/ui/src/geocode/surface.ts` 的 `isGeoCodeDesktop` 判断,设置页与搜索项以设置上下文的 `isDesktop` 判断。
- 以 `serve --stdio` 启动内核的补丁对 OpenChamber 的所有运行方式都生效,包括网页服务:内核随壳服务端退出,就绪行是 JSON。
- `electron:dev` 在 Electron 之外另起一个壳服务端,`process.versions.electron` 在那里不成立,壳服务端的补丁都不生效;环境变量的清洗只在 Electron 主进程里做,那个壳服务端仍会读用户导出的变量;它也不由主进程启动,没有口令,不做第 5 节的访问控制。验证用 `electron:dev:bundled` 或打包出的应用。

### 6.1 内核

- `desktop/packages/electron/package.json` 的 `prepare:opencode-cli` 调用 `scripts/stage-kernel.sh`,打包流程因此取 `kernel/` 构建的内核。开发启动时,`electron-dev.mjs` 发现暂存的内核,以 `OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR` 交给壳。上游的 `verify:opencode-cli` 用 `opencodeCli.version`(上游固定的 npm 发布版本)核对暂存的内核,与 `kernel/` 的版本不符,不适用。
- `desktop/packages/web/server/lib/opencode/lifecycle.js` 的 `createManagedOpenCodeServerProcess` 以 `serve --stdio` 启动内核,标准输入保持为管道;就绪行由 `desktop/packages/web/server/geocode/stdio-kernel.js` 解析。`startOpenCodeOnce` 在内核的环境里写入 `OPENCODE_PASSWORD`。
- `desktop/packages/web/server/lib/opencode/env-runtime.js`:`resolveOpencodeCliPath` 只返回安装包里的内核,`applyOpencodeBinaryFromSettings` 不读设置里的路径,`resolveManagedOpenCodeLaunchSpec` 在没有内核路径时报错,而不是退回 `PATH` 上的 `opencode`。
- `desktop/packages/electron/geocode/inherited-env.mjs` 在 `main.mjs` 的 `inheritUserShellEnv` 里,从进程环境与登录 shell 的环境快照中删去会把壳指向其他内核、其他主机或其他口令的变量(`OPENCODE_BINARY`、`OPENCODE_HOST`、`OPENCHAMBER_SERVER_URL`、`OPENCODE_PASSWORD` 等);打包出的应用还删去 `OPENCHAMBER_BUNDLED_OPENCODE_CLI_DIR`。
- `main.mjs` 的 `readDesktopHostsConfig` 只返回本机,不读设置里的主机列表。

### 6.2 对外边界

- 壳服务端(`desktop/packages/web/server`):
  - `geocode/closed-surface.js` 在 `index.js` 的 `main` 里、`express()` 创建后立即挂载,对设备令牌、配对与连接候选(`/api/client-auth`)、Private Relay、隧道与隧道引导(`/connect`)、推送订阅、Passkey、OpenChamber 更新、OpenCode 的升级检查、升级与安装、重置会话密钥(`/api/auth/reset`)的路径回 404。这些路径必须由壳自己回答,因为未匹配的 `/api` 路径会落到内核代理。比较不区分大小写,与 Express 的路由一致。`geocode/closed-surface.test.js` 验证大小写与结尾斜杠的变体也被拦下,在 `desktop/packages/web` 里以 `bun run test -- server/geocode/closed-surface.test.js` 运行。
  - `lib/relay/service.js` 的 `createRelayService` 在桌面里返回 `geocode/inert-relay.js` 的替身:不生成中继身份、不连接中继、不注册路由。
  - `lib/notifications/runtime.js` 的 `fanoutPush` 不发送网页推送与 APNs,磁盘上已有的订阅也不用。
- Electron 主进程(`desktop/packages/electron/main.mjs`):
  - `spawnLocalServer` 忽略设置里的局域网开关与界面口令,服务只监听 127.0.0.1。
  - `desktop/packages/electron/geocode/closed-commands.mjs` 由 `handleInvoke` 在入口调用,拒绝主机、SSH、dev-tunnel、局域网地址与更新相关的 IPC 命令。
  - 不注册 `openchamber://`,`handleDeepLinks` 直接返回。
  - 菜单里没有「Check for Updates」;`setupAutoUpdater` 仍按上游配置更新源,但没有入口触发检查。
- 界面(`desktop/packages/ui/src`):
  - `geocode/settings.ts` 由 `lib/settings/metadata.ts` 与 `lib/settings/search.ts` 调用,隐藏远程实例与隧道两个设置页,以及口令、局域网、内核路径、重启 OpenCode、OpenCode 更新提示、使用上报的搜索项。
  - 按 `isGeoCodeDesktop` 隐藏的组件:`OpenChamberPage` 的 `OpenCodeCliSettings` 整块(内核路径、OpenCode 更新提示、重启 OpenCode;命令面板的重启 OpenCode 保留)与使用上报开关,`DesktopNetworkSettings` 的口令与局域网字段,`Header` 的服务菜单,`DesktopHostSwitcherInline`。
  - 自动发出的请求在源头停止:`useUpdateStore.checkForUpdates`、`warmDesktopHostStatuses`、`useDesktopSshStore.load`。`OpenCodeUpdateToast` 仍会向已关闭的升级检查接口请求至多三次,拿到 404 后放弃。
  - About 对话框读的是已关闭的升级检查接口,所以不显示内核版本。

### 6.3 本机访问控制

- 壳服务端以上游的口令模式运行。`desktop/packages/electron/geocode/local-access.mjs` 在主进程启动时生成随机口令,`main.mjs` 的 `spawnLocalServer` 只经 `startWebUiServer` 的 `uiPassword` 传入,不写进环境变量。口令模式下,上游对 `/api` 的认证、各 WebSocket 的认证与 Origin 检查、url-token 都按完整逻辑执行。上游另有「无口令、只要客户端令牌」的模式(`createUiAuth` 的 `requireClientAuth`),不采用:多数 WebSocket 的处理器在无口令时不做认证,无口令分支的 `resolveAuthContext` 还把任意值的会话 cookie 当作已登录。
- 令牌:`spawnLocalServer` 在服务起来后调用 `mintLocalClientToken`,经 `startWebUiServer` 返回的 `remoteClientAuthRuntime` 在进程内创建 `desktop-local` 客户端,不设过期时间。不经 HTTP 登录签发,所以不受登录接口限流的影响,`/api/client-auth` 也可以整个关闭,令牌只能这样产生。`dedupeKey` 取 `geocode-desktop`:每次启动替换上一次的记录,也不与数据目录里 OpenChamber 自己的桌面客户端互相替换。`readDesktopLocalClientToken` 返回这个令牌,不读设置里的 `desktopLocalClientToken`,主窗口、新窗口、迷你聊天与 IPC `desktop_local_client_token_get` 都从这里取。
- 令牌经注入页面的脚本交给窗口(`buildInitScript` 与 `injectRuntimeConfigIntoHtml`)。`early-startup.mjs` 的 `buildRendererAdditionalArguments` 不把它放进渲染进程的命令行参数,那里本机的其他程序用 `ps` 就能读到。
- 会话 cookie 的签名密钥在桌面里每次启动随机生成,只在内存里(`desktop/packages/web/server/lib/ui-auth/ui-auth.js` 的 `getOrCreateJwtSecret`),不读 `OPENCODE_JWT_SECRET` 与数据目录里的 `jwt-secret`。另一个会写这个文件的入口 `/api/auth/reset`(`rotateJwtSecret`)在桌面里关闭。没有人登录,也就没有会话;OpenChamber 签发的会话在这里无效。
- 界面:`SessionAuthGate` 在桌面里遇到 401 时显示 `desktop/packages/ui/src/geocode/SessionLostNotice.tsx`,提示重启应用,按钮调用 `desktop_restart`,不显示口令表单;使用中途上游判定会话过期,或用户点了横幅上的「重新登录」时,再查一次 `/auth/session`:仍为 401 就转到这个提示,通过就清除过期状态。
- 不要求令牌的:登录与登录状态(`/auth/session`)、健康检查、版本、`/api/system/info`、`/api/system/free-port`、界面的静态文件,以及以 `state` 参数校验的 OAuth 回调。内核回调壳的 agent 工具与插件通知,用壳在每次启动内核时生成的另一个令牌。健康检查返回内核的路径与最近的错误输出;CORS 放行 `localhost` 与 `127.0.0.1` 的任意端口,本机这些端口上的网页可以读到它。
- 口令模式的附带效果:上游「没有口令就不能开隧道、不能监听非本机地址」的两道保险不再起作用,由第 4 节关闭的隧道接口与固定的 127.0.0.1 覆盖;每个带令牌的请求都读一次 `remote-clients.json`,20 个并发时,带令牌的轻量请求中位延迟约 3 毫秒;校验时每分钟写一次 `lastUsedAt`,写不进去(磁盘满、文件无权限)时校验失败,所有请求都会被拒。
- 与本机安装的 OpenChamber 共用数据目录时,令牌记录在同一个 `remote-clients.json` 里:它签发的令牌在 GeoCode 的壳上同样有效;两边同时运行时无锁地读改写这个文件,可能丢失 GeoCode 的记录(窗口转到重启提示),也可能恢复 OpenChamber 刚撤销的设备。
- 文件预览里的 HTML 以壳服务端的来源运行,地址里带着 60 秒有效的 url-token;页面脚本能用它读取可读路径下的任意文件、打开事件流(上游的设计)。

### 6.4 合并上游后的核对

内核的选择与对外的关闭都依靠手写的清单与唯一入口,上游新增的变量、入口与请求不会自动被覆盖。合并 `chamber-upstream` 之后,按下面的方法重新推导,与现状对照:

- `closed-surface.js` 的路径:在 `desktop/packages/web/server` 里找 `app.get`、`app.post`、`app.put`、`app.patch`、`app.delete`、`app.all`、`app.use` 注册的路径,以及 `server.on('upgrade'` 的处理器,筛出属于第 4 节各机制的。
- `closed-commands.mjs` 的命令:`main.mjs` 里 `handleInvoke` 的 `case 'desktop_…'`,以及它之外的 `ipcMain.handle` 与 `ipcMain.on` 频道。
- `inherited-env.mjs` 的变量:`env-config.js`、`env-runtime.js` 的 `resolveOpencodeCliPath` 与 `bundledOpenCodeCliCandidates`、`hmr-state-runtime.js`、`auth-state-runtime.js`,以及 `main.mjs`(`resolveInitialUrl`、`shouldSkipLocalServer` 等)读取的环境变量。
- `settings.ts` 的页面与搜索项:`metadata.ts` 的 `SETTINGS_PAGE_METADATA` 与 `search.ts` 的 `SETTINGS_SEARCH_ITEMS`。
- 唯一入口:`fanoutPush` 仍是网页推送与 APNs 唯一的发送处,`handleDeepLinks` 仍是深链唯一的入口。
- 新增的自动外发:在壳服务端、界面与 `main.mjs` 里找 `openchamber.dev`、`github.com/openchamber` 等 OpenChamber 的地址,看有没有不经用户操作就发出的请求。
- `desktop/packages/web/server/lib/opencode/compatibility.js` 的 `MINIMUM_OPENCODE_VERSION` 不能高于 `kernel/` 的版本,否则壳会拒绝安装包里的内核。
- 本机访问控制依赖上游口令模式的行为:`server.on('upgrade'` 的每个处理器在 `uiAuthController.enabled` 时校验令牌与 Origin,新增的处理器照此核对;`readDesktopLocalClientToken` 仍是窗口取本机令牌的唯一入口;令牌没有其他途径进入命令行参数;`createClient` 不传 `expiresAt` 时仍不过期;会话密钥仍只来自 `getOrCreateJwtSecret` 与 `/api/auth/reset` 背后的 `rotateJwtSecret`;`SessionAuthGate` 显示口令表单的仍只有 `locked` 状态。

## 7. 验收

- 在没有安装 OpenCode 的环境里,打包出的应用启动后可以直接对话。
- 使用的内核是 `kernel/` 构建的那一个:即使 `PATH` 里有其他 `opencode`、设置里写了其他内核路径、环境变量指定了其他内核,也不例外。安装包里的内核缺失时报错,不运行其他 `opencode`。
- 正常退出与强制结束壳之后,都没有残留的内核进程。
- agent 执行的命令读不到内核的口令。
- 设置与界面里没有远程、局域网、配对、隧道等入口;对应的接口与 IPC 命令被拒绝,路径换了大小写也一样;`openchamber://` 链接不被处理。
- 与本机安装的 OpenChamber 共用数据时,它的设置里的局域网开关、界面口令、主机列表,以及数据目录里的推送订阅,都不起作用。
- 运行期间,应用不自动向 OpenChamber 的服务器发出请求,以监视应用进程的对外连接来确认。用户主动使用的集成(如 Linear 的授权)随集成的去留另行决定。
- 不带令牌的 HTTP 请求与 WebSocket 连接(终端、事件流、听写等)都被拒绝,会话 cookie(伪造的,或 OpenChamber 签发的)也不被接受;Host 不是 `127.0.0.1`、`localhost` 的 HTTP 请求被拒绝。
- 窗口带着令牌时,对话的流式输出、终端、文件与图片预览、迷你聊天、内置浏览器、agent 的工具回调都正常。
- 令牌失效时显示错误页,不出现口令登录页。
- 应用内的终端读不到内核的口令。
