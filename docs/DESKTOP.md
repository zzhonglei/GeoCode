# 桌面应用

本文档说明 GeoCode 怎样把 OpenCode 与 OpenChamber 组装成一个应用:进程怎样组成,内核怎样托管与打包,应用对外的边界在哪里,本机上谁能访问它。

## 1. 组成

GeoCode 是一个应用,安装、启动、退出都只有一个入口,用户不需要另装 OpenCode。

```
Electron 主进程
 ├─ 壳服务端(OpenChamber 的服务端,在主进程内运行)
 │    └─ 子进程:内核(OpenCode,serve --stdio)
 └─ 界面(渲染进程)── HTTP、SSE、WebSocket ──→ 壳服务端
```

界面只与壳服务端通信,壳服务端把内核的接口代理给界面,转发时附上内核的口令,界面拿不到这个口令。两个服务都只监听 127.0.0.1,壳服务端只接受 GeoCode 自己的窗口(第 4 节)。

## 2. 内核

内核是壳的私有组件:只由这个壳启动,只为这个壳服务,随壳退出。壳以 `serve --stdio` 启动它,这是 OpenCode 为私有内核设计的运行方式。壳每次启动内核时随机生成口令,以 `OPENCODE_PASSWORD` 显式传入,优先于用户环境里的同名变量;内核读取后把口令从自己的环境里删掉,agent 执行的命令读不到它。内核把标准输入当作租约,壳正常退出或被强制结束时管道关闭,内核随之退出,不会留下无主的进程。

另外两种方式不采用。上游 OpenChamber 用的普通 `serve` 把口令留在内核的环境里,会被 agent 执行的命令继承,也会被用户导出的同名变量覆盖;OpenCode 桌面版用的 `serve --service` 是每个用户共用的常驻服务,应用退出后仍在运行,默认还与用户自己安装的 OpenCode 共用服务与数据。

安装包里的内核由本仓库的 `kernel/` 构建,版本与 `kernel/` 一致。上游在打包时从 npm 下载 OpenCode 发布的内核,GeoCode 不用这一步,否则对内核的修改进不了安装包。壳只使用安装包里的内核,不读设置里的内核路径、环境变量指定的内核或 `PATH` 上的 `opencode`;内核缺失或起不来时报错,不引导用户安装 OpenCode。构建与暂存的方法见 `DEVELOPMENT.md` 第 4 节,暂存脚本是 POSIX sh,只有 macOS 的打包流程能用。

## 3. 对外边界

GeoCode 是单机、单用户的应用,三类机制一律关闭:让其他设备连进来的(局域网访问、用户设置的界面口令、设备配对与设备令牌、Private Relay、公网隧道),连到本机内核以外主机的(多主机与主机切换、SSH 远程实例、外部内核),以及不经用户操作就发往上游服务器的(OpenCode 的安装与升级、OpenChamber 的更新检查与使用上报、推送)。`openchamber://` 深链不注册也不处理。移动端、VS Code 扩展、独立的网页服务(包括安装为 PWA)与 `openchamber` 命令行不构建、不打包,用户只通过 GeoCode 的窗口操作应用。

关闭遵循 `DESIGN.md` 的「边界靠装配,不靠删除」:源码保留,入口在三层分别关掉。壳服务端对这些接口回 404,由它自己回答,因为未匹配的 `/api` 路径会落到内核代理;主进程拒绝相应的 IPC 命令;界面隐藏相应的设置页与入口,并在源头停掉自动发出的请求。界面的隐藏只是配合,拒绝发生在壳服务端与主进程。

模型服务的连接是内核的正常工作,不在此列。其余上游功能的去留见 `DESIGN.md` 第 4 节。

## 4. 本机访问控制

只监听 127.0.0.1 挡不住本机:任何程序都连得上壳服务端,浏览器里的网页也能,因为 WebSocket 不受跨域限制,DNS 重绑定还能让网页以同源的身份发请求。而壳服务端转发时替调用方附上内核的口令,能调用它,就能让 agent 以用户的身份执行命令、读写文件。防护的对象是浏览器里的网页、其他用户与沙箱内的程序、扫描本机端口的脚本。以用户身份运行、不受沙箱限制的程序不在此列,它本来就能修改用户的文件与配置。

做法是让壳服务端只认 GeoCode 自己的窗口。壳服务端运行在上游的口令模式下,口令每次启动随机生成,只在主进程的内存里,没有人输入或使用它,作用只是让上游对 HTTP、WebSocket 与临时 url-token 的认证按完整逻辑执行。上游另有「无口令、只要令牌」的模式,不采用:多数 WebSocket 在那个模式下不做认证,会话 cookie 也可以伪造。主进程在进程内为窗口签发一个令牌,它不过期,但每次启动换新,只存在于主进程与窗口的内存里,磁盘上只有它的哈希。设备令牌与会话重置的接口关闭,会话 cookie 的签名密钥也每次启动随机生成,所以窗口以外没有取得令牌或会话的途径。不要求这个令牌的,只有登录状态、健康检查、版本这类状态接口与以 `state` 参数校验的 OAuth 回调;内核回调壳的通道(agent 工具与插件通知)用壳每次启动内核时另生成的令牌。

令牌之外还有两道防线。壳服务端只接受 Host 为 `127.0.0.1` 或 `localhost` 的 HTTP 请求,DNS 重绑定的网页连不需要令牌的接口也读不到;WebSocket 的升级请求不经过这道检查,而 DNS 重绑定时 Origin 与 Host 一致,Origin 检查也拦不住,所以 WebSocket 只靠令牌。内核的口令不留在壳服务端的环境变量里,壳启动的终端与其他子进程读不到它,无法绕过壳直接访问内核。令牌失效时(令牌记录被删,或启动时签发失败),界面提示重启应用,不出现上游的口令登录页。

