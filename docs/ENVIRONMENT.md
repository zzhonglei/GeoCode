# 环境变量边界:设计方案

状态:**已批准**(2026-09-03;决策点 6.1 定为「去掉」,其余按推荐)。本文把 `PATHS.md` §3.6 与 `DESKTOP.md` §8.2 记下的那条边界重新设计一遍。
起因是一次逐文件审计发现,文档里写的边界在运行时并不成立:剥离做了,但随后被两次登录 shell 回灌撤销。
审计分五个模块进行(Electron 主进程与 CLI、web 服务器、内核、既有测试与文档、Electron 运行时实验),
结论全部并入本文;凡写「实测」的都是执行过的,凡写「未验证」的都还没有。

批准后本文替代 §3.6 与 §8.2 成为这条边界的主文,那两节改为指回本文。

---

## 1. 一句话

**带商标的剥,不带商标的不动。** 继承来的环境里,凡是带着 `OPENCODE_`、`OTEL_`、`OPENCHAMBER_` 商标的名字,
壳与内核一律不接,那是另外两个产品的配置面;其余一律原样放行,那是用户自己的东西,不管它是 `HOME` 还是
`ANTHROPIC_API_KEY`。边界挡的是「别的产品的设置」,不是「用户自己的凭据」。

带商标的名字里有一批是我们自己要用的(壳与内核之间的内部 ABI、开发脚本的旋钮),它们必须在剥离**之后**由
我们的代码写入,或在未打包时明确豁免。**这一批是整个设计里最要盯住的**,漏一个就是白屏或双内核,§4.1 逐个列出。

唯一的例外候选是一小批不带商标、但能改变内核子进程「跑什么代码」的运行时变量(`NODE_OPTIONS` 一类),
§4 类 B。它们不是配置也不是凭据,建议作为安全例外从内核子进程环境里去掉;这是决策点 §6.1。

## 2. 为什么上游帮不了我们

OpenCode 自己的桌面端(v1.18.18,`packages/desktop`,与内核同版本,同为 Electron)**不过滤任何环境变量**:

- `preferAppEnv()` 把登录 shell 的环境整个并入,应用自己的几个值叠在上面(`{...shell, ...app}`);
- `createSidecarEnv()` 把整份 `process.env` 原样交给内核子进程,只删 `DEBUG`,Linux 上再删 `LD_PRELOAD`;
- 口令走 IPC 不走环境;内核打包进 sidecar,没有「去磁盘找一个 opencode」这条路。

对上游这是正确的:桌面端与 CLI 是同一个产品,共享 shell 里的 `OPENCODE_*` 是功能。它甚至在往反方向走,
v2 路径会主动扫三个兄弟产品的 appData 目录复用已在跑的守护进程。**「不读兄弟产品的环境」是只有 fork
才有的问题,没有参考实现可抄。** OpenChamber 照搬了 `createSidecarEnv` 的两行删除,没有加任何过滤;
前缀过滤是 GeoCode 自己加的,而第一版把它放在了两次回灌之前。

上游给出的是边界应在的**位置**:它把应用的值叠在 shell 并入**之后**。我们的剥离放到同一个位置就对了。

## 3. 现状:实测出来的九件事

