# GeoCode Desktop 封装与迁移设计

> 本文确定 GeoCode 唯一产品形态的桌面架构、OpenChamber 迁移边界、Agent 内核封装、
> 生命周期、安全契约与双上游维护方式。本文写的是目标设计与实施顺序,不表示桌面侧已经实现;
> 当前实现状态仍以 `OVERVIEW.md` §7 为准。

---

## 1. 决策

GeoCode 只有一种产品形态:**安装在用户本机的桌面应用**。

- 只支持 macOS arm64 与 Windows x64;
- 用户只下载、安装、启动一个 GeoCode 应用;
- 不提供 Web / PWA、VS Code、CLI、Mobile、远程 Server 等产品版本;
- GeoCode Agent 内核随安装包交付,不要求也不允许正式版依赖用户另装的 OpenCode;
- 界面与桌面能力迁自 OpenChamber,Agent 内核由当前仓库的 OpenCode 薄 fork 提供;
- OpenChamber 与 OpenCode 的多端源码可以作为上游内容保留在 vendor 树中,但不因源码存在而进入
  GeoCode 的构建、运行时或用户界面。

这项决策把「源码维护范围」与「产品能力范围」分开。完整保留上游目录有利于合并更新;
只装配桌面目标保证用户面对的仍是一个边界清晰的 GeoCode。

---

## 2. 目标架构

### 2.1 组件与进程

```
GeoCode Desktop 安装包
│
├── Electron main                         桌面壳与唯一进程管理者
│   ├── GeoCode Shell Runtime             由 OpenChamber Web Server 收敛而来,同进程
│   └── utilityProcess.fork
│       └── GeoCode Agent Kernel          Node ESM bundle
│           └── QGIS / GEE 等地理子进程   由 GeoKernel Runtime 管理
│
└── Electron renderer
    └── GeoCode React UI                   由 OpenChamber shared UI 迁入
```

操作系统层面有三类长驻进程:Electron main、renderer、Agent Kernel utility process。
Shell Runtime 是 main 进程内的本地服务,不是额外 sidecar。QGIS、GEE 等只在工具执行期间作为
Agent Kernel 的后代进程存在。

### 2.2 两段本地通信

界面不直接接触 Agent Kernel:

```
React UI
  └── HTTP / SSE / WebSocket
      └── Shell Runtime (127.0.0.1:随机端口)
          ├── OpenChamber 自有的桌面内部 API
          └── 未认领的 Agent API 请求反向代理
              └── Agent Kernel (127.0.0.1:另一随机端口,HTTP Basic)
```

两段通信各有独立职责:

| 通道 | 承载 | 凭据归属 |
|---|---|---|
| UI → Shell Runtime | 文件、终端、设置、通知及代理后的 Agent API | renderer 只获得这一段本次运行所需的凭据 |
| Shell Runtime → Agent Kernel | 会话、模型、权限、工具、事件及地理数据面 | Kernel 口令只在 main / Shell Runtime 内存中存在 |

Kernel 的 Basic 口令不下发给 renderer。这样即使将来 Shell Runtime 增加请求过滤或审计,
也不会被一条拿到 Kernel 直连凭据的前端请求绕过。

### 2.3 与 OpenCode Desktop 的关系

GeoCode 沿用 OpenCode Desktop 已验证的内核封装方式:

- `build-node` 将 `opencode/src/node.ts` 构建为 Node ESM bundle;
- Electron 以 `utilityProcess.fork` 托管 bundle;
- main 选择 loopback 端口并生成随机口令;
- utility process 通过进程消息报告 ready / error / stopped;
- preload 只向 renderer 暴露必要的桌面边界。

GeoCode 与 OpenCode Desktop 的区别是中间多一层 Shell Runtime。它不是另一个产品 Server,
而是 OpenChamber React UI 正常工作所需的桌面内部后端。

### 2.4 已验证的 OpenChamber 接缝

对 OpenCode Desktop 与 OpenChamber 的源码对照确认了三条事实(2026-08-28 在 OpenChamber
v1.21.0 上复核):

- OpenCode Desktop 的稳定路径是 `build-node` → Node ESM bundle → `utilityProcess.fork` →
  `Server.listen`,main 持有随机端口与随机口令;
- **OpenChamber 自己不是这么做的**:`utilityProcess` 在它整个 `packages/electron` 里一处都
  没有,启动 OpenCode 的是 Shell Runtime——`server/lib/opencode/lifecycle.js` 用 `spawn` 拉起
  一个外部 CLI 二进制,而那个二进制由 `scripts/prepare-opencode-cli.mjs` 按 root `package.json`
  里钉死的 `@opencode-ai/sdk` 版本号下载、经 `extraResources` 打进安装包。**所以 utility
  process 那条路径是 GeoCode 要新增的,不是接管上游已有的**;
- OpenChamber React UI 只访问 Shell Runtime。Shell Runtime 已有「外部 OpenCode + skip-start」
  模式(`server/index.js` 的 `ENV_SKIP_OPENCODE_START`),能代理 HTTP / SSE / WebSocket 并在
  服务端附加 Basic 认证——**这正是注入点:上游为「连接任意外部 OpenCode」写的能力,恰好是我们
  需要的那个接缝**,`lifecycle.js` 那 1308 行因此一行都不用改。

GeoCode 因此不改 React 的数据入口,也不让 Shell Runtime 获得进程所有权。Electron main 先启动
Kernel,再在动态导入 Shell Runtime 前写入以下**内部进程 ABI**:

| 内部字段 | 值 |
|---|---|
| `OPENCODE_HOST` | 本次启动的 Kernel loopback URL |
| `OPENCODE_SERVER_PASSWORD` | 本次启动生成的 Kernel Basic 口令;用户名不写,壳侧默认值与 sidecar 写死的 `opencode` 一致 |
| `OPENCHAMBER_SKIP_OPENCODE_START` | 固定为 `true` |

这些名字不成为 GeoCode 的公开配置;main 先剥离继承环境里带商标的名字,再写入受管连接
(`ENVIRONMENT.md` §5.2)。对 Shell Runtime 而言 Kernel 是「外部服务」,但对整个应用而言它仍是
Electron 自己拥有的内嵌进程。

Shell Runtime 到 Kernel 的这一段使用固定到本次应用进程的连接。上游为「外部服务器」写的重启在这里
只会重新探测健康,所以配置生效不能沿用上游「重启进程」的做法:壳在 Electron 下把「应用配置」交给
Kernel 自己的失效通道,不重启任何进程(§5.2);真正的进程重启只留给崩溃恢复,由 Electron main
执行(§5.2 第二部分)。

代理**剥掉 `/api` 前缀**再转发,这条之所以成立,是因为 Kernel 同时挂着裸路径(v1 wire)与
`/api` 前缀(v2)两套。SDK v2 发出的请求自带 `/api`,叠加客户端 baseUrl 后剥一层正好命中 v2;
直写 `/api/…` 的调用剥掉后命中 v1。代价是:`build-node` 存根掉 OpenCode 自带 web UI 之后,
上游原本由 SPA fallback 兜住的裸路径不再回 HTML 而是 404 —— 已知只影响 `debug.ts` 的诊断
字段,而那里原本拿到的也不是健康数据。

---

## 3. 组件所有权

### 3.1 Electron main

Electron main 是唯一生命周期所有者:

- 创建窗口、菜单、文件选择器、系统通知与深链;
- 选择 Shell Runtime 与 Agent Kernel 的随机端口;
- 生成进程期口令;
- 启动、监视、重启和关闭 Agent Kernel utility process;
- 启动和关闭同进程 Shell Runtime;
- 经 preload 向 renderer 下发 Shell Runtime 连接信息;
- 应用退出时按顺序关闭服务并兜底回收进程树。

Shell Runtime 不得再沿用 OpenChamber 当前的「查找系统 OpenCode → 下载或选择 CLI → spawn」
生命周期。正式版的 Kernel 只有一个来源:安装包内由本仓 `kernel/` 构建的产物。

### 3.2 Shell Runtime

Shell Runtime 由 OpenChamber `packages/web/server` 收敛而来,但它不是 GeoCode Web 版。
它只在 Electron main 内运行、只监听 loopback、只服务本机 renderer。

职责:

- 为 React UI 提供 OpenChamber RuntimeAPIs 的桌面实现;
- 代理 Agent Kernel 的 HTTP / SSE / WebSocket;
- 在代理时附加 Kernel 认证;
- 提供少量不属于 Agent Kernel 的桌面后端能力;
- 将 Kernel 不可用、重启和版本不匹配转为稳定的 UI 状态。

非职责:

- 不发现或升级系统 OpenCode;
- 不启动 Agent Kernel;
- 不监听 LAN;
- 不提供远程配对、Relay、Tunnel 或托管 Web UI;
- 不直接成为 Agent、权限或地理状态的第二事实源。

### 3.3 React UI

界面迁自 OpenChamber `packages/ui`,技术栈为 React。它是纯客户端:

- 通过同源 Shell Runtime 与 Agent Kernel 交互;
- 通过 preload bridge 请求原生桌面动作;
- 不 import `kernel/` 源码;
- 不自行推导权限、安全或环境就绪结论;
- 不因隐藏一个入口就假设对应能力已经被安全禁用。

### 3.4 Agent Kernel

Agent Kernel 继续保持接近黑盒的边界:

- 提供 OpenCode HTTP / SSE / WebSocket 契约;
- 承载 GeoAgent、会话、模型、OAuth、权限与工具执行;
- 同进程承载 GeoKernel 的工具面、状态面与数据面;
- 管理全部地理子进程并在宿主终止前清扫;
- 不依赖 Electron、React 或 OpenChamber 模块。

---

## 4. 构建与分发

### 4.1 单一安装包

每个平台的安装包只包含:

- Electron main / preload;
- GeoCode React 静态资源;
- Shell Runtime 的 Node 代码及必要依赖;
- GeoCode Agent Kernel Node bundle;
- 两侧所需的原生模块与产品资源。

不包含独立可安装的 GeoCode CLI,也不暴露「选择 OpenCode 路径」设置。包内 Kernel 是产品内部
组件,不是用户面对的第二个程序。

Kernel 由 `packages/electron/scripts/prepare-geocode-kernel.mjs` 从 `kernel/` 暂存进包,替代上游
按 SDK 版本号从网络下载二进制的 `prepare-opencode-cli.mjs`。两条布局约束由 bundle 的构建方式
决定,不是偏好:

- 四个 `.wasm` 按 `import.meta.url` 解析,**必须与 bundle 同级**;文件名是内容哈希,Kernel 一
  重建就全变,由打包验收测试从 bundle 里逐一反查;
- 两个 external 依赖放在 `deps/` 而**不是 `node_modules`** —— electron-builder 会无条件把后者
  从 `extraResources` 剔除,`filter` 也压不住,而它们是静态 ESM import,缺一个就加载即死。
  bundle 里的裸说明符因此由暂存脚本改写成相对路径,**改写次数为零即构建失败**。

### 4.2 只构建桌面闭包

`desktop/` 可以完整保留 OpenChamber monorepo,但发布任务只构建桌面闭包:

