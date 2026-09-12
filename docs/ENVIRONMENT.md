# 环境变量边界

本文是 GeoCode 环境变量边界的设计:规则、变量分类、时序、机制与验证。`PATHS.md` §3.6 与 `DESKTOP.md` §8.2
指向这里。凡写「实测」的都执行过,凡写「未验证」的都还没有。

---

## 1. 一句话

**带商标的剥,不带商标的不动。** 继承来的环境里,凡是带着 `OPENCODE_`、`OTEL_`、`OPENCHAMBER_` 商标的名字,
壳与内核一律不接,那是另外两个产品的配置面;其余一律原样放行,那是用户自己的东西,不管它是 `HOME` 还是
`ANTHROPIC_API_KEY`。边界挡的是「别的产品的设置」,不是「用户自己的凭据」。

带商标的名字里有一批是我们自己要用的(壳与内核之间的内部 ABI、开发脚本的旋钮),它们必须在剥离**之后**由
我们的代码写入,或在未打包时明确豁免。**这一批是整个设计里最要盯住的**,漏一个就是白屏或内核不可用,§4.1 逐个列出。

唯一的例外是一小批不带商标、但能改变内核子进程「跑什么代码」的运行时变量(`NODE_OPTIONS` 一类),
§4 类 B。它们不是配置也不是凭据,作为安全例外从内核子进程环境里去掉(§6.1)。

## 2. 为什么上游帮不了我们

OpenCode 自己的桌面端(v1.18.18,`packages/desktop`,与内核同版本,同为 Electron)**不过滤任何环境变量**:

- `preferAppEnv()` 把登录 shell 的环境整个并入,应用自己的几个值叠在上面(`{...shell, ...app}`);
- `createSidecarEnv()` 把整份 `process.env` 原样交给内核子进程,只删 `DEBUG`,Linux 上再删 `LD_PRELOAD`;
- 口令走 IPC 不走环境;内核打包进 sidecar,没有「去磁盘找一个 opencode」这条路。

对上游这是正确的:桌面端与 CLI 是同一个产品,共享 shell 里的 `OPENCODE_*` 是功能。它甚至在往反方向走,
v2 路径会主动扫三个兄弟产品的 appData 目录复用已在跑的守护进程。**「不读兄弟产品的环境」是只有 fork
才有的问题,没有参考实现可抄。** OpenChamber 照搬了 `createSidecarEnv` 的两行删除,没有加任何过滤;
前缀过滤是 GeoCode 自己加的。

上游给出的是边界应在的**位置**:它把应用的值叠在 shell 并入**之后**。我们的剥离放到同一个位置就对了。

## 3. 上游的形状,和它决定的边界位置