| # | 事实 | 证据 |
|---|---|---|
| 1 | **剥离被回灌。** `main.mjs:105` 删掉 `OPENCODE_*`/`OTEL_*`;`inheritUserShellEnv()`(1527/1534)按「当前为 `undefined` 才填」把登录 shell 的值填回去;web 服务器 `index.js:756` 的 `applyLoginShellEnvSnapshot()` 按「当前为空才填」再填一次。两处都在内核 fork 与服务器导入之前或之中。 | 用桩 `$SHELL` 实测:`OPENCODE_CONFIG` 从 `undefined` 变回 shell 的值;`OTEL_EXPORTER_OTLP_HEADERS=authorization=leaked` 同样回来 |
| 2 | **内核子进程是干净的,但属侥幸。** `createKernelProcessEnvironment` 在 fork 时重新按前缀过滤,所以回灌的值到不了内核。这一层保护与第 105 行的剥离无关,任何人都可能以为它多余而删掉。 | `kernel-boot.test.mjs:44` 只证明「传入对象里的 `OPENCODE_CONFIG` 不进子进程」,没有任何测试驱动过真实的登录 shell |
| 3 | **`OPENCHAMBER_*` 完全不剥**,web 服务器读 46 个名字、主进程读约 30 个。其中一批在回灌之后才读,shell 里的值直接生效:`SKIP_LOCAL_SERVER`(整个服务器与内核都不起)、`OPENCODE_CWD`(内核工作目录)、`SERVER_URL`(把桌面端指向远端服务器)、`ALLOW_UNAUTHENTICATED_LAN`、`DEV_SHUTDOWN`、`DIST_DIR`(当作界面文件目录去 serve 的路径)、`MANAGED_PROCESS_REGISTRY`(启动时**杀掉**其中记录的 pid 的那个目录)、`OPENCODE_PATH`/`OPENCODE_BIN`、`TERMINAL_SHELL`、`PUSH_RELAY_URL`、`RELAY_URL`、`APNS_*`。 | 实测 `OPENCHAMBER_SKIP_LOCAL_SERVER=1` 与 `OPENCHAMBER_OPENCODE_CWD=/tmp/attacker-cwd` 从桩 shell 到达读取点 |
| 4 | **内核子进程只挡前缀 + `DEBUG` + `LD_PRELOAD`**。`NODE_OPTIONS='--require x.js'` 放进子进程 env,x.js 在 utility 进程里执行,`--import` 与 `--inspect` 同样;**打包后 Electron 只在主进程拒绝 `NODE_OPTIONS`,utility 子进程不受保护**。`DYLD_INSERT_LIBRARIES` 注入成功,而我们的 `entitlements.mac.plist` 明确授予 `allow-dyld-environment-variables` 与 `disable-library-validation`,正式版同样不受 SIP 保护。`ELECTRON_RUN_AS_NODE=1` 让子进程直接起不来(exit 2304)。`NODE_V8_COVERAGE` 往磁盘写 403 KB。`DEBUG=*` 对 Electron/Node 本身**无任何输出**,`NODE_DEBUG=*` 才是噪音源。 | 全部实测,Electron 43.3.0,含一次合成的 `app.isPackaged === true` 运行。还有一条复活链:打包后 Electron 会从 `process.env` **删掉** `NODE_OPTIONS`,于是它变成 `undefined`,正好满足回灌条件,shell 里 export 的值被填回来再复制进内核 env |
| 5 | **壳内部的 XDG 时序劈叉。** `shared.js:20` 在导入时把内核配置根冻结成常量(早于 756 行),`plugins.js`/`skill-routes.js`/`skills.js` 每次调用时重算(晚于 756 行)。第二次回灌若带进 `XDG_CONFIG_HOME`,两组读到不同的根。Electron 里两次探测通常返回同一份,但主进程遇 nushell 整个跳过探测,服务器却会退到 `/bin/zsh`——劈叉可达。 | 实测:`shared_OPENCODE_CONFIG_DIR = ~/.config/GeoCode`,同一进程 `kernelConfigRoot()` 随后返回 `<probe>/GeoCode` |
| 6 | **外部内核那条路还在。** `lifecycle.js:1078` 的 `startOpenCode()` 会按 `OPENCODE_BINARY` → 随包 `opencode-cli` → **PATH 扫描** → 家目录候选 → `$SHELL -lic 'command -v opencode'` 的顺序找一个二进制拉起来。Electron 里它不可达,靠的是一对变量(`ENV_SKIP_OPENCODE_START && ENV_EFFECTIVE_PORT`)恰好都在 756 行**之前**读,所以 shell 改不了它。这条时序在两处都没写。一对里任何一个为空,静默落到 PATH 扫描。 | `index.js:612-623`、`lifecycle.js:1038-1080` 逐行读;`extraResources` 确认随包带了 `opencode-cli` |
| 7 | **界面口令进了内核子进程的环境块。** `main.mjs:1587` 把 `OPENCHAMBER_UI_PASSWORD` 写进 `process.env`,`createKernelProcessEnvironment` 不按这个前缀过滤,于是 `ps -E` 可见。同一模块的头注释写着内核口令刻意走 IPC。 | `kernel-environment.mjs:37-41` |
| 8 | **唯一的守卫是源码文本顺序绊线**(`kernel-environment.test.mjs:61-71`,比三个 `indexOf`)。它对「剥离被移走或删掉」会红,对「剥离之后又插了回灌」是盲的。 | 用变异过的 `main.mjs` 副本验证过它能红,也验证过它对现状全绿 |
| 9 | **文档与代码六处矛盾**:`GEOCODE_*`→`OPENCODE_*` 翻译通道文档说已删,`scripts/kernel-tui.sh:27-30` 里还活着,且它那份剥离只认 `OPENCODE_` 不认 `OTEL_`;`PATHS.md` §3.4 仍宣告 `GEOCODE_*` 为公开命名空间;`DESKTOP.md` §2、§5.1、阶段 6 清单仍把映射写成契约;§2 的内部 ABI 表列了两个从未写入的名字;§8.2 说前缀表拿壳读的名字核过,绊线只读两个内核文件;§3.6 说凡拉起内核或壳的入口都剥,实际只有一个入口剥。 | `C` 组逐条引文 |