口令模式也让上游「没有口令就不能开隧道、不能监听非本机地址」的两道保险不再起作用,第 3 节对隧道的关闭与只监听 127.0.0.1 因此不能放开。已知的例外有三个:文件预览里的 HTML 以壳服务端的来源运行,地址里带着 60 秒有效的临时令牌,页面脚本能用它读取壳服务端可读的任意文件,这是上游的设计;CORS 放行 `localhost` 与 `127.0.0.1` 的任意端口,这些端口上的网页能跨域读取不要求令牌的接口,其中健康检查会返回内核的路径与最近的错误输出;与本机安装的 OpenChamber 共用数据目录(见 `DESIGN.md` 第 4 节)时,两者的令牌记录在同一个文件里,互相有效,同时运行时还会无锁地互相覆盖,可能让 GeoCode 的窗口转到重启提示,也可能恢复 OpenChamber 刚撤销的设备。校验令牌时还会写这个文件,写不进去(磁盘满、文件无权限)时所有请求都被拒绝。

## 5. 实现与维护

本节的路径以 `desktop/packages/` 为起点。GeoCode 自己的代码放在各包的 `geocode/` 目录里;对上游的补丁怎样标记、怎样列出,见 `CONVENTIONS.md` 第 3.4 节。

壳服务端的补丁多数以 `process.versions.electron` 判断是否在桌面应用里,以 `serve --stdio` 启动内核的补丁(`web/server/lib/opencode/lifecycle.js`)例外,对 OpenChamber 的所有运行方式都生效;界面以 `ui/src/geocode/surface.ts` 的 `isGeoCodeDesktop` 判断,设置页与搜索项以设置上下文的 `isDesktop` 判断。`electron:dev` 在 Electron 之外另起一个壳服务端,壳服务端的这类补丁、环境变量的清洗与访问控制在那里都不生效,验证要用 `electron:dev:bundled` 或打包出的应用。关闭接口与主机名检查各有测试,运行方法见 `DEVELOPMENT.md` 第 7 节。

关闭与访问控制依靠几份手写的清单,也依赖上游口令模式的行为,上游新增的内容不会自动被覆盖。合并 `chamber-upstream` 之后,重新推导并对照:

- 关闭的接口(`web/server/geocode/closed-surface.js`):在壳服务端里找 `app.get`、`app.post` 等方法与 `app.use` 注册的路径,以及 `server.on('upgrade'` 的处理器,属于第 3 节机制的加进清单;新的 WebSocket 处理器在口令模式下要校验令牌。关闭的 IPC 命令(`electron/geocode/closed-commands.mjs`):`main.mjs` 里 `handleInvoke` 的命令,以及 `ipcMain.handle` 与 `ipcMain.on` 的频道。不接受的用户环境变量(`electron/geocode/inherited-env.mjs`):壳服务端 `web/server/lib/opencode/` 与 `main.mjs` 读取的 `process.env`。隐藏的设置(`ui/src/geocode/settings.ts`):`SETTINGS_PAGE_METADATA` 与 `SETTINGS_SEARCH_ITEMS`。自动外发:在壳服务端、界面与 `main.mjs` 里找 `openchamber.dev`、`github.com/openchamber` 等地址。
- 唯一入口仍然唯一:推送只经 `web/server/lib/notifications/runtime.js` 的 `fanoutPush`,深链只经 `electron/main.mjs` 的 `handleDeepLinks`,窗口取令牌只经 `main.mjs` 的 `readDesktopLocalClientToken`,会话密钥只来自 `web/server/lib/ui-auth/ui-auth.js` 的 `getOrCreateJwtSecret` 与 `rotateJwtSecret`。
- 上游的行为没有变:`createClient` 不传 `expiresAt` 时不过期;令牌不经渲染进程的命令行参数(`electron/early-startup.mjs` 的 `buildRendererAdditionalArguments`);`ui/src/components/auth/SessionAuthGate.tsx` 只在 `locked` 状态显示口令表单。
- `web/server/lib/opencode/compatibility.js` 的 `MINIMUM_OPENCODE_VERSION` 不高于 `kernel/` 的版本,否则壳会拒绝安装包里的内核。

## 6. 验收

在没有安装 OpenCode 的环境里,打包出的应用启动后可以直接对话,用的是 `kernel/` 构建的内核,即使 `PATH`、设置或环境变量指向别的 `opencode` 也一样;内核缺失时报错。正常退出与强制结束之后,都没有残留的内核进程;agent 执行的命令与应用内的终端都读不到内核的口令。

设置与界面里没有远程、局域网、配对、隧道等入口,对应的接口与 IPC 命令被拒绝,路径换了大小写也一样,`openchamber://` 链接不被处理。与本机 OpenChamber 共用数据目录时,它设置里的局域网开关、界面口令、主机列表,以及数据目录里的推送订阅,都不起作用。运行期间,应用不自动向 OpenChamber 的服务器发出请求,以监视应用进程的对外连接来确认。

不带令牌的 HTTP 请求与 WebSocket 连接(终端、事件流、听写等)都被拒绝,伪造的或 OpenChamber 签发的会话 cookie 不被接受,Host 不是 `127.0.0.1` 或 `localhost` 的 HTTP 请求被拒绝。窗口带着令牌时,对话、终端、文件预览、迷你聊天、内置浏览器与 agent 的工具回调都正常;令牌失效时显示重启提示,而不是登录页。