| # | 上游机制 | 对边界的含义 | 证据 |
|---|---|---|---|
| 1 | **两次登录 shell 回灌。** 主进程的 `inheritUserShellEnv()` 按「当前为 `undefined` 才填」把登录 shell 的值并入 `process.env`;web 服务器导入时 `applyLoginShellEnvSnapshot()` 按「当前为空才填」再并一次。两处都在内核 fork 与服务器导入之前或之中。 | 一次「删掉」正好制造出「undefined」,合并就把它填回来。剥离必须与合并同一函数体,且壳内只能合并一次(§5.2) | 用桩 `$SHELL` 驱动真实合并:删掉的 `OPENCODE_CONFIG` 与 `OTEL_EXPORTER_OTLP_HEADERS` 都回来 |
| 2 | **子进程环境只取决于交给 fork 的对象。** `createKernelProcessEnvironment` 从零建对象、按前缀过滤;`utilityProcess.fork` 传了 `env` 就只有那个对象。 | 内核那一半的干净由 fork 边界独立保证,不依赖壳进程剥得多干净 | 传一个 3 键对象,子进程只剩这 3 个加系统自塞的 2 个 |
| 3 | **`OPENCHAMBER_*` 是壳的配置面**,web 服务器读 61 个名字、主进程 19 个(2026-09-13 在 v1.23.1 上按 §7 壳侧扫描面的同一方法数得,去重后计);一批在回灌之后才读:`SKIP_LOCAL_SERVER`(整个服务器与内核都不起)、`OPENCODE_CWD`(内核工作目录)、`SERVER_URL`(把桌面端指向远端服务器)、`ALLOW_UNAUTHENTICATED_LAN`、`DEV_SHUTDOWN`、`DIST_DIR`(当作界面文件目录去 serve 的路径)、`MANAGED_PROCESS_REGISTRY`(启动时**杀掉**其中记录的 pid 的目录)、`OPENCODE_PATH`/`OPENCODE_BIN`、`TERMINAL_SHELL`、`PUSH_RELAY_URL`、`RELAY_URL`、`APNS_*`。 | 第三个商标必须入表,我们自己要用的名字在剥离之后写回(§4.1) | 桩 shell 里的 `OPENCHAMBER_SKIP_LOCAL_SERVER=1` 与 `OPENCHAMBER_OPENCODE_CWD` 到达读取点 |
| 4 | **运行时变量在任何代码之前生效。** `NODE_OPTIONS='--require x.js'` 放进子进程 env,x.js 在 utility 进程里执行,`--import` 与 `--inspect` 同样;**打包后 Electron 只在主进程拒绝 `NODE_OPTIONS`,utility 子进程不受保护**。`DYLD_INSERT_LIBRARIES` 注入成功。`ELECTRON_RUN_AS_NODE=1` 让子进程直接起不来(exit 2304)。`NODE_V8_COVERAGE` 往磁盘写 403 KB。`DEBUG=*` 对 Electron/Node 本身**无任何输出**,`NODE_DEBUG=*` 才是噪音源。 | 这些没有读取点可屏蔽,只能在 fork 边界删(§5.3) | 全部实测,Electron 43.3.0,含一次合成的 `app.isPackaged === true` 运行。打包后 Electron 会从 `process.env` 删掉 `NODE_OPTIONS`,它变成 `undefined`,正好满足回灌条件 |
| 5 | **壳内两组读取时机不同。** `shared.js` 在导入时把内核配置根冻结成常量,`plugins.js`/`skill-routes.js`/`skills.js` 每次调用时重算。第二次回灌若带进 `XDG_CONFIG_HOME`,两组读到不同的根。主进程遇 nushell 整个跳过探测,服务器却会退到 `/bin/zsh`,两次探测可以不一致。 | 壳内只合并一次,三方(冻结常量、懒调用、内核子进程)才读到同一份 XDG(§5.4) | 实测:同一进程里冻结值为 `~/.config/GeoCode`,随后 `kernelConfigRoot()` 返回探针值 |
| 6 | **壳有一条托管内核启动路。** `lifecycle.js` 的 `startOpenCode()` 按 `OPENCODE_BINARY` → 随包 `opencode-cli` → **PATH 扫描** → 家目录候选 → `$SHELL -lic 'command -v opencode'` 找一个二进制拉起来。不走这条路的条件是一对变量(`ENV_SKIP_OPENCODE_START && ENV_EFFECTIVE_PORT`),一对里任何一个为空,静默落到 PATH 扫描。 | 失败方向是「打开」,要改成「关闭」(§5.6) | `index.js` 与 `lifecycle.js` 逐行读 |
| 7 | **`OPENCHAMBER_UI_PASSWORD` 由主进程写进 `process.env`**,再由 fork 边界复制给子进程;内核口令则走 IPC。 | 前缀表含 `OPENCHAMBER_`,口令自然不进子进程环境块 | `ps -E` 可见与否 |

另有两件不在桌面路径上、只记录:`openchamber startup enable` 把整份 `process.env`(含全部 API 密钥)
写进 launchd plist 与 `startup.env`,仅 27 个 shell 杂项进拒绝表(mode 0600,是 blast radius 不是权限洞);
`ssh-manager.mjs` 把 SSH 口令放进子进程环境块,与内核口令走 IPC 的规则相悖,上游代码且有测试钉着现状。

## 4. 变量分类

设计的核心是把「环境变量」拆成五类,每类一个处置,不再按单个名字讨论。判据只有一条:**带不带商标**。