另有两件不在桌面路径上、只记录:`openchamber startup enable` 把整份 `process.env`(含全部 API 密钥)
写进 launchd plist 与 `startup.env`,仅 27 个 shell 杂项进拒绝表(mode 0600,是 blast radius 不是权限洞);
`ssh-manager.mjs:433-443` 把 SSH 口令放进子进程环境块,与内核口令走 IPC 的规则相悖,上游代码且有测试钉着现状。

## 4. 变量分类

设计的核心是把「环境变量」拆成五类,每类一个处置,不再按单个名字讨论。判据只有一条:**带不带商标**。

| 类 | 是什么 | 例 | 处置 | 依据 |
|---|---|---|---|---|
| **A 带商标** | 三个产品各自的配置命名空间 | `OPENCODE_*`(内核两个注册表共 54 条,4 个重名,GeoCode 一条没改)、`OTEL_*`、`OPENCHAMBER_*`(壳约 100 个) | **剥**:壳进程与内核子进程都不留继承来的;我们要用的在剥离之后自己写(类 E)或未打包时豁免(类 F) | §1;上游把它们当功能,我们当另一个产品的设置 |
| **B 不带商标、但能改「跑什么代码」** | Node/Electron/加载器的运行时变量:注入代码、让子进程起不来、往磁盘写文件 | `NODE_OPTIONS`、`NODE_PATH`、`ELECTRON_RUN_AS_NODE`、`ELECTRON_NO_ASAR`、`DYLD_INSERT_LIBRARIES`、`LD_PRELOAD`、`OPENSSL_CONF`、`NODE_ICU_DATA`、`NODE_V8_COVERAGE`、`NODE_REDIRECT_WARNINGS`、`ELECTRON_LOG_FILE`、`CHROME_LOG_FILE`、`NODE_DEBUG`、`DEBUG` | **建议作为唯一例外,不交给内核子进程**(黑名单,按平台;决策点 §6.1)。壳自己的进程不动——Electron 主进程的环境是操作系统给的,打包后 Electron 自己会拒绝 `NODE_OPTIONS` | 实测 §3 第 4 条;`DEBUG` 沿用上游理由(污染我们解析的 stdout),`NODE_DEBUG` 是实测出来的真噪音源。它们既不是配置也不是凭据,是安全 |
| **C 不带商标** | 用户自己的一切:身份、工具链、凭据 | `HOME`、`PATH`、`SHELL`、`TMPDIR`、`LANG`、`TZ`、`SSH_AUTH_SOCK`、`GIT_*`、代理六件套、`NODE_EXTRA_CA_CERTS`、`LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH`、`PYTHONPATH`、**`XDG_*`**;供应商凭据 `ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`GITHUB_TOKEN`、`GOOGLE_APPLICATION_CREDENTIALS`(名字由 models.dev 目录数据驱动,内核带的那份 211 家、208 个名字) | **原样放行,一个不动** | 实测传空对象给 `utilityProcess.fork` 时子进程只剩 5 个键;GDAL/PROJ 靠 `LD_LIBRARY_PATH`,GEE 靠 `GOOGLE_APPLICATION_CREDENTIALS`,agent 的 `gh` 靠 `GITHUB_TOKEN`,内核用 `extendEnv: true` 把它们传给子进程;供应商凭据的读取点在 `KERNEL.md` 冻结区,内核优先级本就是配置文件 > `auth.json` > 环境;上游桌面端同形;XDG 见 §5.4 |
| **E 我们的注入** | 壳与内核之间的内部 ABI,由我们的代码在剥离**之后**写入 | §4.1 的表 | **写在最后一次剥离之后**;名字不成为公开配置面 | 它们带商标,所以顺序就是全部:先剥,后写 |
| **F 开发启动器旋钮** | 我们自己的启动脚本传给主进程的开关 | `electron:dev` 的 `OPENCHAMBER_ELECTRON_DEV`、`_ELECTRON_USE_BUNDLED_UI`、`_HMR_UI_PORT`、`_HMR_API_PORT`;更新器 e2e 夹具的 `_E2E`、`_UPDATER_E2E_URL` | **前四个仅未打包时豁免**,打包版一律剥;**后两个各形态都豁免**,它们没有构建期 define 时是惰性的,而夹具驱动的正是打包版 | 它们带商标,但发送方是我们的脚本;打包版没有 dev 发送方,一个 shell 里的 `OPENCHAMBER_ELECTRON_DEV=1` 不该把正式版翻成开发态 |

不在表里的都是类 C:默认放行。**黑名单只有 B,白名单只有 F,其余按商标。** 三张表都住在一个模块里。

供应商凭据不再单独成类,它就是类 C。放行的可见后果只有一件:用户 shell 里有 `ANTHROPIC_API_KEY`,GeoCode 的模型
列表里就会出现 Anthropic,虽然用户没在 GeoCode 里配过。那是用户自己的钥匙,不是别人的设置;一旦在界面登录或写进
配置文件,文件里的值优先,环境的值就不起作用。曾考虑过按 `_API_KEY` 后缀剥、其余 35 个名字手工二分再配一条读
models.dev 的绊线,否决:那 35 个里一大半是 `AWS_*`、`GOOGLE_APPLICATION_CREDENTIALS`、`GITHUB_TOKEN` 这类身兼
两职的名字,剥了断工具链,留了照样激活供应商,规则做不到比商标判据更好,却多出一张会漂的名单。

### 4.1 带商标却是我们自己要用的名字

这是设计里最要盯住的一张表。每一行都带商标,所以都会被剥;它们能工作,**只**因为我们的代码在剥离之后把它们写回去。
顺序一错,后果在最后一列。

| 名字 | 谁写 | 谁读、何时 | 顺序错了会怎样 |
|---|---|---|---|
| `OPENCHAMBER_DATA_DIR` | `applyShellDataRoot`(103 行;剥离函数尾部再写一次) | 主进程模块顶层(`sshManager` 552 行冻结成字符串);壳 11 处导入时冻结、7 处每次调用重算,共 76 个读取点 | 两组读到不同的根,设置在一处写、另一处读,`PATHS.md` §5 记过一次 |
| `OPENCHAMBER_MANAGED_PROCESS_REGISTRY` | 同上 | `lifecycle.js:1027` 启动时无条件回收孤儿,按这个目录里记录的 pid **杀进程** | 回落到默认目录;若与上游 OpenChamber 共用,他们的内核成回收候选 |
| `OPENCHAMBER_HOST` | `main.mjs:1570` | `index.js:1474` 与 `server-startup-runtime.js:25`,启动时 | 绑定地址回落 loopback,局域网访问设置失效 |
| `OPENCHAMBER_DESKTOP_LAN_ACCESS_ACTIVE` / `_BLOCKED_REASON` | 1571-1575 | `settings-helpers.js:942-944`,每次请求 | 设置页少两个字段 |
| `OPENCHAMBER_DIST_DIR` | 1577 | `static-routes-runtime.js:19`,**导入时** | 找不到界面文件,白屏 |
| `OPENCHAMBER_RUNTIME = 'desktop'` | 1578 | `index.js:170/223/629/1687`、`lifecycle.js:485`、`package-manager.js:396`、`tts/base-url.js:50`,其中 629 行**导入时** | 桌面通知、压缩、包管理器探测、远端 TTS 守卫全部走 web 分支;包管理器探测会阻塞主进程 |
| `OPENCHAMBER_OPENCODE_CWD` | 1581 | `hmr-state-runtime.js:10`,**导入时**;`main.mjs:1603` 传给内核 | 内核工作目录变成家目录 |
| `OPENCHAMBER_DESKTOP_NOTIFY` | 1585 | `index.js:625`,**导入时** | 桌面通知关闭 |
| `OPENCHAMBER_UI_PASSWORD` | 1587/1589 | `index.js:1573`,启动时 | 界面无口令;开了局域网访问时被 `bind-host.js` 拒绝启动 |
| `OPENCHAMBER_SKIP_API_COMPRESSION` | 1591 | `index.js:220`,每次请求 | 压缩打开,性能 |
| `OPENCHAMBER_SKIP_OPENCODE_START` | `kernel-boot.mjs:44` → `applyKernelConnectionToShellEnvironment` | `index.js:623`,**导入时** | **壳去磁盘找 opencode 拉起第二个内核**(§3 第 6 条) |
| `OPENCODE_HOST` | 同上 | `env-config.js:41`,**导入时** | 同上,那对变量的另一半 |
| `OPENCODE_SERVER_PASSWORD` | 同上 | `auth-state-runtime.js:48`,每次向内核的请求 | 壳对内核每个请求 401 |

内核那一半**不需要**任何继承来的带商标名字:`OPENCODE_SERVER_USERNAME`/`_PASSWORD` 由 sidecar 收到 IPC 后在自己
进程里设;将来要给内核的(`PATHS.md` §7 挂起的 `OPENCODE_DISABLE_AUTOUPDATE`、上游桌面端设的 `OPENCODE_CLIENT`、
agent-tool 插件的 `OPENCHAMBER_AGENT_TOOL_URL`/`_TOKEN`)一律走 `startEmbeddedKernel` 的 `overrides`,它叠在过滤之后。

三个带商标、树里**没有任何脚本设置**、只在测试里出现的名字——`OPENCHAMBER_MEMORY_ENABLE`、`OPENCHAMBER_STARTUP_PERF`、
`OPENCHAMBER_ELECTRON_LOAD_SERVER_UI`——剥掉等于今天的默认,不进白名单。开发脚本还设 `OPENCHAMBER_PORT`、
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
  1  import './geocode/environment-boundary.mjs'   ← **第一条 import**:模块加载即做第一次剥离,
                                                     早于 mintOutsideFileGrant 拉进来的服务器闭包,
                                                     早于第 50 行的 isDev(批 2)
103  applyShellDataRoot(process.env)               ← 注入数据根(类 E)
...
1500 inheritUserShellEnv() {
       probe → 合并(undefined 才填)→ 合并 PATH
       **stripInheritedForeignVariables(process.env, { keep })   ← 与合并同一函数体,原子**
       **applyShellDataRoot(process.env)                          ← 数据根被剥后立即重写,幂等**
     }
1527 shouldSkipLocalServer()  → 调 inheritUserShellEnv()   ┐ 两个上游调用点,
1534 spawnLocalServer()       → 调 inheritUserShellEnv()   ┘ 都自动带上剥离
1570 process.env.OPENCHAMBER_HOST = ...  …… 1593        ← 我们的注入(类 E),在最后一次剥离之后
1598 startEmbeddedKernel({ environment: process.env })   ← createKernelProcessEnvironment:前缀 + 黑名单
     applyKernelConnectionToShellEnvironment            ← OPENCODE_HOST / _SERVER_PASSWORD / SKIP
1608 await import('@openchamber/web/server/index.js')
       index.js:756  **if (!process.versions.electron) applyLoginShellEnvSnapshot();**
                     /* applyLoginShellEnvSnapshot(); */   ← 上游行逐字节包进注释
```