| 上游部分 | GeoCode 构建用途 |
|---|---|
| `packages/electron` | 桌面壳 |
| `packages/ui` | React shared UI |
| `packages/web` | renderer 入口、静态资源与桌面内部 Shell Runtime |
| `packages/vscode` | 不构建 |
| `packages/mobile` | 不构建 |
| Web/PWA/CLI 发布脚本 | 不执行 |

保留源码不是保留产品能力。真正的产品边界由构建入口、运行时注册和界面装配三处共同确定。

### 4.3 Kernel 与 SDK 同源

Shell 使用的 `@opencode-ai/sdk` 必须由**同一份 GeoCode Kernel OpenAPI**生成。OpenChamber
应用版本、上游 SDK npm 版本与 GeoCode Kernel 版本是三个独立数字,不能靠版本号看起来接近
来推断兼容。

一次发布应绑定以下信息:

| 字段 | 作用 |
|---|---|
| app version | 用户看到的 GeoCode 版本 |
| shell upstream commit | 本次采用的 OpenChamber 基线 |
| kernel upstream commit | 本次采用的 OpenCode 基线 |
| GeoCode kernel commit | 包含薄补丁的实际 Kernel 版本 |
| API schema fingerprint | 证明 SDK 与运行中 Kernel 的接口来自同一契约 |
| platform / arch | 防止打入错误原生模块或 bundle |

精确的 SDK 交付形式(本地 workspace 包或构建期产物)属于实施选择;「与 Kernel 同源」不是。

**已执行的一半(2026-09-10)**:壳的四处声明——安装根自己那份加三个 workspace 包——一律钉在本仓 vendor 的内核版本上,由 `electron/geocode/sdk-source.test.mjs` 断言。它靠遍历安装根与 workspaces 找声明,不靠清单:第一版用手写清单,当场漏掉了安装根自己那处。此前四处钉的是 `1.18.23`,那是壳上游的 pin——OpenChamber 不自带内核、只能连用户装的那个,对不齐是它的常态;GeoCode 两边都出,所以能对齐。

**没执行的一半**:版本相同不等于同源。壳装的仍是上游发布的产物,而不是由**我们这份内核**的 OpenAPI 生成的客户端——两者的差别今天看不出来(实测 1.18.18 与 1.18.23 的 162 条路径、1409 个导出类型逐一相同),但它有一个立刻能看见的后果:**`/geo/*` 在任何一份 SDK 里都没有**。生成线是现成的(`kernel/packages/sdk/js/script/build.ts`,它 `bun dev generate` 导出内核 OpenAPI 再生成客户端),从 vendor 之后没跑过。阶段七要调地理端点时补,连同一条「路由定义源码哈希 ≠ 生成印记就红」的绊线。

### 4.4 原生构建

- macOS arm64 安装包在 macOS arm64 上构建;
- Windows x64 安装包在 Windows x64 上构建;
- 禁止用一个平台交叉产出另一个平台的正式包;
- 打包前验证 Electron、Kernel 与全部 `.node` 原生模块的目标架构一致。

### 4.5 开发形态不等于产品形态

上游 `resolveInitialUrl` 在开发模式下先探 HMR API 端口,探通就不再调用 `spawnLocalServer()` ——
而内嵌 Kernel 正是在那里启动的:

| 命令 | Kernel |
|---|---|
| `bun run dev` | 不启动,Shell Runtime 去找系统 opencode |
| `OPENCHAMBER_ELECTRON_USE_BUNDLED_UI=1 bun run dev` | 启动 |
| 打包版 | 启动 |

第二行走的是上游既有的 `packagedUi` 分支,零改动。删掉那条 HMR 分支能让两者统一,但那是重排
上游控制流,为一个开发便利付这个代价不划算。

---

**开发启动跑的内核产物必须来自当前签出。** 两个 `electron:dev*` 脚本先运行 `prepare-geocode-kernel.mjs`,它按
`kernel-stamp.json` 里记的树哈希与脏标记决定复用还是重建:与当前 `HEAD:kernel` 不一致、或暂存时与现在任一方有
未提交改动,都重建。绊线 `electron/geocode/kernel-freshness.test.mjs`。

### 4.6 版本号

上游的发布脚本每次发版把五个 `package.json` 的 `version` 一起改写。这些数字留给上游,合并时无条件取
上游,它们从此只表示「壳基于 OpenChamber 哪一版」。GeoCode 的产品版本是另一个数字,从 `1.0.0` 起,
放在自己的文件里:Electron 包一份、web 包一份手抄(两个包不能互相 import),由测试钉住相等,
由 `scripts/bump-geocode-version.mjs` 一次改两份。三个读取点都读它:Electron main 的应用版本(更新检查
用它比对)、渲染层的 `__APP_VERSION__`、打包时经 `extraMetadata.version` 写进安装包与安装器元数据。
About 对话框沿用上游的版式,只显示图标、产品名、产品版本与代码仓库链接;壳基线那个数字仍由
`/api/system/info` 报出,供 §9.5 要求的发布记录与诊断使用,不上界面。

## 5. 启动、重启与退出

### 5.1 启动顺序

1. Electron main 建立 GeoCode appId、userData 与日志路径;
2. 剥离继承环境里带商标的名字(`OPENCODE_*`、`OTEL_*`、`OPENCHAMBER_*`),再由我们的代码注入内部 ABI
   (`ENVIRONMENT.md` §5.2);
3. 选择 Kernel loopback 端口并生成随机口令;
4. 启动 Kernel utility process,等待 ready 与 `/global/health`;
5. 启动 Shell Runtime,以注入的 Kernel URL 与认证作为唯一上游;
6. 选择 Shell Runtime loopback 端口并确认健康;
7. 创建窗口,经 preload 下发 Shell Runtime 连接信息;
8. renderer 加载打包内 React UI 并开始同步。

窗口不能在「服务地址尚未确定」时自行猜测默认端口。失败必须落在可诊断的启动阶段,
而不是让 UI 在一个永远连不上的地址上转圈。

**启动只有两种结果。** 上游桌面端启动时先回答「这个界面该连哪台服务器」,围绕它有首次启动选择页、
远程主机探测与几种恢复页;GeoCode 的内核在应用里,这个问题不存在。主进程读到的主机配置恒为
「本机」(`readDesktopHostsConfig` 首行返回,存量设置文件里的主机列表不再被读),所以结果只剩:
Kernel 起来了,进主界面;Kernel 没起来,`spawnLocalServer` 记下失败(错误、Kernel 最后几十行输出、
日志路径,`electron/geocode/kernel-failure.mjs`)并且不启动 Shell Runtime,窗口照常打开,渲染进程
把任何非主界面的启动结果都交给 GeoCode 自己的失败屏(`ui/src/geocode/GeoCodeKernelFailureScreen.tsx`),
它经 `geocode_kernel_failure` 读那份记录,提供「在文件夹中显示」日志与重试(重新启动应用)。
上游的选择页、安装页与恢复页在桌面壳下没有到达路径。运行中 Kernel 死亡的处理见 §5.2 第二部分。

### 5.2 配置生效与 Kernel 重启

**配置生效不重启进程。** 设置页保存的每一项都先落盘(壳写内核配置根下的文件,或经代理调 Kernel 的
`PUT /auth`),再由用户点「应用」。上游在这一步重启它自己 spawn 的 CLI;GeoCode 的壳不拥有 Kernel,
改为调 Kernel 的 `POST /global/dispose`:Kernel 丢弃全部实例状态并失效全局配置缓存,下一个请求按当前
磁盘重建。这条通路的两半:

- Kernel 侧:全局配置层的缓存永不过期,唯一失效口原本只被 `PATCH /global/config` 调用,配置、环境变量、
  外挂进程、界面四层都够不到它,因此 `/global/dispose` 的处理器补一次失效调用。上游对这个端点没有生产
  调用点,语义变更的辐射面为零;路由与 OpenAPI 不动,SDK 不重生成。单靠丢弃实例救不了全局文件的改动,
  这是实测结论,不是推断;
- 壳侧:`refreshOpenCodeAfterConfigChange` 在「外部服务器 + Electron」下走这条通路并返回「已重载」,上游的
  `/api/config/reload` 路由、待应用徽标、全屏遮罩与成功后的全量重拉因此一行不改地走通;MCP OAuth 授权前的
  强制应用、技能重命名与升级路由也不再谎报。判据仍是 `process.versions.electron`:Electron 下的外部服务器
  只可能是内嵌 Kernel。

**2026-09-09 真实会话验过这条通路**,补的是 09-06 那笔账:开发启动此前一直跑 08-30 的内核产物,
所以这处内核改动只被单测证明过。做法与判据:在设置里新建一个自定义供应商 —— 它只写进 `geocode.jsonc`,
模型目录里没有它 —— 保存后点「应用」,它出现在供应商列表(该列表取自 SDK 的 `config.providers()`,
也就是 Kernel);删掉它、**不点应用**,它仍在;点了才消失。全程端口不变、进程未死。
⚠️ **判据必须是「目录里没有的东西」**:先用凭据试过一轮,结论是错的 —— 模型列表来自模型目录,
有没有凭据都列得出来,「看得见」与「能用」是两回事(用户指出的)。凭据那条路同一轮也验了:
加完 key 不点应用则选得到、用不了,点了才能用。

丢弃实例会像手动中断一样终止正在运行的会话,Kernel 没有忙时保护。壳在丢弃之前用自己的活动会话计数拦下:
有会话在跑就报错并保留徽标,让用户等它结束再应用。这是刻意选「拦下」而不是上游的「确认后中断」:
刷新是用户主动点的,等得起。

丢弃后实例事件流会被 Kernel 掐断,壳的上游读取器约 250 毫秒后重连;Kernel 的 SSE 不带事件 id,窗口内
的事件无法回放,由界面收到 `global.disposed` 后整体重新 bootstrap 兜住。

两条相关约束:壳挑全局配置文件的候选顺序必须与 Kernel 一致(`geocode.jsonc`、`geocode.json`、
`config.json`),否则目录里多一份遗留文件时两边写进不同的文件;壳写全局配置是整文件覆盖,注释不保留,
这是上游形态。

**Kernel 重启只用于崩溃恢复与显式重启**,由 Shell Runtime 请求 Electron main 执行:

1. UI 发起明确的 apply / restart 动作;
2. main 将 Shell Runtime 的上游状态置为 restarting;
3. main 停止旧 Kernel,确认端口释放;
4. main 启动新 Kernel并完成健康检查;
5. main 将新的 URL / 认证注入 Shell Runtime;
6. Shell Runtime 重绑代理与事件流;
7. UI 从快照重新建立状态。

Shell Runtime 不得自行 spawn 第二个 Kernel;renderer 也不得持有旧 Kernel 地址并尝试直连。重启后端口
重新分配、口令复用;壳侧只需更新 Kernel 基址与端口并重绑事件流,代理按请求解析目标,不重挂。
这一部分尚未实现:main 目前只有停止与强制结束,Kernel 崩溃后壳也不会把状态翻为不可用。

### 5.3 正常退出

顺序固定:

1. 停止接受新的 UI 请求;
2. 关闭 Shell Runtime 的 SSE / WebSocket 与监听器;
3. 请求 Agent Kernel 正常停止;
4. Agent Kernel 清扫 GeoKernel 登记的全部地理子进程;
5. 超过上限仍未退出时,Electron main 强制结束 Kernel 进程树;
6. main 最后退出。