| 类 | 是什么 | 例 | 处置 | 依据 |
|---|---|---|---|---|
| **A 带商标** | 三个产品各自的配置命名空间 | `OPENCODE_*`(内核两个注册表共 54 条,4 个重名,GeoCode 一条没改)、`OTEL_*`、`OPENCHAMBER_*`(壳侧读多少个名字见 §3 第 3 行) | **剥**:壳进程与内核子进程都不留继承来的;我们要用的在剥离之后自己写(类 E)或未打包时豁免(类 F) | §1;上游把它们当功能,我们当另一个产品的设置 |
| **B 不带商标、但能改「跑什么代码」** | Node/Electron/加载器的运行时变量:注入代码、让子进程起不来、往磁盘写文件 | `NODE_OPTIONS`、`NODE_PATH`、`ELECTRON_RUN_AS_NODE`、`ELECTRON_NO_ASAR`、`DYLD_INSERT_LIBRARIES`、`LD_PRELOAD`、`OPENSSL_CONF`、`NODE_ICU_DATA`、`NODE_V8_COVERAGE`、`NODE_REDIRECT_WARNINGS`、`ELECTRON_LOG_FILE`、`CHROME_LOG_FILE`、`NODE_DEBUG`、`DEBUG` | **唯一例外,不交给内核子进程**(黑名单,按平台;§6.1)。壳自己的进程不动——Electron 主进程的环境是操作系统给的,打包后 Electron 自己会拒绝 `NODE_OPTIONS` | 实测 §3 第 4 条;`DEBUG` 沿用上游理由(污染我们解析的 stdout),`NODE_DEBUG` 是实测出来的真噪音源。它们既不是配置也不是凭据,是安全 |
| **C 不带商标** | 用户自己的一切:身份、工具链、凭据 | `HOME`、`PATH`、`SHELL`、`TMPDIR`、`LANG`、`TZ`、`SSH_AUTH_SOCK`、`GIT_*`、代理六件套、`NODE_EXTRA_CA_CERTS`、`LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH`、`PYTHONPATH`、**`XDG_*`**;供应商凭据 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GITHUB_TOKEN`、`GOOGLE_APPLICATION_CREDENTIALS`(名字由 models.dev 目录数据驱动,内核带的那份 211 家、208 个名字) | **原样放行,一个不动** | 实测传空对象给 `utilityProcess.fork` 时子进程只剩 5 个键;GDAL/PROJ 靠 `LD_LIBRARY_PATH`,GEE 靠 `GOOGLE_APPLICATION_CREDENTIALS`,agent 的 `gh` 靠 `GITHUB_TOKEN`,内核用 `extendEnv: true` 把它们传给子进程;供应商凭据的读取点在 `KERNEL.md` 冻结区,内核优先级本就是配置文件 > `auth.json` > 环境;上游桌面端同形;XDG 见 §5.4 |
| **E 我们的注入** | 壳与内核之间的内部 ABI,由我们的代码在剥离**之后**写入 | §4.1 的表 | **写在最后一次剥离之后**;名字不成为公开配置面 | 它们带商标,所以顺序就是全部:先剥,后写 |
| **F 开发启动器旋钮** | 我们自己的启动脚本传给主进程的开关 | `electron:dev` 的 `OPENCHAMBER_ELECTRON_DEV`、`_ELECTRON_USE_BUNDLED_UI`、`_HMR_UI_PORT`、`_HMR_API_PORT`;更新器 e2e 夹具的 `_E2E`、`_UPDATER_E2E_URL` | **前四个仅未打包时豁免**,打包版一律剥;**后两个各形态都豁免**,它们没有构建期 define 时是惰性的,而夹具驱动的正是打包版 | 它们带商标,但发送方是我们的脚本;打包版没有 dev 发送方,一个 shell 里的 `OPENCHAMBER_ELECTRON_DEV=1` 不该把正式版翻成开发态 |

不在表里的都是类 C:默认放行。**黑名单只有 B,白名单只有 F,其余按商标。** 三张表都住在一个模块里。

供应商凭据不再单独成类,它就是类 C。放行的可见后果只有一件:用户 shell 里有 `ANTHROPIC_API_KEY`,GeoCode 的模型
列表里就会出现 Anthropic,虽然用户没在 GeoCode 里配过。那是用户自己的钥匙,不是别人的设置;一旦在界面登录或写进
配置文件,文件里的值优先,环境的值就不起作用。按 `_API_KEY` 后缀剥、其余 35 个名字手工二分再配一条读 models.dev 的绊线,这条路
做不到更好:那 35 个里一大半是 `AWS_*`、`GOOGLE_APPLICATION_CREDENTIALS`、`GITHUB_TOKEN` 这类身兼
两职的名字,剥了断工具链,留了照样激活供应商,规则做不到比商标判据更好,却多出一张会漂的名单。

### 4.1 带商标却是我们自己要用的名字

这是设计里最要盯住的一张表。每一行都带商标,所以都会被剥;它们能工作,**只**因为我们的代码在剥离之后把它们写回去。
顺序一错,后果在最后一列。

| 名字 | 谁写 | 谁读、何时 | 顺序错了会怎样 |
|---|---|---|---|
| `OPENCHAMBER_DATA_DIR` | `applyShellDataRoot`(`main.mjs` 模块顶层,紧跟身份设置;剥离函数尾部再写一次) | 主进程模块顶层(`sshManager` 冻结成字符串);壳 11 处导入时冻结、7 处每次调用重算,共 76 个读取点 | 两组读到不同的根,设置在一处写、另一处读,`PATHS.md` §5 记过一次 |
| `OPENCHAMBER_MANAGED_PROCESS_REGISTRY` | 同上 | `lifecycle.js:1027` 启动时无条件回收孤儿,按这个目录里记录的 pid **杀进程** | 回落到默认目录;若与上游 OpenChamber 共用,他们的内核成回收候选 |
| `OPENCHAMBER_HOST` | `main.mjs` 的 `spawnLocalServer`,本行至 `_SKIP_API_COMPRESSION` 都在这里 | `index.js:1474` 与 `server-startup-runtime.js:25`,启动时 | 绑定地址回落 loopback,局域网访问设置失效 |
| `OPENCHAMBER_DESKTOP_LAN_ACCESS_ACTIVE` / `_BLOCKED_REASON` | 同上 | `settings-helpers.js:942-944`,每次请求 | 设置页少两个字段 |
| `OPENCHAMBER_DIST_DIR` | 同上 | `static-routes-runtime.js:19`,**导入时** | 找不到界面文件,白屏 |
| `OPENCHAMBER_RUNTIME = 'desktop'` | 同上 | `index.js:170/223/629/1687`、`lifecycle.js:485`、`package-manager.js:396`、`tts/base-url.js:50`,其中 629 行**导入时** | 桌面通知、压缩、包管理器探测、远端 TTS 守卫全部走 web 分支;包管理器探测会阻塞主进程 |
| `OPENCHAMBER_OPENCODE_CWD` | 同上 | `hmr-state-runtime.js:10`,**导入时**;`spawnLocalServer` 把它作为 `startEmbeddedKernel` 的 `cwd` 传给内核 | 内核工作目录变成家目录 |
| `OPENCHAMBER_DESKTOP_NOTIFY` | 同上 | `index.js:625`,**导入时** | 桌面通知关闭 |
| `OPENCHAMBER_UI_PASSWORD` | 同上 | `index.js:1573`,启动时 | 界面无口令;开了局域网访问时被 `bind-host.js` 拒绝启动 |
| `OPENCHAMBER_SKIP_API_COMPRESSION` | 同上 | `index.js:220`,每次请求 | 压缩打开,性能 |
| `OPENCHAMBER_SKIP_OPENCODE_START` | `startEmbeddedKernel` → `applyKernelConnectionToShellEnvironment` | `index.js:623`,**导入时** | **壳改走托管启动**,被 §5.6 的早退拒绝,界面报内核不可用 |
| `GEOCODE_BROWSER_PLUGIN` | `browser-tool.mjs` → `startEmbeddedKernel` 的 `overrides` | 内核 `plugin/geocode-trusted.ts`,`loadExternal` 时 | 内核不加载浏览器工具;它只认这一个路径 |
| `OPENCHAMBER_AGENT_TOOL_URL` / `_TOKEN` | 同上,注入内核;`_TOKEN` 另放进主进程环境供壳采纳,壳起来后删除 | 插件源码在每次调用时读;壳 `agent-tool/runtime.js` 创建时读 | 工具回调无门,或壳的令牌为空恒 401。带商标是因为沿用上游模板读的名字,它们是我们注入的 ABI,不是继承的配置 |
| `OPENCODE_HOST` | `applyKernelConnectionToShellEnvironment` | `env-config.js:41`,**导入时** | 同 `OPENCHAMBER_SKIP_OPENCODE_START`,它是那一对变量的另一半 |
| `OPENCODE_SERVER_PASSWORD` | 同上 | `auth-state-runtime.js:48`,每次向内核的请求 | 壳对内核每个请求 401 |

内核那一半**不需要**任何继承来的带商标名字:`OPENCODE_SERVER_USERNAME`/`_PASSWORD` 由 sidecar 收到 IPC 后在自己
进程里设;将来要给内核的(`PATHS.md` §7 挂起的 `OPENCODE_DISABLE_AUTOUPDATE`、上游桌面端设的 `OPENCODE_CLIENT`)
一律走 `startEmbeddedKernel` 的 `overrides`,它叠在过滤之后。上游 agent-tool 插件的 `OPENCHAMBER_AGENT_TOOL_URL`/`_TOKEN`
不在此列:那条注入不进产品(`DESKTOP.md` §7.3)。

三个带商标、树里**没有任何脚本设置**、只在测试里出现的名字——`OPENCHAMBER_MEMORY_ENABLE`、`OPENCHAMBER_STARTUP_PERF`、
`OPENCHAMBER_ELECTRON_LOAD_SERVER_UI`——剥掉与默认无异,不进白名单。开发脚本还设 `OPENCHAMBER_PORT`、
`OPENCHAMBER_RELAY_HOST`、`OPENCHAMBER_DISABLE_PWA_DEV`,但收件人是独立的 dev 服务器进程与 vite,不经过 Electron
主进程,不受本设计影响。

## 5. 机制

### 5.1 一个模块持有全部规则

`desktop/packages/electron/geocode/kernel-environment.mjs` 已经是这条边界的家,只是规则不全。改后导出:

| 导出 | 内容 |
|---|---|
| `INHERITED_PREFIXES` | `['OPENCODE_', 'OTEL_', 'OPENCHAMBER_']`(类 A) |
| `CHILD_DENYLIST` | 类 B,按平台分组:通用一组,`darwin` 加 `DYLD_INSERT_LIBRARIES`,`linux` 加 `LD_PRELOAD` |
| `LAUNCHER_ALLOWLIST` / `E2E_ALLOWLIST` | 类 F:前者 4 个 dev 旋钮,后者 2 个 e2e 名字 |
| `stripInheritedForeignVariables(env, { keep })` | 按前缀删,`keep` 里的名字跳过;返回删掉的名字 |
| `environment-boundary.mjs` 的 `inheritedKeep` | 本进程的 `keep`:未打包时两张表都留,打包时只留 e2e;模块加载即做第一次剥离,是 `main.mjs` 的第一条 import。Electron 之外没有 `app`,按打包处理 |
| `createKernelProcessEnvironment({ environment, platform, overrides })` | 从零建子进程环境:按前缀过滤 → 按黑名单删 → 叠 `overrides`。`overrides` 仍是唯一有意驱动内核的通道(要改代码、走提交、过审查) |
| `applyKernelConnectionToShellEnvironment` | 不变 |

判据用 `app.isPackaged`,不用任何环境变量。

### 5.2 壳进程的时序

改后的 `main.mjs` 时间线,标粗的是新增或移动:

```
import './geocode/environment-boundary.mjs'   ← **第一条 import**:模块加载即做第一次剥离,
                                                早于 mintOutsideFileGrant 拉进来的服务器闭包,
                                                早于读 OPENCHAMBER_ELECTRON_DEV 的 isDev