三条不变量,每条配绊线(§7):

1. **合并之后立刻剥离,同一函数体内。** 剥离不再是一个可以被隔开的独立语句。上游若新增第三个
   `inheritUserShellEnv()` 调用点,自动带上。
2. **所有注入都在最后一次剥离之后。** 现有的 1570-1593 与 kernel-boot 的连接写入已经满足;数据根
   (103 行)不满足,所以在剥离函数里重写一次。
3. **壳内不做第二次合并。** 主进程已经把同一个登录 shell 并进同一份 `process.env`,服务器再并一次只会
   把剥掉的填回来。判据 `process.versions.electron` 是进程的固有事实,不是变量,丢不了;`openchamber
   serve` 单独跑时它为空,上游行为不变。实测 `ELECTRON_RUN_AS_NODE=1` 下它仍为 `43.3.0`,所以
   §7 的运行时测试可以用 Electron 二进制当 Node 跑。

⚠️ 第 3 条是对上游 `index.js` 的一处一行改动,形态按 `CONVENTIONS.md` §5:新增一行条件调用,上游原行
逐字节包进 `/* */`,前后标记。它不是「早退」也不是「变量门」——`OPENCHAMBER_RUNTIME === 'desktop'`
这样的门正是 §3 第 6 条批评的那种,变量丢了门就开。