只关闭窗口不等于退出应用的平台行为,由产品设置决定;一旦进入真正退出路径,上述清扫不可跳过。

Electron 下第 3 至 6 步是这样落地的:main 给 Kernel 发终止信号,同一拍接着退出自己,不等回应;Kernel 的入口
(`kernel-sidecar.mjs`)把信号转成正常退出,退出钩子同步清扫地理子进程(`GEOKERNEL.md` §10.1 #8b)。第 5 步
的强制结束够不到地理子进程,它们各自成组,所以 main 这一侧只能发终止信号,不能改成直接强杀。
**2026-09-11 真实会话验过**:Kernel 跑着一个地理子进程时,Cmd+Q 一轮、直接给 main 发终止信号三轮,子进程每次
都被清掉,Kernel 连同子进程总比 main 早约 50 到 70 毫秒结束。

### 5.4 崩溃恢复

正常退出覆盖不了断电、主进程崩溃与强制结束(包括用户在「强制退出」窗口里结束应用)。这几种情况会留下什么,
2026-09-11 用与壳相同的 Electron 和相同的子进程形态实测过,强杀 main 三轮,结果一致:

- **Kernel 不会留下。** 它是 main 的 utility process,main 一死它在十几毫秒内随之结束,所以启动时没有需要回收的 Kernel;
- **地理子进程会留下。** Kernel 是被直接结束的,信号处理与退出钩子都来不及运行,而地理子进程各自成组,不随它结束。
  这一种不做补救,理由见 `GEOKERNEL.md` §12;
- 上游壳的启动回收器照旧运行,但无事可做:它只认上游自己以独立二进制拉起的 `opencode serve`,GeoCode 从不这样
  启动 Kernel。

---

## 6. 安全边界

### 6.1 本地性

- Shell Runtime 与 Agent Kernel 都只绑定 `127.0.0.1`;
- GeoCode 不提供 `0.0.0.0`、LAN 或远程监听设置;
- 不启动 OpenChamber Relay、Tunnel、配对与远程主机服务;
- UI 静态资源从安装包内的私有协议加载,不依赖公网 Web 站点。

### 6.2 凭据

- Kernel 口令每次启动随机生成;
- renderer 不获得 Kernel 口令;
- preload 只向受信任的打包 UI origin 暴露 Shell Runtime 凭据与桌面能力;
- 供应商 OAuth / API key 的存储仍由 Agent Kernel 的既有认证体系负责;
- 日志、错误页、启动参数和 URL 不得包含口令或供应商凭据。

### 6.3 权限

Shell Runtime 与 UI 可以改善权限交互,但不能代替内核裁决。允许 / 询问 / 拒绝的最终事实仍来自
Agent Kernel。GeoCode 产品配置中被排除的能力也不能只靠隐藏按钮;相应路由、后台任务与进程
必须不注册或不启动。

---

## 7. 产品能力边界

### 7.1 首个桌面闭环保留

- 本地项目选择;
- 供应商登录、模型选择;
- 会话创建、列表、恢复与归档;
- 流式消息与工具结果;
- Permission 与 Question 交互;
- 中断当前执行;
- 文件附件;
- 基础设置、主题与英文 / 简体中文 / 繁体中文;
- 原生日志与启动错误诊断。

### 7.2 桌面内后续接入

- diff 与文件查看;
- 本地终端;
- 原生通知;
- 地理环境设置;
- OpenLayers 地图、矢量表格与栅格预览;
- GeoCode 受管技能商店;
- 应用更新通知。

这些仍属于同一个 Desktop 产品,只是不能进入「壳与内核是否接通」的第一验收面。

**应用更新只通知,不安装。** 应用不签名,macOS 上装不了应用内更新,所以形态与旧版 GeoCode 相同:
Electron main 匿名查发布仓库的 GitHub Releases 最新一条(仓库名由 `desktop-identity.mjs` 派生),
去掉 tag 前导 `v` 后与当前版本按语义化版本比较,预发布后缀算更旧;有新版就把版本号、Release 正文与
Release 页面地址交给上游的更新对话框,「下载」按钮打开 Release 页面由用户自己下载安装。节奏沿用
上游的轮询钩子:启动 3 秒后一次,之后每小时一次;没有「跳过此版本」,与上游一致。上游的 electron-updater
不配置更新源,应用内下载入口直接拒绝;壳向 OpenChamber 更新服务上报安装标识的那条路由在 Electron 下
只返回「无更新」,不出网。发布仓库里没有任何 Release 时按「无更新」处理,不报错。

**浏览器工具:智能体能操控应用内的浏览器面板,强制开启,没有开关。** 它给 GeoAgent 与 plan 一个名为 `browser` 的工具,
动作是上游 Web 工具的十个:打开、读页、点击、输入、滚动、前进后退、读样式、截图、改视口;用途是查资料、
操作网页、把看到的东西截图回到对话。它与地理数据预览是两件事,不共用任何部件。

上游把这个工具做成壳写到磁盘、再由壳 spawn 的 OpenCode 加载的插件;GeoCode 的内核由主进程启动且先于壳,
所以链路改成:主进程在选定壳端口之后、启动内核之前,把插件写成 `<壳数据根>/agent-tool/geocode-browser-plugin.js`
(`electron/geocode/browser-tool.mjs`,源码复用上游的工具模板,改名、改描述、去掉品牌字样、只带 Web 动作、
每次调用先向权限系统 `ask`),铸一枚一次性令牌,经 `createKernelProcessEnvironment` 的 `overrides` 递给内核三个变量:
插件文件地址、回调地址、令牌;壳启动后从主进程环境采纳同一枚令牌(`agent-tool/runtime.js`),之后主进程删掉它。
内核侧**不开放插件**:`loadExternal` 仍对配置声明与目录扫描一律返回空,唯一的例外是「主进程点名、且解析路径恰为
`<配置根>/desktop/agent-tool/geocode-browser-plugin.js`」的那一个文件,仅限 server 形态(`plugin/geocode-trusted.ts`,
KERNEL.md §6 第 1 项)。回调路由 `/api/openchamber/agent-tool` 在 Electron 下只接受 Web 动作,持令牌也调不到控制与记忆动作;
解析不出来的动作名同样由这道关卡回话,只列十个浏览器动作,措辞与工具其余两条错误一致都以 GeoCode 起头——
上游原本会把它知道的二十八个动作全列出来,那既带商标,又等于把我们关掉的那套能力广告给模型。

权限在 `config/geocode.ts`:GeoAgent 与 plan 是 `browser: "allow"`,其余 agent 落在全局的 `browser: "deny"` 上。
这里不设询问,理由是询问在这条链上不区分风险:上游根本不接权限系统(生成的插件里没有 `ask`),而 GeoAgent 的
`bash` 没有写规则,落回引擎给每个 agent 的通配放行——一个能任意执行 shell 的智能体,点一下网页并没有多拿到什么;
何况 `browser.open` 免费,拦下点击也不减少它能到达的页面,只是让每次查资料断一次。全局的 deny 保留的是范围而不是
危险:`Permission.disabled` 只认「通配 + deny」,所以未点名的 agent 连工具列表里都看不到它,而不是调用时才被拒。
插件仍然每次调用都走一遍 `ask`,机制留着,策略由配置决定:将来要收紧改一行配置即可,不必改代码,裁决也会进日志。
plan 拿到的理由与它的 `geodata: "allow"` 一致——读网页是研究,不落盘。
模型常把 `browser.` 前缀省掉只发 `click`,壳会把它解析成唯一同名的动作;插件在 `ask` 之前做同一归一,
否则规则永远匹配不到、由通配放行(09-06 真机第一次点击就是这样漏过去的)。
`browser.capture` 落到项目的 `.browser/`,与工作区内写文件同级,不问;它还要求面板正在显示,
因为面板不是当前标签时仍然挂载却被置为不显示,合成器不出帧,截图会二十秒超时或报 `UnknownVizError`,
而读页、点击这些在页面内执行脚本的动作不受影响。截图与清除浏览数据经主进程,主进程只认面板
自己的 partition(`DesktopIdentity.browserPanelPartition`);渲染端 `BrowserPane.tsx` 手抄同一值,由 `desktop-identity.test.mjs` 钉住,
漂回上游拼写时打开与点击照常而截图报「不是浏览器面板页面」(PATHS.md §3.4)。下载:工具本身没有下载动作,点到下载链接后
文件落到哪取决于面板的下载处理,待真机验证后定。

绊线:`kernel/test/geocode-trusted-plugin.test.ts`(四个方向)、`geocode-geo-permissions.test.ts`(裁决)、
`electron/geocode/browser-tool.test.mjs`(文件、覆盖变量、生成源码可导入且无品牌字样、裸动作名归一后再问、两侧路径一致、主进程顺序)、
`electron/geocode/desktop-identity.test.mjs`(渲染端的面板 partition)、
`web/server/geocode/browser-tool-callback.test.js`(令牌、动作限制、解析不出时不泄露关掉的动作)。

### 7.3 不进入 GeoCode 产品

- Web / PWA;
- VS Code extension;
- iOS / Android;
- 对外 CLI / Server(`packages/web/bin` 不随应用分发,`openchamber serve` 与 `startup enable` 不是产品入口,
  `ENVIRONMENT.md` §5.7);
- LAN、SSH host、Remote Instance、Relay、Tunnel 与设备配对;
- 选择或自动发现系统 OpenCode;
- OpenCode 自升级;
- 会话分享(内核侧的截断见 `KERNEL.md` §6 第 5 项,这里关的是界面入口);
- OpenChamber 的外部插件管理、system-prompt optimizer 与 agent-tool 注入;
- GitHub 发布流与 PR 面:**挂起**,见下方说明。

上游源码中的这些模块可以保留,但 GeoCode profile 下不得注册路由、启动定时器、建立网络连接
或显示入口。此约束需用运行时测试验证,不能从「构建命令没有点名它」推断。

**2026-09-07 重判:计划任务、Session Goals、Multi-run / Fusion 与 agent / command 管理表面保留。** 前三样原先和 GitHub 写在同一句里,归类为
「面向编程工作的」;agent 与 command 管理表面是另一条,归类为「面向编程项目的」。两条都是照抄 OpenChamber
对自己的定位,我们从未重判。逐一读过实现之后判据不成立:
计划任务是「到点在项目里开一个会话跑一段提示词」,Session Goals 是「盯住一个目标、由独立评估决定何时停、
花超预算就停」,Multi-run 是「同一任务分组各跑一遍再合成一个答案」。三者都是通用的智能体能力,机制里没有
一处与编程绑定,对地理工作反而对路:定期抓取与刷新、多轮且容易半途宣布完成的清洗任务、同一分析换几套参数
比着看。权限一律走既有体系,不为它们新增任何机制——包括自动批准:那是「用户提前回答确认框」,不是绕过它,
和用户在会话里手动打开是同一件事。

agent 与 command 两页同判,而且不需要任何额外工作。斜杠命令就是可复用的提示词模板,「把这个目录的 shapefile
重投影到 EPSG:4326 并出质检报告」正是地理用户想要的东西。新建智能体由构造保证安全:全局权限块关掉了
geodata、qgis、osm、gee 与 browser,新 agent 继承这些关闭状态,除非用户明确打开。编辑内置智能体会生成用户级
文件覆盖装配层,这一点是配置体系本身的性质(装配层最先合并,用户与项目配置可以覆盖),而界面对它有完整交代:
内置单独分组、不可删除、以「重置」代替删除——重置删的是覆盖文件而不是智能体。删不掉是结构使然而非界面拦阻,
`agents.js` 的 `deleteAgent` 找不到任何承载文件时直接抛「built-in or not deletable」,因为 `config/geocode.ts`
装配的智能体在磁盘上没有文件。内置这个标记本身也是我们加的(`agent/agent.ts` 的 `native: shippedAgents.has(key)`)。

Session Goals 唯一的改动是评估提示词里去掉一个词:上游写着「You audit progress of a **coding** agent」,
而评估模型是唯一有权判定目标达成的角色(干活的 agent 没有渠道结束自己的目标),它把什么当作证据就决定循环
何时停止。判据与 KERNEL.md §5.2 的压缩提示词同形——那一处也只改一个词。绊线在
`web/server/geocode/session-goal-prompt.test.js`。

**GitHub 发布流与 PR 面:挂起,不做判断也不做改动。** 能力本身该留,GeoAgent 也做代码工作。挂起的理由是
上游正在重构这块表面:新版把 GitHub 账号连接从 Git 页搬到了「集成」页,与 Linear 并列成内置集成。现在动手
等于给一个即将搬家的界面打补丁。同步新基线时连同新形态一并判,届时要一起解决的两件事已经查清:一是设备流
用的是 OpenChamber 的 OAuth 应用(`github/auth.js` 的默认 client id),用户在 GitHub 授权页上看到的是别人的
产品名、撤销时找的也是别人的应用名——这是身份归属问题不是保密问题,修法是注册 GeoCode 自己的 OAuth 应用
并顺手收窄 scope(`workflow` 用不上);二是壳每次启动都执行用户的 `gh` 取令牌并调 `api.github.com`,没有
任何人在应用里连接过账号。同一条原则适用于「集成」页(2026-09-07 用户决定):**凡是上游正在重构的表面,
先不动,等同步基线时连同新形态一起判。**

已按此执行的项,连同它们的判据与绊线:

- **选择或自动发现系统 OpenCode、OpenCode 自升级**:设置里的「OpenCode CLI」一节在桌面壳不渲染,
  设置搜索不再列出它的两个条目(`geocode/desktop-settings-surface.ts`);壳在 Electron 下让
  「解析二进制」与「升级」两条路由返回 404,`opencodeBinary` 旧设置不再写入 `OPENCODE_BINARY` 与主进程
  `PATH`。读版本号的「升级状态」路由保留,它在外部模式下不访问网络,About 页靠它显示内核版本。
  绊线在 `server/geocode/system-opencode-surface.test.js` 与 `ui/src/geocode/desktop-settings-surface.test.ts`。
- **LAN**:设置里「桌面」一节在桌面壳换成 GeoCode 自己的组件(`ui/src/geocode/GeoCodeDesktopSettings.tsx`),
  只保留登录时启动、菜单栏图标、最小化到托盘、保持唤醒四个本机选项,复用上游的 IPC、搜索 id 与文案;
  「允许局域网访问」开关与为它配套的「桌面 UI 密码」不再出现,搜索也不列。主进程在解析设置文件之后、
  选绑定地址之前剥掉 `desktopLanAccessEnabled` 与 `desktopUiPassword`(`electron/geocode/loopback-settings.mjs`),
  所以旧版本或手工写进 settings.json 的值也只会得到回环绑定与无口令的本机窗口,§6.1 不依赖界面是否显示。
  绊线在 `electron/geocode/loopback-settings.test.mjs` 与 `ui/src/geocode/desktop-settings-surface.test.ts`。
- **Tunnel**:设置里「External Tunnel」整页在桌面壳不可用(`ui/src/lib/settings/metadata.ts` 的页面可用性判断,
  导航、直达路由与搜索都读它);壳在 Electron 下不注册 `/api/openchamber/tunnel/*` 任何一条路由
  (`lib/tunnels/routes.js` 首行早退),所以 cloudflared 与 ngrok 没有任何入口能被拉起。隧道服务对象保留,
  relay 与系统信息接口从它读当前端口,公网地址恒为空。它本就不在启动时做任何事,没有自动恢复与定时器。
  绊线在 `server/geocode/tunnel-surface.test.js`(记录式桩应用,Electron 下零挂载,对照组挂满)与
  `ui/src/geocode/desktop-settings-surface.test.ts`。
- **SSH host、Remote Instance、Relay 与设备配对**:「远程实例」页在桌面壳不可用(与 Tunnel 同一个页面可用性谓词);
  顶栏的服务菜单就是主机切换器,在桌面壳不渲染(`Header.tsx`)。壳在 Electron 下由 `createRelayService` 返回惰性对象
  (`server/geocode/inert-relay.js`):不注册路由、不建宿主客户端、不生成写进 settings.json 的身份密钥,serverId 恒为 null;
  配对的五条路由(会话、传输候选、兑换)先于上游 handler 注册 404(`server/geocode/remote-access-surface.js`),
  已配对设备的列表路由保留,只读且恒空。主进程在命令分发前拒绝 11 个远程命令(8 个 `desktop_ssh_*`、远程口令登录、
  主机探测、主机写入;`electron/geocode/remote-ipc.mjs`),`desktop_hosts_get` 保留给顶栏与恢复页判断「当前是本机」;
  `connect` 深链在分发前丢弃;早期构建写进 settings.json 的 `privateRelay`、`relaySigningKey`、`relayEncryptionKey`
  在启动时清理一次。`dev-tunnel` 不动:它只在 API 地址是远程时启用,主机切换没了它不可达。
  绊线在 `server/geocode/remote-access-surface.test.js`、`electron/geocode/remote-ipc.test.mjs` 与
  `ui/src/geocode/desktop-settings-surface.test.ts`。
- **首次启动选择页、「安装 OpenCode」页与恢复页**:按 §5.1「启动只有两种结果」处理,三页在桌面壳下没有到达路径。
  绊线在 `electron/geocode/kernel-failure.test.mjs` 与 `ui/src/geocode/kernel-failure-screen.test.ts`。
- **代码片段(Snippets)**:「代码片段」页在桌面壳不可用,六条管理路由在 Electron 下先于上游的 handler 注册 404
  (`server/geocode/snippet-surface.js`,做法与配对路由同形——它们嵌在与 MCP、agent、command 共用的注册函数里,
  没法整体早退,靠 Express 的匹配顺序解决),输入框里 `#` 不再弹出补全。片段是「把 `#名字` 在发送前替换成一段
  预存文本」,替换发生在壳侧,内核只收到替换后的完整文本。判据:这不是 GeoCode 要提供的表面(2026-09-07 用户决定)。
  **展开函数本身不动**——和其余保留但不暴露的模块一样,§7.3 要求的是关入口不是拆机器;应用里既然无法创建片段,
  注册表恒空,展开就是一次空操作。补全必须一并摘掉,因为路由关闭后它会弹出一个空列表,而列表里唯一剩下的动作
  是跳转到已经隐藏的设置页。三个组合器都挂它(聊天、多路启动、定时任务编辑),所以收口做在组件自身的包装上,
  渲染 null 让父组件的 ref 始终为空,而父组件只在 ref 存在时才路由按键(`ChatInput.tsx`),于是 `#` 落回普通字符。
  遗留:输入框占位文字仍写着「# 用于代码片段」,那是十种语言的翻译串,归改牌那一批。绊线在
  `server/geocode/snippet-surface.test.js`(真实 Express,拒绝必须先于记录式 handler 命中)与
  `ui/src/geocode/desktop-settings-surface.test.ts`(页面可用性与包装的存在)。
- **魔法提示词**:「魔法提示词」页在桌面壳不可用,`registerMagicPromptRoutes` 在 Electron 下首行早退,四条路由
  一条不注册。这一页管的不是用户写的咒语,而是**产品自己那些一键动作背后的提示词**——生成提交信息、会话摘要、
  追进度、起草目标、多路合并等二十五对,共五十条。判据:这些提示词是 GeoCode 该自己写的东西,不是设置项
  (2026-09-07 用户决定)。关掉不影响任何功能,因为取覆盖值的那一步本就带 `catch` 回落到内置模板
  (`ui/src/lib/magicPrompts.ts` 的 `getEffectiveMagicPromptTemplate`),路由消失后一律用默认值。
  ⚠️ **随之而来的欠账**:那五十条是给编程助手写的,全文点名代码、仓库、提交、分支处逾百,例如「探索」开头就是
  「get oriented in this codebase」;而它们驱动的正是我们保留的功能(起草目标、创建定时任务、多路合并)。
  屏蔽这一页把改写它们的口子关上了,所以改写从此是我们的活,归改牌那一批,记在 `.artifacts/OPEN.md`。
  绊线在 `server/geocode/magic-prompts-surface.test.js` 与 `ui/src/geocode/desktop-settings-surface.test.ts`。
- **外部插件管理**:「插件」页在桌面壳不可用(与 Tunnel 同一个页面可用性谓词),壳在 Electron 下
  `registerPluginRoutes` 首行早退,十条路由一条都不注册。判据不是「这个功能不好」,而是**内核保证不加载**:
  `loadExternal` 对配置声明与目录扫描一律返回空(KERNEL.md §6 第 1 项),所以这一页写下的配置与文件
  全部落盘、全部被丢弃,界面却报成功并催用户点「应用」。早退顺带切断 `/api/config/plugins/registry`
  对 npm 官方 registry 的调用,那条出网 §7.3 本就不允许。用户扩展 GeoCode 的路是 MCP:进程外、按服务器
  逐个授权、界面完整。「集成」页(第三方订阅 Claude 与 Cursor)走同一条管道因而同样无效,但**暂不屏蔽**:
  上游后续版本把 GitHub 与 Linear 做成了这一页的内置集成,那两项不经插件管道,等同步新基线时一并判
  (2026-09-07 用户决定)。绊线在 `server/geocode/plugin-surface.test.js`(记录式桩应用,Electron 下零挂载,
  对照组挂满十条并点名那条出网路由)与 `ui/src/geocode/desktop-settings-surface.test.ts`。
- **agent-tool 注入的三个开关、以及 system-prompt optimizer**:上游把控制工具、Web 工具、记忆工具做成三个开关,
  都靠「壳把一个插件写到磁盘,再让壳自己 spawn 的 OpenCode 加载它」这条管道,而桌面壳不 spawn 任何 OpenCode
  (四层断口见 `.artifacts/DECISIONS.md` 09-04)。GeoCode 里它们不是开关:控制工具(让智能体建会话、派提示、管计划任务)
  不提供;**浏览器工具是产品能力,强制开启、无法关闭**,由 GeoCode 自己注入,做法见 §7.2「浏览器工具」,
  不读 `agentWebToolEnabled`;
  记忆工具是上游未发布的功能,等它发布再判。所以设置里「工具」一节在桌面壳整节不渲染,三个搜索条目不列。
  optimizer 走的也是这条管道,这是它不渲染的理由;它重写 `build` 与 `plan` 的提示词,前者 GeoCode 禁用,
  后者保留上游原文(禁用的是 `build` 与 `general`,`plan` 是活的)。Behavior 页的那一节不渲染,搜索条目不列。
  `/api/openchamber/agent-tool` 是浏览器工具的回调路由,保留;`/api/openchamber/control` 是同一控制服务的 HTTP 入口,保留。
  绊线在 `ui/src/geocode/desktop-settings-surface.test.ts`。
- **会话分享**:侧栏菜单与顶栏两处菜单里的「分享」不再渲染(`ui/src/geocode/session-share-surface.ts`)。
  内核早已拒绝(`KERNEL.md` §6 第 5 项),界面却照旧提供入口,而且失败是静默的:SDK 断言在那句
  `toast.error` 之前抛出,点击处理器又是无人接管的 promise,于是点下去只有菜单关闭,没有链接也没有报错。
  判据是数据去向:一次分享把整场会话推给 `https://opncd.ai` 这个上游服务——每条消息、每次工具调用及其结果、
  会话 diff 与工作目录,并在会话继续时持续增量同步;GeoCode 的会话可能带着尚未发表的研究数据。
  常量不读运行环境,因为内核那道闸也不读:Electron 形态与网页形态下分享同样是死的。「复制链接」与
  「取消分享」跟着一并关闭,它们本就只在分享成功之后才出现。壳侧不再加第二道拒绝:内核那道是权威的,
  而给 `session-actions.ts` 加早退会打红上游自己的测试,抬高补丁面。
  绊线在 `ui/src/geocode/session-share-surface.test.ts`:它不钉这两个文件,而是走遍渲染层源码,断言任一文件里
  分享菜单项的出现次数等于守卫的出现次数,所以上游日后把入口加进第三个文件同样会转红。

---

## 8. 磁盘与身份

### 8.1 两类数据所有者

| 所有者 | 内容 | 位置原则 |
|---|---|---|
| Electron / Shell | 窗口、主题、布局、桌面偏好 | `<appData>/GeoCode/desktop/`;壳日志见 `PATHS.md` §3.3 |
| Agent Kernel / GeoKernel | 会话、账号、配置、缓存、快照、地理环境 | `PATHS.md` 定义的 GeoCode XDG 根 |

Shell Runtime 不得沿用 OpenChamber 的 `~/.config/openchamber`,也不得直接读写
`~/.config/opencode`、`~/.local/share/opencode`、`.opencode/` 或 `opencode.json`。

保留功能优先通过 Agent Kernel API 操作配置与认证。确实没有 API 的壳侧偏好留在 Electron
userData;不能为了复用 OpenChamber 一段读文件代码而重新引入第二套 Agent 配置事实。
OpenChamber Settings 的逐页调查、Kernel API 缺口、目标请求流与实施门,在阶段 2 开工时对着当时的
代码做,结论落在本节与 `KERNEL.md`(`CONVENTIONS.md` §10「新知识先找主题文档」)。真撑不下再另起
专文,而不是先承诺一篇。

### 8.2 环境变量边界

规则与实现记录在 `ENVIRONMENT.md`:**带商标的剥,不带商标的不动。** 壳与内核用同一份前缀表
(`kernel-environment.mjs`),剥离在主进程的登录 shell 合并之后、我们自己的注入之前,壳的第一条 import
就是它;仍能到达内核的只有 `startEmbeddedKernel` 的 `overrides` 与 sidecar 经 IPC 自设的凭据。

## 9. 双上游维护

### 9.1 目录与分支

```
GeoCode/
├── kernel/    OpenCode vendor
└── desktop/   OpenChamber vendor
```

| 目录 | 原味分支 | 主分支形态 |
|---|---|---|
| `kernel/` | `kernel-upstream` | subtree + GeoCode 薄补丁 |
| `desktop/` | `chamber-upstream` | subtree + GeoCode 薄补丁 |

两个 vendor 根各自是独立安装与测试单元。仓库根只编排构建,不把二者揉成一个依赖方向混乱的
workspace。

**当前基线不记在本文里。** 它每次升级都变,写下就会漂(`CONVENTIONS.md` §10「只有人兜底的数字」)。查法是
各自 pristine 分支的最新快照:`git log -1 --format=%s chamber-upstream`。

### 9.2 闭包与对账

`chamber-upstream` 只接受「上游版本的原样文件圈选」,圈选清单即 `scripts/chamber-manifest.txt`,
内容零修改;`chamber-vendor.sh` 按清单从上游取文件、整棵替换,最后做**文件集对账**——清单选中
的文件集与暂存的文件集必须逐个相等,不等即拒绝并列出两侧的差。commit 由维护者亲自执行。

**它是一串孤儿快照,不是上游的历史。** 与 `kernel-upstream` 同一形态:根提交没有父,分支上只有
我们自己造的快照,升级就是用脚本把上游的新版本重新圈选一次。**升级不走 `git merge` 上游**——
排除项在这条分支上从不存在,merge 上游会把它们读成「上游修改了我们删掉的文件」并带回来;脚本
重建则始终只产出圈选后的树。首次落到 main 要 `--allow-unrelated-histories`(孤儿分支与 main 没有
共同祖先),此后每次都是正常三方合并。

⚠️ 直接 `git fetch` 上游来建这条分支是行得通的,而且**一切看起来都正常**——直到某次改用 merge
升级,或有人对着 2519 个上游提交找 merge-base。这条分支的价值全在「快照序列」这个形态上。

**首次导入与后续升级用的不是同一条命令。** 孤儿分支与 main 没有共同祖先,`-X subtree=desktop`
的路径偏移是**猜**出来的;猜不出时它不报错,只是把整棵上游树铺到仓库根——`packages/`、`docs/`、
`scripts/` 直接盖在我们自己的目录上,而冲突只有 `.gitignore`、`LICENSE`、`.gitattributes` 三处
add/add。**手一快把那三处解掉再提交,得到的是一棵内容全错、外表正常的树。** 首次导入因此走两步:

```bash
git merge -s ours --no-commit --allow-unrelated-histories chamber-upstream   # 只记父子关系,不动树
git read-tree --prefix=desktop/ -u chamber-upstream                          # 内容读进子目录
git commit
```

此后目录映射已经建立,升级就是普通的 `git merge -X subtree=desktop chamber-upstream`。验收门
两次都一样:`git diff chamber-upstream main:desktop` 必须为空。

**清单即闭包。** 改它一行就是改「下次合并把什么读成上游的增删」:少一行读作「上游删了这些
文件」并把它们从 main 上移除,多一行读作「上游加了」。两个方向都不产生冲突,都是静默的。
清单落成文件之前,这份选择只存在于做过它的那次会话里,没有任何东西能事后复核它。

**收窄闭包是这套机制唯一没有自动防护的操作。** 少圈一个文件,git 读作「上游删了它」并把它
从 main 上移除,不产生任何冲突;多圈一个文件只是多带了字节。因此默认全取,只排除验证过的项。

**Desktop 的闭包边界与 Kernel 不同。** Kernel 圈的是 15 个包的最小闭包;Desktop **包层面全取**
(§12 已否决为证明「只做 Desktop」而删源码)。排除的只有上游的开发设施,分两类——前两项**必须**
排除,它们会被我们自己的系统读进去;其余是无用载荷:

| 排除项 | 为什么不能一起落盘 |
|---|---|
| `.agents/` 与 `AGENTS.md` | **`AGENTS.md` 会被 Kernel 读进去**:经 `findUp` 进入系统提示,而它收集**所有**祖先匹配、不是最近的一个,所以 vendor 目录里的一份会混进用户项目的上下文。`.agents/skills` 现已由 KERNEL.md §6 第 6 项屏蔽,但目录仍一并排除——它与 `AGENTS.md` 同源,且那道屏蔽可以被 env 反向打开 |
| `.claude/` 与 `CLAUDE.md` | 上面两项的符号链接(`CLAUDE.md → AGENTS.md`,`.claude/skills/* → ../../.agents/skills/*`),本体排除后必须一起走。Kernel 侧已屏蔽,但在本仓工作的 AI 助手仍会读 |
| `.github/` | 无用载荷。GitHub Actions 只认仓库根的 `.github/workflows/`,vendor 目录下的不生效 |
| `.opencode/` | Kernel 的项目配置根是 `Brand.projectDir`(`.geocode`),读不到它 |
| `.env` | 未经决策的环境默认值 |

Kernel 的清单为同一类问题留了先例:它只圈进 `.github/TEAM_MEMBERS`(`packages/script` 在 import
期读它),其余 CI 排除的理由写作「CI we do not run」。**排除项的理由写进清单,不写进本文**——
清单是可执行的,文档会漂。

⚠️ **`chamber-upstream` 必须推到远端。** merge-base 就在那条分支上,它只存在于本机时,任何新
clone(包括换机器后的自己)都做不了三方合并,而**失去这个能力不会有任何报错**,只会安静地
退化成人肉 diff。

**圈选错了的修正渠道是再 merge 一次 `chamber-upstream`,绝不在 main 上手改。** `kernel-upstream`
的三个提交里有两个就是在修第一次圈选的错——一个被上游 `.gitignore` 吞掉的文件,一个没人注意
到在 import 期被读的文件。手改 main 会让两侧文件集永久错位,对账从此每次都报差。

**合并后对两次账。** 文件集对账由脚本做,补丁面对账要人看:

```bash
git diff --name-status chamber-upstream main:desktop        # 补丁面全集,不依赖标记
grep -rlE '// GeoCode:|--- GeoCode|"GeoCode: ' desktop/ | wc -l
```

前者是唯一看得见 `.json`、`.txt` 那类**载不动标记**的补丁的手段;后者数的是可审计的那一部分。
**任一数字变小就有补丁不见了,而它未必伴随任何冲突**——上游删掉或改名一个我们打过补丁的
文件时,git 不报冲突,只是让那处补丁随文件一起消失。

第二次账的「差集」部分(改过却查不到的文件)由验收门每次都算(`patch-surface.sh <root> --check`),放行的只有
载不动标记的四类文件;翻译字典的绑定方式见 `CONVENTIONS.md` §5。

`bun.lock` 是例外:`chamber-upstream` 上取上游原味,main 上则是 `bun install` over 闭包的产物,
两者差着数千行。冲突时删掉重新生成,永远不要手工解。

**重新生成之后要清掉 `node_modules` 再装,不能增量。** `bun install` 会按新锁文件补齐缺的包,
但**不清掉不再被引用的旧版本**——同一个包的两个版本从此并存,而 TypeScript 把它们当成两个
不同的类型。症状是几十条 `TS2322` / `TS2345`,报的是 `node_modules/.bun/<包>@<旧版>` 与
`@<新版>` 之间不兼容,**读起来像是代码坏了**。v1.18.4 → v1.21.0 那次实测过:增量安装后
`@codemirror/language` 留下 6.12.2 与 6.12.4 两份,`bun run build` 退出码 2;
`rm -rf node_modules packages/*/node_modules` 后重装,全绿。

### 9.3 Shell 定制阶梯

OpenChamber 采用与 Kernel 相同的原则:

1. 产品配置 / capability profile;
2. 启动参数与依赖注入;
3. 新增 GeoCode adapter 模块;
4. UI 装配与路由不注册;
5. 最后才修改上游源码流程。

能在 `geocode-desktop` profile 里关闭的能力,不删除上游实现。必须修改上游文件的地方应集中在
组合根、构建入口和身份边界,避免在大量叶子组件中撒条件分支。

### 9.4 审计与绊线

Shell 补丁没有独立的注入清单。清单会漂(`CONVENTIONS.md` §5),而它要回答的每个问题都已有更权威的来源:

| 问题 | 来源 |
|---|---|
| 动了上游哪些地方 | 定位 grep;`patch-surface.sh desktop` 打印全集,`--check` 在门里保证没有查不到的 |
| 为什么配置、注入或新增文件做不到 | 补丁旁的块标记 why。只写「做了什么」的块不合格,要写「前四级阶梯为何不够」 |
| 用户可见效果 | 块注释引用的本文段号 |
| 运行时绊线 | 与补丁同名的测试文件,`test-gate.sh` 逐个点名 |
| 何时可以撤销 | 真有撤销条件的补丁,把条件写在 why 的末尾;产品决定没有撤销条件,不硬凑 |

解冲突的人需要的是「这一处为什么这样改」,那句话就在冲突的正中间,比任何索引都近。

所有 Shell 补丁使用统一 `GeoCode:` 标记,一条命令可列全。提示词、翻译资源等不能容纳标记的
文件由测试绑定,绑定按后果不按措辞。

### 9.5 升级顺序

一次只升级一个上游:

1. 合并 OpenCode,保持 Shell 基线不变,跑 Kernel 门与桌面契约测试;
2. 或合并 OpenChamber,保持 Kernel 基线不变,跑 Shell 门与桌面契约测试;
3. 单侧恢复基线后才处理另一侧升级。

同时移动两端会让 API 变化、壳回归与 GeoCode 补丁失效混在一起,无法归因。

每个可发布版本记录 Shell commit、Kernel commit 与 API fingerprint,使历史安装包可复现。

---

## 10. 迁移计划

### 阶段 0:契约实验

不迁源码,用参考 OpenChamber 连接当前 GeoCode Kernel,验证:

- health、agent、provider、config;
- session 创建与恢复;
- message / part / status 事件;
- Permission、Question 与 interrupt;
- HTTP Basic 与目录路由;
- OpenChamber 当前 SDK 对 GeoCode OpenAPI 的差异。

产出是一份接口差异表,不是产品代码。它决定 Shell 基线和 SDK 迁移量。

### 阶段 1:引入 Shell vendor

- 建立 `chamber-upstream`;
- 将完整 OpenChamber 以 subtree 放入 `desktop/`;
- 保留上游许可证与版权;
- 建立独立 bun 安装根;
- 先证明原味 Shell 可以构建,再叠加 GeoCode 改动。

⚠️ **「可以构建」在这一阶段只到「树是活的、类型是通的」**:`bun install` 装得上、
`bun run build` 与 `bun run type-check` 退出码为 0。它**不等于桌面应用能打出安装包**——
`packages/electron` 的 `build` 脚本是 `bun -e "process.exit(0)"`,真正的打包链在同包的
`package` 脚本里(`build:web-assets → prepare:opencode-cli → bundle:main → rebuild:native →
package.mjs`),其中 `prepare:opencode-cli` 准备的正是我们要换成内嵌 Kernel 的外部 CLI。
打包属于阶段 8,在此之前跑它只会下载一个产品里不存在的组件。

### 阶段 2:建立产品 profile

- 对着已落地的 vendor 代码调查 Settings 各页的所有权与 Kernel API 缺口,再定实施批次;结论并入
  §8.1 与 `KERNEL.md`,与阶段 6 的路径批次同样处理,不预先承诺专文。⚠️ codex 有一份底稿
  (`git show codex/desktop-init:docs/DESKTOP-CONFIG-MIGRATION.md`),基线是 **v1.18.4**,与当前树
  隔着 345 个提交、772 个文件,路由名与模块名不可直接采信,只能当"要覆盖哪些面"的提纲;
- 集中定义 GeoCode 品牌、appId、协议、平台和 capability;
- 发布命令只选择 Desktop 闭包;
- 禁止 Web / Mobile / VS Code / CLI 入口;
- 运行时不注册远程、Relay、Tunnel、任务与插件相关模块。

### 阶段 3:接入 Kernel Host

- 复用 OpenCode Desktop 的 utility process 形态;
- 将 `build-node` 产物装入 Electron 构建;
- Electron main 成为 Kernel 唯一生命周期所有者;
- Shell Runtime 接收注入的 KernelConnection,不再自行发现 / spawn CLI;
- 完成 ready、health、restart、stop 与异常退出测试。

### 阶段 4:绑定 SDK 与代理

- 从 GeoCode Kernel 生成 SDK;
- React UI 与 Shell Runtime 统一消费该 SDK;
- 代理覆盖 HTTP、SSE 与 WebSocket;
- Kernel 重启后事件流能重绑;
- 不允许 renderer 绕过 Shell Runtime 直连 Kernel。

### 阶段 5:最小桌面闭环

走通:

```
启动 → GeoAgent 就绪 → 登录模型 → 选择目录 → 创建会话
→ 流式对话 → 权限 / Question → 中断 → 退出 → 再启动恢复会话
```

此阶段不迁地图、地理设置、远程能力或编程工作流。

### 阶段 6:身份与磁盘审计

目标状态与壳/内核两套根的关系见 `PATHS.md` §3.3,注入时机见 §5,零访问验收见 §6。顺序 1 → 2。

- **批 1 · Electron 身份**:照 `core/src/brand.ts` 的形态建自有模块由基串派生,消费点引用它而非
  平铺字面量,都在 `packages/electron` 的 `main.mjs` 与 `package.json` 里。日志不覆写。
  ⚠️ Windows 的 `extraMetadata` 不能漏——NSIS 的安装目录取自 `name` 而非 `productName`,
  `PATHS.md` §2 记着这条造成过真实事故,且错误会在注册表的 `InstallLocation` 里固化;
  ⚠️ **这批漏了服务器那一侧**:web 服务器信任的打包 UI 来源名单(`index.js` 与 `request-security.js`
  各一处)写死了上游的 `openchamber-ui://app`,协议改名后打包界面发出的每个请求都拿不到跨域许可头,
  界面报「Unable to reach server」。套件照不到它,只有真实会话能。现由
  `server/geocode/shell-identity.js` 的副本收口,`desktop-identity.test.mjs` 读副本对身份模块钉住,
  `shell-identity.test.js` 真实驱动来源检查;
- **批 2 · Shell 数据根**:注入 `OPENCHAMBER_DATA_DIR` 与 `OPENCHAMBER_MANAGED_PROCESS_REGISTRY`
  (后者是防御性的:skip-start 后不再注册托管进程,但孤儿回收仍在启动路径上)。上游把同一个三元
  表达式复制进了十几个文件、每份都认前者,那批零改动;不认的少数几处靠下面的命令列出,其中
  `proxy.js` 是 `settings.json` 的读取方而写入方认变量,**必须配往返测试**;
- **批 3 · 跨产品凭据**:已完成。Claude 的 quota provider 由 `isConfigured` 反查登录钥匙串,
  仅仅枚举 provider 就会触发,前端清单与服务端注册表两条路径都已屏蔽并各配绊线。Cursor 只在用户
  主动点导入时才读 `state.vscdb`,不动;`.claude/skills` 扫描归内核屏蔽清单(`KERNEL.md` §6 第 6 项);
- **批 4 · 内核文件的四个读写点**:已完成。`auth.json`、antigravity 账号、worktree 根、`.git` 里的
  项目 id 标记,上游全部指向 `~/.local/share/opencode` 与 `~/.config/opencode`。四处改指内核自己的
  根,派生自 `packages/web/server/geocode/kernel-roots.js`(`PATHS.md` §5)。三条非显然的:
  **`writeAuthFile` 在覆盖前会把旧文件复制成 `.openchamber.backup`**,所以读的是别人的凭据、留下
  的也是别人凭据的副本(那个后缀本身也于 2026-09-09 改名,`PATHS.md` §3.2);**四处里有两处不认 `XDG_*` 而内核认**,不统一就会出现壳读一份 `auth.json`、
  内核写另一份,两边都不报错;**项目 id 标记与内核共用一个文件是安全的**,因为内核按
  `remote ?? previous ?? root` 取值,壳写进去的值盖不掉它优先的远端哈希;
- **批 5 · 配置读取链**:已完成。`shared.js` 硬编码 `~/.config/opencode`,而它不是一个孤立常量,
  是一整条链的源头 —— 三个配置层、`agents`/`commands`/`skills` 三个目录、以及 `writeConfig`。实测
  `readConfigLayers()` 从用户真实的 `opencode.jsonc` 读回 1944 字节、含 `apiKey`,`call.js` 的
  `readProviderConfig` 再把它包成 auth 条目送进 dispatch(上游注释原文:「so it can win the
  precedence check」),最后 `fetch(baseURL)`。**触发者是 `session-assist`,busy→idle 事件驱动、
  默认开** —— 不需要用户点任何东西。同批收口的还有:`skills.js` 的技能暂存根与项目级技能目录、
  `getManagedSkillRoots` 里的 `~/.opencode`、以及三个**改了读取方就必须跟着改的写入方** ——
  `mcp.js` 的项目级 MCP 路径、`plugins.js` 自带的一套配置路径、`skills-catalog/install.js` 的安装
  目标,外加 `skill-routes.js` 按路径判作用域的那个分类器。**`mcp.js` 那处如果漏掉,就正好复现
  `PATHS.md` §5 点名记着的那次事故**:加 MCP 报告成功、Agent 永远看不到,现已配往返绊线;

  ⚠️ **`.claude`/`.agents` 这次没有从受管根里摘掉**,虽然内核已拒绝加载它们(`KERNEL.md` §6 第 6
  项)。原因是只摘这一半会制造更坏的状态:`createSkill` 仍能写进 `.agents`、UI 仍提供那个选项
  (`SkillsPage.tsx` 的 `draftSource`),于是变成**建得了、改不了**。完整关闭要同时动 `createSkill`、
  列表路由与 UI 选择器,单独成批——**那一批见「阶段 2 · 批 2」,已完成**;
- **批 6 · 壳的存储根收口**:已完成。十三处硬编码 `~/.config/openchamber` fallback 改指 GeoCode 自己的
  根,其中**四处存凭据**(`jwt-secret`、`ui-passkeys.json`、`github-auth.json`、quota),另加
  `main.mjs` 的 SSH 凭据根与**托管进程注册表**——最后这条不只是路径:`reapOrphanedProcesses` 在任何
  分支判断之前无条件运行并杀掉注册表里的 pid,与用户自装的 OpenChamber 共用目录时,他们的内核就是
  回收候选。实测确认当时没有杀成,唯一挡住的是「owner 进程还活着」这一个条件;提交前复审又补进
  `packages/web/bin/` 的两处——那是 `package.json` `bin` 指向的已发布 CLI,它读 `settings.json` 去找
  正在运行的桌面端,而桌面端那侧已经改根,两边不是同一个文件了(`PATHS.md` §5「同一个盲区的第二次」);
- **批 7 · 项目级目录与文件名**:已完成。`snippets.js`(整文件,含写路径)、`agents.js`、
  `commands.js` 的项目级 `.opencode/` 改名,以及 `plugins.js` 全局层的两个文件名——那两个是批 5 只改了
  目录和项目层留下的回归,当时插件开关会写 `<配置根>/opencode.json`,一个内核永不加载的文件;
- **批 8 · 内核侧残留**:已完成。`cli/network.ts` 的 mDNS 默认值(见 `PATHS.md` §5「一次全面审计」)、
  `tui/context/theme.tsx` 的第三处项目扫描、`plugin/install.ts` 往用户仓库写 `.opencode/opencode.json`、
  `tui/clipboard.ts` 落在共享 `/tmp` 的 `opencode-clipboard.png`;
- **批 9 · 环境边界**:已完成,规则、时序、绊线与实测记录见 `ENVIRONMENT.md`。
  批 3 把壳的托管启动在 Electron 下改为拒绝,§7.3「选择或自动发现系统 OpenCode」从此有了运行时绊线;
- 验证与用户自装 OpenCode 并存互不读写(现在由 `scripts/foreign-writes.sh` 客观给出,
  `CONVENTIONS.md` §7;读侧由 `scripts/kernel-env-probe.sh` 给出内核那一半)。

**阶段 6 剩余**,按产品优先级而非严重性排列(用户定的顺序:先路径、再对接、最后特性):

- **归阶段 2「配置与后端对接」·批 1**:已完成。前端 `chatDirectories.ts` 与 `openchamberConfig.ts`
  自己拼 `~/.config/openchamber/{chats,projects}` 并真的建目录写文件,而服务端认的是注入来的根。
  **根因是我们自己的回归**:上游 `index.js` 的 `OPENCHAMBER_USER_CONFIG_ROOT` 无条件挂在 HOME 下、
  `main.mjs` 从不设置 `OPENCHAMBER_DATA_DIR`,前后端因此自洽;我们把服务端改成读注入变量,前端没跟。
  后果不只是泄漏:`index.js` 的 `managedProjectRoots` 拿 `<根>/chats` 判断「这个 chat 会话的记忆算哪个
  项目」,而 chats 根本不在那儿。
  改法是把注入端搬回 HOME(`shell-data-root.mjs`),前端只换一个常量,十三个同步分类器调用点一个不动。
  路径拼装**没有**搬到服务端:`project-context` 那次先例在这里不适用,渲染进程读不到环境变量、
  也没有路由告诉它根,一旦搬走这两条同步判据就要全部改成异步,首帧会认错会话类型。真正的约束是
  **渲染进程算不出来的根,两半迟早各说各话**,所以两端都挂 HOME、`.config` 写死不读 `XDG_CONFIG_HOME`。
  这一批同时把 `packages/ui` 接进门——它此前整个不在门里,而缺口正好在出问题的地方;
- **阶段 2 · 批 1 补遗**:已完成。按包重点一次之后补上的,共同形状是**坏掉的功能而不是泄漏**:
  `PlanView.tsx` 去 `.opencode/plans/` 找计划而内核写 `.geocode/plans/`(面板永远报「没有计划」);
  `routes.js` 把全局行为提示词存到 `~/.config/opencode/AGENTS.md` 而 `session/instruction.ts` 读
  `<配置根>/AGENTS.md`(保存成功、agent 看不到,且 PUT 会 mkdir 出 OpenCode 的配置根);
  `desktop_read_file` 的凭据拒绝表仍守着上游那个从不存在的路径,而我们的四份凭据早已搬走
  ——那个 handler 防的是被提示注入的 agent,拒绝表现在从 `resolveShellDataRoot` 推导,根再搬一次
  绊线就会红。另有界面文案一处(告诉用户 settings.json 在 openchamber 目录)与过时注释若干。
  新增两个自有模块:`ui/src/geocode/kernel-roots.ts`(渲染进程要读 agent 写的文件,得叫同一个目录)
  与 `electron/geocode/denied-paths.mjs`;
- **阶段 2 · 批 2 · 外部技能库关闭**:已完成。`.claude/skills` 与 `.agents/skills` 是用户为别的
  agent 工具写的技能库,内核早已拒绝加载(`runtime-flags.ts` 两个隔离开关默认 ON),而壳照旧扫描并
  列出,**于是技能页告诉用户 GeoAgent 拥有它并不拥有的能力**。这一批把整条链一次关完,因为上一次
  只关一半的教训还在上面那段里:发现、`createSkill`、`deleteSkill`、受管根清单、目录商店的安装目标、
  以及 UI 的位置选择器,六处同时动。
  **其中 `deleteSkill` 是破坏性的**:它不接受 source 参数,把它知道的每个根都删一遍,所以删掉
  GeoCode 里叫 `foo` 的技能会连带递归删掉用户 `~/.claude/skills/foo`。绊线因此断言的是
  「我们没建过的文件删完之后还在」。
  上游三个断言这项能力的用例**没有删除而是反转**——它们的夹具正好搭好了要防的东西(一个请求写
  `.agents` 的创建、一个已在磁盘上的 `.agents` 库),反转之后上游自己的测试成了我们这个决定的绊线。
  另外:`skill-routes.js` 上报的 `externalSkills` 不再读环境变量而是常量 `true`——原先那两行错了两
  重,默认值(我们把内核默认改成 ON 却没改镜像)和优先级(上游把广播与具体两个开关 OR,而内核是具体
  优先)。**不再有需要与内核保持同步的手抄规则,是这个方案比「修镜像」更好的地方**;

- **破坏性项 · 项目级 legacy 配置**:已完成。两条破坏性项按「破坏性排最前」提到 2-D 之前做,
  第一条 `deleteSkill` 对 `~/.claude/skills/<同名>` 的递归删除已随阶段 2 批 2 一并关掉,这里是第二条。
  `openchamberConfig.ts` 读用户仓库里 `<project>/.openchamber/openchamber.json`(那是 OpenChamber 的
  每项目配置),抄进 GeoCode 自己的目录之后**把原件删掉**,发生在普通的打开项目流程里、无提示。
  **阶段 2 批 1 重新武装了它**:GeoCode 自己那份换了路径,对已有项目一律不存在,于是每个项目都会
  走一次这条回落。答案取「完全不读」而不是「读但不删」:GeoCode 从没写过那个路径,所以它在那里找到的
  只可能是别人的数据,与批 2 对 `.claude`/`.agents` 的答案同构;何况那份配置里的 `projectActions`
  是绑在项目按钮上的任意 shell 命令,静默继承别的产品写的命令不合适。整条链连声明一起屏蔽——常量、
  路径助手、删除函数——于是上游若在合并里加回一个调用点会**编译不过**,比静默返回更响。
  绊线两个用例:一个断言那份文件既没被读也没被删,另一个把**同一份内容**放到 GeoCode 自己的
  projects 根下,证明管路是通的——否则前一个用例对着一个什么都不答的 mock 也会通过;

- **阶段 2 · 2-D · 设置逐页往返**:已完成,做成了门的一节(`CONVENTIONS.md` §7)。
  原先记的「九个页面」里有两个是记错的:**snippets、themes、magic-prompts 都不面向内核**。
  内核源码里 `snippet` 零匹配,壳却把它写进**内核的配置根**下——不是 bug,展开发生在壳侧、
  消息发出去之前,但位置有误导性,读代码的人会以为那是内核配置。themes 与 magic-prompts
  落在壳根,位置本来就对。
  真正面向内核的是七类:agents、commands、skills、plugins、mcp、providers、behavior。
  七类的写入端与读取端现在由 `scripts/settings-roundtrip.sh` 自动比对,不再靠人点。
  顺带确认了一件之前没查过的:内核对单复数一律通吃(`{agent,agents}`、`{command,commands}`、
  `{plugin,plugins}`、`{skill,skills}`),所以壳一直写复数不是隐患。
  **查过但不动的一处**:内核 `globalConfigFile()` 在 `[geocode.jsonc, geocode.json, config.json]`
  里取第一个存在的,壳 `getPrimaryUserConfigPath()` 在**相反顺序**里取第一个存在的。今天不咬人,
  因为三者正常只会有一个存在(内核首启播下 `geocode.jsonc`,壳在空根下才建 `config.json`),
  两边于是选中同一个;门里两种起始状态都覆盖了。这是上游的形状,`opencode.*` 那套名字下反转一模一样,
  按既定政策不替上游修;

- **归阶段 3 · agent 截图落点**:已完成。`browser.capture` 是控制模块里**唯一**碰磁盘的动作
  (整个模块的写盘点只有两行,都在 `screenshots.js`),它把 agent 截的图写进用户仓库。
  **写进仓库是上游有意的设计,保留**:图是代码变更的证据,要跟代码待在一起,才能被引用、提交、
  附到 review 上。改的只是落点——原先是 `.openchamber`,而它**不在 `.gitignore` 里**,于是每截一次图,
  用户的工作树和下一个提交里就多一个别的产品名字的目录。
  现在是项目根下的 `.browser/`,两个决定各有理由:**按生产者命名而不是按产物**,以后浏览器控制存别的
  东西(DOM 快照一类)不用再开目录;**不并进 `.geocode`**,那里放的是团队手写、有意提交的配置,
  而这些是生成的、会累积,不该在 diff 里需要分辨。
  顺带查明:上游那个往配置目录写 `.gitignore` 的 `ensureGitignore` **已无活的调用点**(唯一调用在
  关掉插件安装时一并包掉了),所以 `.geocode` 与 `.browser` 都不会被自动忽略——截图可提交是这个功能的
  本意,不是疏漏。
  上游那两个断言旧路径的用例**反转而不是删除**,和批 2 同一手法;门里另加一条绊线,断言的是
  **字节落在哪**而不是常量怎么拼——将来换个写法组合出同一个路径仍然算对。

- **归阶段 3 · `.agents/loops` 循环任务**:已完成。**这一条原先在本清单里记成「`~/.agents/loops` 的
  启动期扫描与写回」,三处都不准**:它还扫项目各级祖先;不在启动期而在 `syncProject()`(打开或同步
  项目都走);「写回」不在 `loops.js`——那个文件整个只读——而在服务层,且是两条:删任务时
  `fs.unlinkSync` 删掉用户的 `.md`,开关任务时 `writeMdFile` 改写它的 frontmatter。按错的那句排优先级
  会把破坏性判轻。
  这是 **OpenChamber 自己的功能**,内核对 `loop`/`cron`/定时任务零匹配;整个 `scheduled-tasks/`
  与 `chamber-upstream` 零差异,我们从没动过。判据用现成的那条**归属**(`PATHS.md` 末尾):`.agents`
  是用户写给**任意** agent 工具的地方,不属于 GeoCode 体系。循环任务比技能更该关——技能只是被列出来
  等用户挑,循环任务**自己按 cron 跑起来**。
  只屏蔽 `discoverLoopFiles` 一处。它是两条写路径**唯一的闸门**:`findLoopTask` 先 `syncProject()`
  再查表,表里没有带 `loopFile` 的任务,删和开关都取不到文件。实测确认了三件事:界面上建的任务
  (不带 `loopFile`)完好、用户的 `.md` 哈希不变、Goal 是另一个模块(`session-goal/` 只导入
  `fs`/`os`/`path` 与自己的 `objectives.js`)完全不受影响。
  上游七个断言这项能力的用例**反转而不是删除**,夹具一字不动;门里另加一条绊线。
  ⚠️ 排查过程本身有一条教训:第一次实验造的任务形状不合法,被规范化直接丢掉,输出是
  `之前: [] 之后: []`——**长得和「安全」一模一样**。是因为「之前」也空才发现它空转;

- **归阶段 3「特性修缮」**:外部二进制发现的
  十三处与 `electron:dev` 的分叉、`gitlab-ai-provider` 的 vendor 泄漏、内置技能
  `customize-opencode` 的正文、以及品牌与 i18n。**另有 `packages/vscode/` 整包**:`opencodeConfig.ts`
  是 `server/lib/opencode/` 的一份近乎逐行的副本,项目目录、配置文件名、技能根、外部二进制发现全都
  还是上游的名字(约三十处)。它是独立交付物,不随桌面端启动,所以不拦这一批;但它与壳共用的是同一
  份逻辑,壳侧每改一处,那边就多欠一处,单独成批而不是逐条跟着改。

```bash
# 硬编码到 OpenChamber 目录的 fallback(认 OPENCHAMBER_DATA_DIR 的那一半不会命中,
# 因为那半边根本不含这两个路径段)。
grep -rn "'\.config', 'openchamber'" desktop/packages/web --include="*.js" --include="*.mjs" \
  | grep -v '\.test\.' | grep -v node_modules | grep -v '/dist/'

# 硬编码到 OpenCode 根的路径计算。
grep -rnE "'(\.config|\.local|\.cache)', '[Oo]pencode'|'\.opencode'" \
  desktop/packages/web --include="*.js" --include="*.mjs" \
  | grep -v '\.test\.' | grep -v node_modules | grep -v '/dist/'

# 相对形态:目录名不挂 HOME,而是后面才拼上项目目录。上面两条一条都不匹配它。
grep -rnE "path\.join\(\s*['\"]\.(openchamber|opencode|claude|agents)['\"]" \
  desktop/packages kernel/packages --include="*.ts" --include="*.js" --include="*.mjs" \
  | grep -v '\.test\.' | grep -v node_modules | grep -v '/dist/'

# 裸的目录名常量,同理。
grep -rnE "=\s*['\"]\.(openchamber|opencode|claude|agents)['\"]\s*;?\s*$" \
  desktop/packages kernel/packages --include="*.ts" --include="*.js" --include="*.mjs" \
  | grep -v '\.test\.' | grep -v node_modules | grep -v '/dist/'
```

⚠️ **前两条命令的范围是 `packages/web`,不是 `packages/web/server`。** 收窄到 `server/` 会漏掉
`bin/`——那是已发布的 CLI,同样按 `~/.config/openchamber` 解析数据根。这是同一个盲区的第三次:
第一次是下面那个过滤器,第二次是复审时临时写的 `path.join\([^)]*'openchamber'`(`[^)]*` 不允许中间
出现右括号,而这类路径几乎全是 `path.join(os.homedir(), ...)`,它把最该找的形状排除了)。
**`packages/vscode` 要单独扫**,它是另一份副本,不在前两条里(后两条的范围是整个 `desktop/packages`
与 `kernel/packages`,覆盖到了它)。

⚠️ **第四次是形态漏了,不是范围漏了。** 前两条命令找的都是**从 HOME 拼出来的绝对根**,而
`screenshots.js` 写的是 `path.join('.openchamber', 'screenshots')`——相对路径,项目目录后面才拼上去,
两条都不匹配。它把 agent 的截图落进用户仓库里一个别的产品名字的目录,而 `.openchamber` 不在
`.gitignore` 里,于是会进用户自己的提交。后加的两条命令就是补这个形态的。
它们报出来的东西要再过一道:**屏蔽块里的行 grep 照样匹配**,而**只读的判断**(比如拿路径判断自己
是怎么装的)不建目录也不写文件,两类都不是欠账。抹掉块注释再看一遍,剩下的才是。

⚠️ **第一条命令原先还带一个 `grep -v ":[[:space:]]*: "`,那个过滤器是错的**,务必不要加回去。
它本意是排除三元里读变量的分支,但**硬编码 fallback 恰恰也写在 else 分支上、格式一模一样**,于是
连要找的东西一起吃掉:实测它报告 2 处,真实是 13 处,批 2 就是照着那份残缺清单做的。
**这是一条命令写错、把自己关进盲区两个批次的记录。**

**这两条命令报出来的东西分四类**,按类记而不按条记——条数每批都在变,类别不变:

- **早退或注释屏蔽的**:`package-manager.js` 的 `getOpenChamberConfigDir`、`shared.js` 里那个
  `~/.opencode` 第二全局根、`skills.js` 的缓存候选列表。上游行逐字节留着,永不到达;
- **不是路径的**:`path-utils.js` 的 `pathLooksUserConfigured`,它那张表判的是「PATH 里出现过哪些
  目录名」,不算泄漏;
- **不可达但留着的**:`skill-routes.js` 里按路径判作用域的分类器,以及 `skills.js` 的
  `homeOpencodeDir`——发现关掉之后没有路径会走到它们,删掉反而增加暴露面;
- **真欠着的**:`env-runtime.js` 与 `server-utils-runtime.js` 的外部二进制探测,归阶段 3。

⚠️ **不要在这份文档里写行号。** 实测过:七处 `file:line` 引用里四处在两天内就漂了,而且是被我们
自己的注释改动推移的。行号失效时不报错,只是安静地指向另一句代码,读的人会以为文档错了或者代码被
改过——两种猜测都不对。**符号名才是代码的身份**:改名会有编译错误、会有测试红;行号漂了什么都不会
发生。要指位置就指函数名或常量名,要计数就给命令让人现数。

### 阶段 7:桌面功能与地理界面

在基础闭环稳定后,按独立批次接入 diff、终端、通知、地理设置、地图与预览。每一批都有自己的
用户流程和验收,不回头改变基础进程边界。

### 阶段 8:双平台打包

macOS arm64 与 Windows x64 分别完成:

- 干净机器首次安装;
- 开发版与正式版数据隔离;
- 启动、更新通知、卸载与重装;
- 原生模块与 Kernel 架构验证;
- 正常退出、Kernel 崩溃恢复,以及 main 崩溃后的进程残留(§5.2、§5.3、§5.4);
- 与旧版会话迁移的真实数据验证。

---

## 11. 验收门

### 11.1 架构门

- renderer 无 Node 权限且不 import Kernel;
- Agent Kernel 不依赖 Shell / Electron;
- Shell Runtime 不启动系统 OpenCode;
- 正式包无 Web / VS Code / Mobile / CLI 产品入口;
- 两个服务只监听 loopback;
- Kernel 凭据不进入 renderer。

### 11.2 行为门

- 默认且唯一主 Agent 是 GeoAgent;
- 会话、消息、事件、权限、Question 与 interrupt 全链路可用;
- Kernel 重启后 UI 自动恢复快照与事件流;
- Kernel 不可用时 UI 显示可归因状态,不表现为空会话或空 provider;
- 应用退出后无 Kernel 与地理子进程残留。

### 11.3 身份门

一次完整使用流程后遍历新增文件与系统注册项:

- 不产生 OpenChamber 用户目录;
- 不产生 OpenCode 用户目录或项目配置;
- appId、协议、安装目录、日志与更新源均为 GeoCode;
- GeoCode 与独立 OpenCode 同机运行互不影响。

### 11.4 维护门

- `scripts/test-gate.sh` 保持全绿;
- 新增 Shell gate 覆盖 capability、Kernel Host、代理、身份和打包绊线;
- 根级集成门使用真实 Shell + 真实 Kernel,不以 mock 证明兼容;
- 每次上游合并后补跑对应上游套件并分类预期差异;
- 发版前两平台实机、全新档案与存量档案各走一轮。

---

## 12. 被否决的方案

| 方案 | 否决理由 |
|---|---|
| 让用户分别安装 OpenChamber 与 GeoCode Kernel | 产生两个产品、两套升级与不可控版本组合,违背单一 Desktop |
| 让 GeoCode 正式版连接系统 OpenCode | 会绕过 GeoAgent、GeoKernel、路径隔离与测试过的内核版本 |
| React UI 直接连 Kernel,删除 Shell Runtime | OpenChamber UI 的文件、终端、设置与通知依赖 RuntimeAPIs,等同重写应用层 |
| 让 Shell Runtime 继续自行 spawn CLI | 形成第二生命周期所有者,也恢复系统 OpenCode 发现与升级路径 |
| 把 Agent Kernel 放进 Electron main 同一进程 | Kernel 或原生模块故障会直接带走桌面壳,且清扫边界变得含混 |
| 只复制 OpenChamber 的几个目录 | 根构建、Web Runtime、UI 与 Electron 契约会失去上游历史和可合并结构 |
| 为证明只做 Desktop 而删除 Mobile / VS Code / Web 源码 | 制造庞大永久差异;不构建、不注册已经足以形成产品边界 |
| 全仓替换 OpenCode / OpenChamber 字样 | 会误改 SDK 包名、wire 协议与内部 ABI,且无法区分身份和兼容性字符串 |

---

## 13. 实施前仍需定稿的细节

以下不改变总体架构,在对应迁移阶段以实验决定:

1. 同源 SDK 以 workspace 依赖还是构建产物交付给 `desktop/`;
2. 新版 OpenChamber 要求的 SDK 版本与 Kernel 版本不一致时如何处置——§9.5「一次只升级一个
   上游」与 §4.3「Kernel 与 SDK 同源」在此相交。首次实测(OpenChamber v1.21.0 钉
   `@opencode-ai/sdk` 1.18.23,Kernel 侧 1.18.18)显示两者 API 表面零差异,差的三行是版本号、
   一句注释,以及一个我们不装配的 `app.upgrade` 参数——**所以这一条的结论是「版本号不能用来
   判断」,而不是「已经对齐」**;
3. Shell 补丁的注入表:已定,不建。§9.4 改为「清单由定位 grep 给出,理由写在补丁旁」;
4. Shell Runtime 凭据的具体 token 形状与过期策略;
5. utility process 异常退出后的自动重启次数与退避;
6. GeoCode 应用更新通知的检查间隔和发布清单格式:已定,见 §7.2。清单就是 GitHub Release 本身,
   不另生成 `latest.yml` 一类文件。

这些细节必须有一个明确所有者和运行时测试,但不应重新打开「是否只有 Desktop」「是否内置
Kernel」「是否保留 Shell Runtime」「是否由 main 管理 Kernel」四项已定决策。

---

## 14. 相关文档

| 文档 | 分工 |
|---|---|
| `DESIGN.md` | 产品定位与总架构 |
| `OVERVIEW.md` | 当前实现状态与执行时序 |
| `KERNEL.md` | OpenCode 薄 fork、Agent 装配与生产 bundle |
| `GEOKERNEL.md` | 地理执行内核与三个出口面 |
| `TOOLS.md` | 模型工具、权限和输出契约 |
| `PATHS.md` | 磁盘、系统身份与环境变量边界 |
| `CONVENTIONS.md` | 开发、补丁、测试与上游合并纪律 |