applyShellDataRoot(process.env)               ← 模块顶层、紧跟身份设置:注入数据根(类 E)
...
inheritUserShellEnv() {
  probe → 合并(undefined 才填)→ 合并 PATH
  **stripInheritedForeignVariables(process.env, { keep })   ← 与合并同一函数体,原子**
  **applyShellDataRoot(process.env)                          ← 数据根被剥后立即重写,幂等**
}
shouldSkipLocalServer()  → 调 inheritUserShellEnv()   ┐ 两个上游调用点,
spawnLocalServer()       → 调 inheritUserShellEnv()   ┘ 都自动带上剥离
  process.env.OPENCHAMBER_HOST = ... 等          ← 我们的注入(类 E),在最后一次剥离之后
  startEmbeddedKernel({ environment: process.env })   ← createKernelProcessEnvironment:前缀 + 黑名单
    applyKernelConnectionToShellEnvironment          ← OPENCODE_HOST / _SERVER_PASSWORD / SKIP
  await import('@openchamber/web/server/index.js')
    index.js 模块顶层  **if (!process.versions.electron) applyLoginShellEnvSnapshot();**
                       /* applyLoginShellEnvSnapshot(); */   ← 上游行逐字节包进注释
```

三条不变量,每条配绊线(§7):

1. **合并之后立刻剥离,同一函数体内。** 剥离不再是一个可以被隔开的独立语句。上游若新增第三个
   `inheritUserShellEnv()` 调用点,自动带上。
2. **所有注入都在最后一次剥离之后。** `spawnLocalServer` 里的注入与 kernel-boot 的连接写入都在其后;
   数据根在模块顶层就写了,所以在剥离函数里重写一次。
3. **壳内不做第二次合并。** 主进程已经把同一个登录 shell 并进同一份 `process.env`,服务器再并一次只会
   把剥掉的填回来。判据 `process.versions.electron` 是进程的固有事实,不是变量,丢不了;`openchamber
   serve` 单独跑时它为空,上游行为不变。实测 `ELECTRON_RUN_AS_NODE=1` 下它仍为 `43.3.0`,所以
   §7 的运行时测试可以用 Electron 二进制当 Node 跑。

⚠️ 第 3 条是对上游 `index.js` 的一处一行改动,形态按 `CONVENTIONS.md` §5:新增一行条件调用,上游原行
逐字节包进 `/* */`,前后标记。它不是「早退」也不是「变量门」——`OPENCHAMBER_RUNTIME === 'desktop'`
这样的门正是 §3 第 6 条批评的那种,变量丢了门就开。

服务器的 `getLoginShellEnvSnapshot()` 仍会在第一次需要时(给 PTY 拼 PATH)懒探测一次,那个 `spawnSync`
没有超时,是上游既有行为;跳过导入时那一次只是把它挪出了启动关键路径,没有消除。记为上游问题。

### 5.3 内核子进程

`createKernelProcessEnvironment` 的黑名单(类 B)与理由:

| 名字 | 平台 | 为什么 |
|---|---|---|
| `NODE_OPTIONS` | 全部 | `--require`/`--import` 在子进程执行任意文件,`--inspect` 开调试口;打包保护不覆盖 utility 进程(实测) |
| `NODE_PATH` | 全部 | 默认在 utility 进程无效(`Module.globalPaths === []`),但任何一处 `Module._initPaths()` 让它复活(实测);不能依赖巧合 |
| `ELECTRON_RUN_AS_NODE` | 全部 | 留着子进程起不来(实测 exit 2304) |
| `ELECTRON_NO_ASAR` | 全部 | 改变模块解析来源 |
| `DYLD_INSERT_LIBRARIES` | darwin | dylib constructor 在子进程执行(实测);entitlements 放行了它 |
| `LD_PRELOAD` | linux | 上游已删,同类 |
| `OPENSSL_CONF`、`NODE_ICU_DATA` | 全部 | 前者可载入 engine,后者路径错了启动失败 |
| `NODE_V8_COVERAGE`、`NODE_REDIRECT_WARNINGS`、`ELECTRON_LOG_FILE`、`CHROME_LOG_FILE` | 全部 | 都往磁盘写文件,直接干扰 `foreign-writes.sh` 那道门(`NODE_V8_COVERAGE` 实测写出 403 KB) |
| `NODE_DEBUG`、`NODE_PENDING_DEPRECATION`、`DEBUG` | 全部 | stderr/stdout 噪音,我们解析子进程输出(`NODE_DEBUG=*` 实测 7 KB) |

**明确不删**:`LD_LIBRARY_PATH`、`DYLD_LIBRARY_PATH`(用户工具链,GDAL/PROJ 依赖)、`NODE_EXTRA_CA_CERTS`、
`SSL_CERT_FILE`/`SSL_CERT_DIR`(企业 CA)、代理六件套(内核对外连线靠它,企业环境必需;`kernel-sidecar.mjs`
已自行把 loopback 补进 `NO_PROXY`)、`NODE_TLS_REJECT_UNAUTHORIZED`(降级 TLS 但不改代码,是用户对所有
Node 程序的选择,§6.4)。

`utilityProcess.fork` 的 `execArgv` 选项我们不传,保持为空。

口令:内核口令走 IPC;界面口令带 `OPENCHAMBER_` 前缀,不进子进程。

内核子进程**收到的**环境就是它的 bash 工具、MCP、LSP、git、GEO 子进程**继承的**环境——内核起的每个
子进程都是 `{...process.env, ...overlay}`(仅三处例外)。所以这一层过滤的收益直接传到
agent 的工具里:agent 的 `bash` 看不到 `OTEL_EXPORTER_OTLP_HEADERS`,也看不到 `OPENCHAMBER_UI_PASSWORD`。

### 5.4 XDG 四根:保留,并且让两半看到同一份

`XDG_*` 是内核决定四个数据根的机制(`core/src/global.ts`,模块加载时经 `xdg-basedir` 读,实测
`XDG_DATA_HOME=/tmp/PROOF` 得到 `/tmp/PROOF/GeoCode`)。它不是配置,是标准;开发沙箱(`kernel-tui.sh`)
就靠它把一切收进独立目录;上游桌面端同样尊重它。**所以保留。**

代价是 §3 第 5 条那种劈叉。解法不是剥它,是 §5.2 不变量 3:壳内只有主进程那一次合并,发生在内核 fork
与服务器导入之前,于是 `shared.js` 的冻结常量、`plugins.js` 的懒调用、内核子进程,三者读到同一份。
`PATHS.md` §3.6 补一句:XDG 由用户环境决定,GeoCode 只保证壳与内核对它的解读一致。

### 5.5 开发启动器

`electron-dev.mjs` 与 `package.json` 的 `electron:dev:bundled` 把类 F 的名字传给主进程。改后:

- 未打包时 `keep` 是 `LAUNCHER_ALLOWLIST` 加 `E2E_ALLOWLIST`,6 个名字幸存;
- 打包版 `keep` 只剩 `E2E_ALLOWLIST`,4 个 dev 旋钮与其他 `OPENCHAMBER_*` 一起剥掉。`OPENCHAMBER_ELECTRON_DEV`
  在模块顶层的 `isDev` 就读,所以第一次剥离必须早于它——这就是 §5.2 时间线第一行把剥离搬进首个 import 的原因;
- e2e 两个名字各形态都留:更新器 e2e 夹具驱动的正是打包版,而没有构建期 define 时它们是惰性的;
- `OPENCHAMBER_DISABLE_PWA_DEV` 是 vite 进程读的,不经过主进程,不用管。

被否决的替代:把这些旋钮改成命令行参数。要动主进程的读取点,全是上游行,换来的只是少一张 6 行的表。

### 5.6 外部内核那条路

目标是让 §3 第 6 条的能力**不存在**,而不是被一对变量拦着。形态:`startOpenCode()` 函数体的第一句是早退,
`process.versions.electron` 为真时抛错「GeoCode owns its kernel; the shell runtime does not start one」,上游
函数体逐字节留在后面。放在函数顶部而不是启动那一处分支,是因为它有三个调用方:启动引导、配置变更后的
重启、托管进程退出后的重启,一处早退全部覆盖。`openchamber serve` 单独跑时不受影响;`electron:dev` 不带
bundled 的开发流程里,web 服务器是单独的 bun 进程,不在 Electron 里,它仍走上游那条路,这是
`CONVENTIONS.md` §7 早已记下的已知分叉,不在产品路径上。

效果:那对变量任何一个丢了,启动引导记下错误、界面报内核不可用,而不是悄悄拉起用户的 OpenCode;五步查找
一步都不执行。绊线在 `server/geocode/managed-kernel.test.js`:带 Electron 标记的运行时拒绝且不 spawn,
同一个运行时去掉标记后作对照,必须到达 spawn。

随包的 `opencode-cli`(§6.6):`prepare-geocode-kernel.mjs` 替代了上游的下载步骤,`resources/opencode-cli`
从未装过一个 opencode 二进制,`extraResources` 那条只是在复制一个空目录。条目与占位目录一并删除;上游的 `prepare-opencode-cli.mjs`、
`verify-opencode-cli.mjs` 与 `verify-linux-appimage.mjs` 对它的期待原样保留,不在我们的发布流程上。

### 5.7 CLI 与 `startup enable`:不在产品面

打包清单 `files` 只有 `dist-bundle/main.mjs` 与 `preload.mjs`,web 服务器打进了主进程 bundle,
`packages/web/bin/` 不随应用分发。`openchamber serve` 与 `startup enable` 是仓库里的代码,不是 GeoCode
的入口。**本设计不改它们**,在 `DESKTOP.md` §7 产品能力边界记一条「CLI 不是产品入口」,并配一条绊线:
`main.mjs` 与 `geocode/*.mjs` 不引用 `packages/web/bin`。

## 6. 取舍

本设计里做过取舍的几处,决定与理由。

| # | 问题 | 决定 | 理由 |
|---|---|---|---|
| 6.1 | 类 B(`NODE_OPTIONS` 一类)不带商标,按总原则该放行;是否作为唯一例外从内核子进程环境去掉 | 去掉 | 它们既不是配置也不是凭据,是注入代码、让子进程崩溃或往磁盘写文件的运行时开关,三条都实测过;上游自己也删 `DEBUG` 与 `LD_PRELOAD`,这只是把同一个理由用全。只动内核子进程的环境,壳进程不动 |
| 6.1a | 供应商 API 密钥是否也只认配置文件 | 放行(类 C) | 不带商标,是用户自己的钥匙;读取点在冻结区;内核优先级本就是配置文件 > `auth.json` > 环境;上游桌面端同形。§4 末段记了被否决的后缀规则 |
| 6.2 | 上游文档承诺可从 shell 设的 `OPENCHAMBER_*`(`CONTRIBUTING.md` 的 HMR 端口、docker 的 `UI_PASSWORD`/`HOST`/`TUNNEL_*`) | 剥。 HMR 端口归类 F 豁免;docker 的那批 GeoCode 没有 docker 形态 | 桌面形态没有这些面;`README.md` 实际一个环境变量都没写 |
| 6.3 | `XDG_*` | 保留并统一(§5.4) | 是标准不是配置;开发沙箱与内核都依赖 |
| 6.4 | `NODE_TLS_REJECT_UNAUTHORIZED`、`LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH` | 保留 | 不改代码;用户对自己工具链的选择;地理工具链依赖后两者 |
| 6.5 | `entitlements.mac.plist` 的 `allow-dyld-environment-variables` 与 `disable-library-validation` | 不动 | 这两行只在用 Apple 开发者证书签名、启用硬化运行时时才有意义;GeoCode 是免费开源项目,不签名,文件形同虚设,而未签名应用本就不受 SIP 对 `DYLD_*` 的限制。真正挡住注入的是子进程侧删 `DYLD_INSERT_LIBRARIES`(§5.3),已落地并实测。上游注释说这两行是给 `bun-pty`、`node-pty`、`sherpa-onnx-node` 三个 native 模块的,原样保留;哪天有证书再回头看 |
| 6.6 | 随包的 `opencode-cli` 二进制 | 删掉 `extraResources` 条目与占位目录(§5.6) | 从未真的打进过包,目录是空的;它唯一的消费者是那条已封的路 |
| 6.7 | CLI(`openchamber serve`、`startup enable`) | 不改,记为非产品入口(§5.7) | 不随应用分发;改它是另一个交付物 |

## 7. 验证与绊线

按 `CONVENTIONS.md` §7:每条门都要做反证;数断言,别数需求。

**单元(`kernel-environment.test.mjs` 扩充)**
- 三前缀表:`OPENCHAMBER_FOO` 被剥,`keep` 里的 `OPENCHAMBER_HMR_UI_PORT` 幸存,`keep` 为空时不幸存;不带商标的
  `ANTHROPIC_API_KEY`、`GITHUB_TOKEN` 原样留下;
- §4.1 那张表逐名断言:每个名字在「剥离 → 注入」跑完之后都在,值是我们写的那个;
- 黑名单:`NODE_OPTIONS`、`ELECTRON_RUN_AS_NODE`、`NODE_V8_COVERAGE` 在全部平台消失;`DYLD_INSERT_LIBRARIES`
  只在 darwin 消失,`LD_PRELOAD` 只在 linux;`LD_LIBRARY_PATH`、`NODE_EXTRA_CA_CERTS`、`HTTPS_PROXY`、
  `XDG_CONFIG_HOME` 全部留下;
- `OPENCHAMBER_UI_PASSWORD` 不进子进程环境;
- 反证:把 `OPENCHAMBER_` 从表里拿掉、把 `NODE_OPTIONS` 从黑名单拿掉,各自应有且只有对应断言变红。

**顺序绊线(源码文本)**
- `stripInheritedForeignVariables` 的调用出现在 `inheritUserShellEnv` 函数体内、`for` 合并循环之后;
- `index.js` 里存在 `/* applyLoginShellEnvSnapshot(); */` 且其前一行是带 `process.versions.electron`
  的条件调用;
- `inheritUserShellEnv();` 的每一处调用都在 `startEmbeddedKernel({` 之前(不变量 2:剥离现在随合并走,
  一次晚于内核连接写入的合并会把 `OPENCODE_HOST` 与口令一并剥掉);
- 「剥离早于 kernel start 与 server import」。
- 反证:各删一行,各应变红。

**前缀覆盖绊线**
- 内核侧:扫内核两个 flag 注册表,所有引号里的大写名必须被前缀表覆盖;
- 壳侧:扫 `packages/web/server/**` 与 `main.mjs` 里 `process.env.X` 形状的读取(注入式的 `env.X`
  不在扫描面上),去掉注释,名字里带 `OPENCODE`、`OTEL`、`OPENCHAMBER` 的必须以前缀表里的某个前缀开头。
  它必然全绿,存在的意义是钉住「壳读的名字与表同源」这条 `DESKTOP.md` §8.2 已经许下但没兑现的承诺。

**运行时(新,`geocode/` 下,进 `test-gate.sh` 的 electron 段)**
- 用 `ELECTRON_RUN_AS_NODE=1 <electron> driver.mjs` 跑一个驱动脚本:`SHELL` 指向一个打印
  `OPENCODE_CONFIG=/probe\0OTEL_EXPORTER_OTLP_ENDPOINT=http://probe\0XDG_CONFIG_HOME=/probe-xdg\0` 的桩;
  驱动先按 5.2 的顺序做剥离与注入,再 `await import('@openchamber/web/server/index.js')`,断言导入后
  `OPENCODE_CONFIG` 与 `OTEL_EXPORTER_OTLP_ENDPOINT` 仍为 `undefined`。这是对不变量 3 的真实进程证明;
- 反证:临时撤掉 `index.js` 那处屏蔽,应变红(A2 组已经用同样的桩在未屏蔽的现状上跑出了红)。

**真实内核(`scripts/kernel-env-probe.sh`,手工门)**
- 一个不开窗口的 Electron 应用,用真实的 `utilityProcess.fork` 走 `startEmbeddedKernel` 把内核拉起来,继承环境里下了
  四种毒:`OPENCODE_CONFIG_DIR`/`OPENCODE_CONFIG` 指向一份写着 `username: poison-user` 的配置、`OTEL_EXPORTER_OTLP_ENDPOINT`
  指向本地一个只数连接的监听、`NODE_OPTIONS=--require` 一个落标记文件的脚本、`OPENCHAMBER_UI_PASSWORD`。观察四件事:
  `/config` 有没有回显毒配置、标记文件有没有出现、监听收到几次连接、`ps -E` 的环境块里有没有这四个名字;XDG 重定向到
  临时目录,内核不碰真实根。
- 第二次绕过边界直接 `startKernelHost`,同一份毒:四个探针必须全响。实测:产品路径四项全空、XDG 生效;
  对照组配置回显 `poison-user`、标记文件写出(`--require` 在真实 utility 进程里执行了)、OTLP 监听 3 次连接、
  环境块四个名字全在。绿的条件是「A 全空且 B 全响」,少一边都红。

**真实会话(手工,并入 `CONVENTIONS.md` §7 那段 foreign-writes 流程)**
- 从终端 `export OPENCODE_CONFIG_DIR=/tmp/poison OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
  OPENCHAMBER_SKIP_LOCAL_SERVER=1` 后起 `electron:dev:bundled`,旁边 `nc -l 4318`:应用正常起来、
  有内核、`nc` 收不到任何连接、设置页仍落 GeoCode 根。**这道门看读,foreign-writes 看写,互补。**
- 打包版复验 `NODE_OPTIONS`:实验用的是合成的 `isPackaged`,不是 electron-builder 产物,结论充分但应在
  一次真正的打包上再跑一遍。
- 一次验收样本:终端 export 了 `OPENCHAMBER_SKIP_LOCAL_SERVER=1`、`OPENCHAMBER_OPENCODE_CWD=/tmp/x`、
  `OPENCODE_CONFIG_DIR=/tmp/poison`、遥测端点与 `OPENCHAMBER_ALLOW_UNAUTHENTICATED_LAN=true` 后起
  `electron:dev:bundled`。主进程的初始环境块里五个都在;服务器照常启动并以 skip-start 指向我们的内核;
  内核工作目录是家目录;内核环境块里带商标名字与 `NODE_OPTIONS` 共 0 个;遥测监听 0 次连接;对话与 git
  面板可用;整个会话写入检测干净。

## 8. 记录、不修

上游代码里与本题相邻但不在 GeoCode 增改面上的,记在这里,不为它们改上游:

- `ssh-manager.mjs` 把 SSH 口令放进子进程环境块(有上游测试钉着);
- 服务器懒探测登录 shell 的 `spawnSync` 无超时(主进程那次有 5 秒);
- `lsp/server.ts:571` elixir-ls 的 `{ MIX_ENV: 'prod', ...process.env }` 顺序反了;
- 内核把 `OPENCODE_CONSOLE_TOKEN`、`AWS_BEARER_TOKEN_BEDROCK`、`AICORE_SERVICE_KEY` 写回自己的 `process.env`,
  于是 agent 的 bash 能读到;`control-plane/workspace.ts` 把整份 `auth.json` 序列化进子进程环境变量;
- 内核口令同理:内核的服务端只从环境变量读鉴权口令,所以 sidecar 只能把它设进内核自己的 `process.env`;内核起的
  子进程按 `{...process.env, ...overlay}` 继承它,agent 的 bash 因此读得到(未验证)。GeoAgent 的 bash 本就通配放行,
  读到口令并不多给它什么;
- 九个供应商 handler 让环境赢过 `auth.json`(Cloudflare、Snowflake 等),与总规则相反;
- `OPENCODE_TEST_HOME`、`OPENCODE_TEST_MANAGED_CONFIG_DIR` 两个测试钩子在生产可达(前缀已剥,到不了内核);
- `startup enable` 的全量环境快照。

这些都在冻结区或上游自有逻辑里。它们的共同缓解是本设计的第一层:这些变量根本到不了我们的进程。