服务器的 `getLoginShellEnvSnapshot()` 仍会在第一次需要时(给 PTY 拼 PATH)懒探测一次,那个 `spawnSync`
没有超时,是上游既有行为;跳过第 756 行只是把它挪出了启动关键路径,没有消除。记为上游问题。

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
Node 程序的选择,决策点 §6.4)。

`utilityProcess.fork` 的 `execArgv` 选项我们不传,保持为空。

口令:内核口令已走 IPC;界面口令随 `OPENCHAMBER_` 入表后自然不再进子进程。批 1 若先于批 2 落地,
用一条 `overrides: { OPENCHAMBER_UI_PASSWORD: undefined }` 顶上,批 2 后删掉。

内核子进程**收到的**环境就是它的 bash 工具、MCP、LSP、git、GEO 子进程**继承的**环境——内核起的每个
子进程都是 `{...process.env, ...overlay}`(审计 B 组 §5,仅三处例外)。所以这一层过滤的收益直接传到
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
  在第 50 行就读,所以第一次剥离必须早于它——这就是 §5.2 第 1 行把剥离搬进首个 import 的原因;
- e2e 两个名字各形态都留:更新器 e2e 夹具驱动的正是打包版,而没有构建期 define 时它们是惰性的;
- `OPENCHAMBER_DISABLE_PWA_DEV` 是 vite 进程读的,不经过主进程,不用管。

被否决的替代:把这些旋钮改成命令行参数。要动主进程的读取点,全是上游行,换来的只是少一张 6 行的表。

### 5.6 外部内核那条路(批 3)

目标是让 §3 第 6 条的能力**不存在**,而不是被一对变量拦着。形态:`lifecycle.js:1078` 落到 `startOpenCode()`
的分支前加一句早退——`process.versions.electron` 为真时抛错「GeoCode 自己持有内核,没有托管启动」——
上游分支逐字节留在后面。`openchamber serve` 单独跑时不受影响。

顺带两件:那对变量的脆弱性(`effectivePort` 为 `null` 时静默落到 PATH 扫描)被早退一并关掉;
`extraResources` 里随包带的 `opencode-cli` 二进制只服务于这条路,批 3 决定去留(决策点 §6.6)。

### 5.7 CLI 与 `startup enable`:不在产品面

打包清单 `files` 只有 `dist-bundle/main.mjs` 与 `preload.mjs`,web 服务器打进了主进程 bundle,
`packages/web/bin/` 不随应用分发。`openchamber serve` 与 `startup enable` 是仓库里的代码,不是 GeoCode
的入口。**本设计不改它们**,在 `DESKTOP.md` §7 产品能力边界记一条「CLI 不是产品入口」,并配一条绊线:
`main.mjs` 与 `geocode/*.mjs` 不引用 `packages/web/bin`。

## 6. 决策点

需要产品拍板的七件,每件带推荐。不拍板的默认按推荐执行。

| # | 问题 | 推荐 | 理由 |
|---|---|---|---|
| 6.1 | 类 B(`NODE_OPTIONS` 一类)不带商标,按总原则该放行;是否作为唯一例外从内核子进程环境去掉 | **去掉** | 它们既不是配置也不是凭据,是注入代码、让子进程崩溃或往磁盘写文件的运行时开关,三条都实测过;上游自己也删 `DEBUG` 与 `LD_PRELOAD`,这只是把同一个理由用全。只动内核子进程的环境,壳进程不动 |
| 6.1a | 供应商 API 密钥是否也只认配置文件 | **已定:放行**(类 C) | 不带商标,是用户自己的钥匙;读取点在冻结区;内核优先级本就是配置文件 > `auth.json` > 环境;上游桌面端同形。§4 末段记了被否决的后缀规则 |
| 6.2 | 上游文档承诺可从 shell 设的 `OPENCHAMBER_*`(`CONTRIBUTING.md` 的 HMR 端口、docker 的 `UI_PASSWORD`/`HOST`/`TUNNEL_*`) | **剥。** HMR 端口归类 F 豁免;docker 的那批 GeoCode 没有 docker 形态 | 桌面形态没有这些面;`README.md` 实际一个环境变量都没写 |
| 6.3 | `XDG_*` | **保留并统一**(§5.4) | 是标准不是配置;开发沙箱与内核都依赖 |
| 6.4 | `NODE_TLS_REJECT_UNAUTHORIZED`、`LD_LIBRARY_PATH`/`DYLD_LIBRARY_PATH` | **保留** | 不改代码;用户对自己工具链的选择;地理工具链依赖后两者 |
| 6.5 | `entitlements.mac.plist` 的 `allow-dyld-environment-variables` 与 `disable-library-validation` | **单独调查,不在本设计** | 上游注释说是给 Electron JIT 与 native 模块的(`bun-pty`、`node-pty`、`sherpa-onnx-node` 三个 native 依赖);去掉可能让它们加载失败。本设计从子进程侧删 `DYLD_INSERT_LIBRARIES` 已覆盖注入路径 |
| 6.6 | 随包的 `opencode-cli` 二进制 | **批 3 与外部内核路径一起决定**;倾向移除 | 它唯一的消费者是那条路 |
| 6.7 | CLI(`openchamber serve`、`startup enable`) | **不改,记为非产品入口**(§5.7) | 不随应用分发;改它是另一个交付物 |

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

**顺序绊线(源码文本,升级现有的那条)**
- `stripInheritedForeignVariables` 的调用出现在 `inheritUserShellEnv` 函数体内、`for` 合并循环之后;
- `index.js` 第 756 行处存在 `/* applyLoginShellEnvSnapshot(); */` 且其前一行是带 `process.versions.electron`
  的条件调用;
- `inheritUserShellEnv();` 的每一处调用都在 `startEmbeddedKernel({` 之前(不变量 2:剥离现在随合并走,
  一次晚于内核连接写入的合并会把 `OPENCODE_HOST` 与口令一并剥掉);
- 现有的「剥离早于 kernel start 与 server import」保留。
- 反证:各删一行,各应变红。

**前缀覆盖绊线(现有那条,扩到壳侧)**
- 现有:扫内核两个 flag 注册表,所有引号里的大写名必须被前缀表覆盖。保留,并把没用的 `notEnvironment` 表删掉;
- 新增:扫 `packages/web/server/**` 与 `main.mjs` 里 `process.env.X` / `env.X` 形状的读取,去掉注释,
  名字以 `OPENCODE_`/`OTEL_`/`OPENCHAMBER_` 开头的必须在前缀表内。它今天必然全绿,存在的意义是钉住
  「壳读的名字与表同源」这条 `DESKTOP.md` §8.2 已经许下但没兑现的承诺。

**运行时(新,`geocode/` 下,进 `test-gate.sh` 的 electron 段)**
- 用 `ELECTRON_RUN_AS_NODE=1 <electron> driver.mjs` 跑一个驱动脚本:`SHELL` 指向一个打印
  `OPENCODE_CONFIG=/probe\0OTEL_EXPORTER_OTLP_ENDPOINT=http://probe\0XDG_CONFIG_HOME=/probe-xdg\0` 的桩;
  驱动先按 5.2 的顺序做剥离与注入,再 `await import('@openchamber/web/server/index.js')`,断言导入后
  `OPENCODE_CONFIG` 与 `OTEL_EXPORTER_OTLP_ENDPOINT` 仍为 `undefined`。这是对不变量 3 的真实进程证明;
- 反证:临时撤掉 756 行的屏蔽,应变红(A2 组已经用同样的桩在未屏蔽的现状上跑出了红)。

**真实内核(`scripts/kernel-env-probe.sh`,手工门)**
- 一个不开窗口的 Electron 应用,用真实的 `utilityProcess.fork` 走 `startEmbeddedKernel` 把内核拉起来,继承环境里下了
  四种毒:`OPENCODE_CONFIG_DIR`/`OPENCODE_CONFIG` 指向一份写着 `username: poison-user` 的配置、`OTEL_EXPORTER_OTLP_ENDPOINT`
  指向本地一个只数连接的监听、`NODE_OPTIONS=--require` 一个落标记文件的脚本、`OPENCHAMBER_UI_PASSWORD`。观察四件事:
  `/config` 有没有回显毒配置、标记文件有没有出现、监听收到几次连接、`ps -E` 的环境块里有没有这四个名字;XDG 重定向到
  临时目录,内核不碰真实根。
- 第二次绕过边界直接 `startKernelHost`,同一份毒:四个探针必须全响。2026-09-03 实测:产品路径四项全空、XDG 生效;
  对照组配置回显 `poison-user`、标记文件写出(`--require` 在真实 utility 进程里执行了)、OTLP 监听 3 次连接、
  环境块四个名字全在。绿的条件是「A 全空且 B 全响」,少一边都红。

**真实会话(手工,并入 `CONVENTIONS.md` §7 那段 foreign-writes 流程)**
- 从终端 `export OPENCODE_CONFIG_DIR=/tmp/poison OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:4318
  OPENCHAMBER_SKIP_LOCAL_SERVER=1` 后起 `electron:dev:bundled`,旁边 `nc -l 4318`:应用正常起来、
  有内核、`nc` 收不到任何连接、设置页仍落 GeoCode 根。**这道门看读,foreign-writes 看写,互补。**
- 打包版复验 `NODE_OPTIONS`:实验用的是合成的 `isPackaged`,不是 electron-builder 产物,结论充分但应在
  一次真正的打包上再跑一遍。

## 8. 分批

| 批 | 内容 | 动到的文件 | 依赖 |
|---|---|---|---|
| **1 · 已落地(2026-09-03)** | 剥离追加在 `inheritUserShellEnv` 尾部;`index.js:756` 屏蔽;黑名单 `CHILD_DENYLIST`;界面口令 override;`keep` 参数提前进来给批 2 用;顺序绊线三条(函数体内的剥离、`index.js` 的屏蔽形态、口令 override);运行时测试 `login-shell-boundary.test.js`(桩 shell 驱动真实导入,plain 为对照、electron 为断言)。三条绊线各做过反证,全项目门绿,写入检测前后干净;真实内核探针 `scripts/kernel-env-probe.sh` 绿,把子进程过滤临时拆掉后判 RED | `kernel-environment.mjs`(+23/-9)、`main.mjs`(+7/-0)、`index.js`(+7/-1,那 1 行是逐字节包进注释的上游行)、两个测试文件扩充、两个新测试文件、探针脚本四个文件 | 无 |
| **2 · 已落地(2026-09-03)** | `OPENCHAMBER_` 入表;两张白名单;第一次剥离搬进首个 import(`environment-boundary.mjs`);`applyShellDataRoot` 在合并尾部的剥离后重跑;删批 1 的口令 override;壳侧前缀覆盖绊线;白名单来源绊线;文档(§9)。四条新绊线各做过反证,全项目门绿,内核探针绿 | `kernel-environment.mjs`、`environment-boundary.mjs`(新)、`main.mjs`(+8/-8,删的 8 行全是批 1 自己的)、tests、`PATHS.md`、`DESKTOP.md`、`CONVENTIONS.md`、`kernel-tui.sh` | 批 1 |
| **3** | 外部内核路径 fail-closed;`opencode-cli` 资源去留;绊线 | `lifecycle.js`(1 处早退)、`package.json`、tests | 无,但排在 2 后以免同时改 `index.js` 附近 |

批 1 的改动面:`main.mjs` 加两行(函数尾部的剥离与数据根重写),`index.js` 改一行,其余在我们自己的模块与测试里。

## 9. 文档改动清单(随批 2)

| 文件 | 改什么 |
|---|---|
| `PATHS.md` §3.4 | 删「环境变量(对外)`GEOCODE_*`」一行;内核内部行保留 |
| `PATHS.md` §3.6 | 缩成指回本文,保留「为什么在进程边界」那段;补 XDG 一句 |
| `DESKTOP.md` §2 | 内部 ABI 表删 `OPENCODE_SERVER_USERNAME` 与 `OPENCODE_SKIP_START`(从未写入),删「再从公开的 `GEOCODE_*` 映射」 |
| `DESKTOP.md` §5.1 第 3 步 | 改为「剥离继承的三个前缀,再由我们的代码注入」 |
| `DESKTOP.md` §8.2 | 指回本文 |
| `DESKTOP.md` 阶段 6 | 「验证环境变量翻译」改为「环境边界见 `ENVIRONMENT.md`」;加批 1/2/3 的完成记录 |
| `DESKTOP.md` §7 | 加「CLI 不是产品入口」 |
| `CONVENTIONS.md` §7 | foreign-writes 那段加 §7 的读侧手工检查;`electron:dev` 描述改为事实(它是我们的 dev 脚本起的壳,分叉在 5 秒健康探测的竞态上,不是 Electron 分叉的) |
| `scripts/kernel-tui.sh` | 删「Same two rules apply to the Electron shell」;它自己的剥离改为调同一张表(或至少加 `OTEL_`);`GEOCODE_*` 映射是沙箱专用,注释说清「仅此脚本,产品无此通道」 |

## 10. 记录、不修

上游代码里与本题相邻但不在 GeoCode 增改面上的,记在这里,不为它们改上游:

- `ssh-manager.mjs` 把 SSH 口令放进子进程环境块(有上游测试钉着);
- 服务器懒探测登录 shell 的 `spawnSync` 无超时(主进程那次有 5 秒);
- `lsp/server.ts:571` elixir-ls 的 `{ MIX_ENV: 'prod', ...process.env }` 顺序反了;
- 内核把 `OPENCODE_CONSOLE_TOKEN`、`AWS_BEARER_TOKEN_BEDROCK`、`AICORE_SERVICE_KEY` 写回自己的 `process.env`,
  于是 agent 的 bash 能读到;`control-plane/workspace.ts` 把整份 `auth.json` 序列化进子进程环境变量;
- 九个供应商 handler 让环境赢过 `auth.json`(Cloudflare、Snowflake 等),与总规则相反;
- `OPENCODE_TEST_HOME`、`OPENCODE_TEST_MANAGED_CONFIG_DIR` 两个测试钩子在生产可达(前缀已剥,到不了内核);
- `startup enable` 的全量环境快照。

这些都在冻结区或上游自有逻辑里。它们的共同缓解是本设计的第一层:这些变量根本到不了我们的进程。
