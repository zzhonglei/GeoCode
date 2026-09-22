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

⚠️ **这四项不再重开**:是否只有 Desktop、是否内置 Kernel、是否保留 Shell Runtime、是否由 main
管理 Kernel。后面的细节讨论都在它们之下,不上溯。

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
| Shell Runtime → Agent Kernel | 会话、模型、权限、工具、事件及地理数据面 | Kernel 口令只在 main(Shell Runtime 与它同进程)与 Kernel 两侧,不下发 renderer;它会进入哪些环境块见 §6.2 |

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

### 2.4 壳与内核的接缝

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

**壳的每一处 SDK 声明都钉在本仓 vendor 的内核版本上**——安装根自己那份加三个 workspace 包。绊线
靠遍历安装根与 workspaces 找声明,**不靠手写清单**(第一版用清单,当场漏掉了安装根自己那处)。
上游钉的是它自己的 pin,因为 OpenChamber 不自带内核、只能连用户装的那个,对不齐是它的常态;
GeoCode 两边都出,所以能对齐。

⚠️ **版本相同不等于同源,这一半还没做。** 壳装的仍是上游发布的产物,而不是由**我们这份内核**的
OpenAPI 生成的客户端。两者的差别今天看不出来(1.18.18 与 1.18.23 的 162 条路径、1409 个导出类型
逐一相同),但有一个立刻能看见的后果:**`/geo/*` 在任何一份 SDK 里都没有**。生成线是现成的
(`kernel/packages/sdk/js/script/build.ts`),阶段七要调地理端点时补,连同一条「路由定义源码哈希
≠ 生成印记就红」的绊线。

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

**上游那五个 `version` 留给上游。** 它的发布脚本每次发版把它们一起改写,所以合并时无条件取上游;
这些数字从此只表示「壳基于 OpenChamber 哪一版」。

**GeoCode 的产品版本是另一个数字**,从 `1.0.0` 起,放在自己的文件里。Electron 包一份、web 包一份
手抄——两个包不能互相 import——由测试钉住相等,由 `scripts/bump-geocode-version.mjs` 一次改两份。
三个读取点:Electron main 的应用版本(更新检查用它比对)、渲染层的 `__APP_VERSION__`、打包时经
`extraMetadata.version` 写进安装包与安装器元数据。

About 对话框只显示图标、产品名、产品版本与代码仓库链接,版式沿用上游。壳基线那个数字由
`/api/system/info` 报出供诊断,不上界面。

⚠️ **每个可发布版本都要记下壳 commit、内核 commit 与 API fingerprint**,否则历史安装包不可复现。

## 5. 启动、重启与退出

### 5.1 启动顺序

1. Electron main 建立 GeoCode appId、userData 与日志路径;
2. 剥离继承环境里带商标的名字(`OPENCODE_*`、`OTEL_*`、`OPENCHAMBER_*`),再由我们的代码注入内部 ABI
   (`ENVIRONMENT.md` §5.2);
3. 选择 Kernel loopback 端口并生成随机口令;
4. 启动 Kernel utility process,以它经进程消息报告的 ready 为准(`/global/health` 的 HTTP 确认只有读侧探针
   `scripts/kernel-env-probe.sh` 等待);
5. 启动 Shell Runtime,以注入的 Kernel URL 与认证作为唯一上游;
6. 选择 Shell Runtime loopback 端口并确认健康;
7. 创建窗口,经 preload 下发 Shell Runtime 连接信息;
8. renderer 加载打包内 React UI 并开始同步。

窗口不能在「服务地址尚未确定」时自行猜测默认端口。失败必须落在可诊断的启动阶段,
而不是让 UI 在一个永远连不上的地址上转圈。

**启动只有两种结果。** 上游桌面端启动时先要回答「这个界面该连哪台服务器」,围绕它有首次启动选择页、
远程主机探测与几种恢复页。GeoCode 的内核在应用里,这个问题不存在——主进程读到的主机配置**恒为本机**,
存量设置文件里的主机列表不再被读。所以只剩两条路:

- **Kernel 起来了**,进主界面;
- **Kernel 没起来**,主进程记下失败(错误、Kernel 最后几十行输出、日志路径)并且**不启动 Shell
  Runtime**。窗口照常打开,渲染进程把任何非主界面的启动结果都交给 GeoCode 自己的失败屏,它读那份
  记录,提供「在文件夹中显示」日志与重试——重试就是重开应用。

上游的选择页、安装页与恢复页在桌面壳下没有到达路径。运行中 Kernel 死亡进同一个失败屏(§5.2)。

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

配置应用的忙时保护由 Kernel 决定,壳不再把 SSE 活动计数当作权威。`config/geocode-refresh.ts` 在
`/global/dispose` 失效配置之前检查各实例真实的 Runner 与后台任务状态,并与新执行的准入互斥;忙时返回
HTTP 409,壳报错并保留待应用徽标。事件断流、漏掉 busy 或 idle 都不改变这个判断。

Runner 的保护包住状态转换,不包住调用方等待:调用方断开后,实例 scope 中继续运行的任务仍由 Runner
的真实状态保护。观察集合在实际准入后登记 Runner,空闲后移除,不依赖上游会话查找表;旧空闲回调
移除查找项、或调用者持有旧引用后重新执行,都不能让新任务逃过刷新检查。prompt/command 的前置处理与
后台任务 start/extend 也参与准入。异步检查后台状态时
保持执行开放,最后核对期间没有新准入或状态注册变化才占用刷新资格;不能为了检查忙闲先阻断已有任务。
刷新期间新执行请求明确失败,让调用方重试,不把旧实例里的请求排队到刷新之后。实例关闭先禁用旧准入,
清理执行后才注销观察。协调器只服务配置应用,不改变普通实例清理和退出的取消语义。

这些接线需要在内核源码完成:配置、环境、外挂进程和界面均无法原子观察任务启动与实例销毁。上游路由的
成功响应不变,增加显式 409 错误契约;不新增 SDK 方法。这里刻意选「忙时拦下」,用户主动刷新等得起。

丢弃后实例事件流会被 Kernel 掐断,壳的上游读取器约 250 毫秒后重连;Kernel 的 SSE 不带事件 id,窗口内
的事件无法回放,由界面收到 `global.disposed` 后整体重新 bootstrap 兜住。

两条相关约束:壳挑全局配置文件的候选顺序必须与 Kernel 一致(`geocode.jsonc`、`geocode.json`、
`config.json`),否则目录里多一份遗留文件时两边写进不同的文件;壳写全局配置是整文件覆盖,注释不保留,
这是上游形态。

**运行中的 Kernel 死了,恢复靠重开应用,不在原地重拉,也不自动重试。main 在 Kernel 报 ready
之后盯住它的退出:句柄仍是当前那个、应用也没有在退出,就按启动失败的形状记一份记录(`phase: 'running'`、退出码、
最后几十行输出、日志路径,`electron/geocode/kernel-failure.mjs`)并通知所有窗口。窗口收到通知,或打开时读到这份记录,
就换成同一个失败屏(`ui/src/geocode/kernel-lost.ts`),标题改为「意外退出」。独立 Mini Chat 根通过
`GeoCodeKernelFailureGate` 接入同一记录与通知,故障后卸载聊天子树,包括故障后才打开的窗口。失败屏自带
拖动区与无边框窗口控件,内容独立滚动,小窗口下也能访问日志和重试。重试一律重开应用:上游的启动处理函数在壳
还活着时只刷新页面,刷新后读到的仍是这份记录,会原地回到失败屏。不自动重试,是因为 Kernel 反复崩溃时自动重开会变成
死循环。正在进行的那一轮随 Kernel 一起中断,已落盘的会话不受影响。

原先设计的原地重拉不做:换端口、复用口令、壳侧重绑代理与事件流,还必须沿用同一枚浏览器工具令牌,换来的只是窗口不关,
代价是一整套每次合并上游都要维护的重连链路。Shell Runtime 仍不得自行 spawn 第二个 Kernel。

### 5.3 正常退出

顺序固定:

1. 停止接受新的 UI 请求;
2. 关闭 Shell Runtime 的 SSE / WebSocket 与监听器;
3. 请求 Agent Kernel 正常停止;
4. Agent Kernel 清扫 GeoKernel 登记的全部地理子进程;
5. 超过上限仍未退出时,Electron main 强制结束 Kernel 进程树;
6. main 最后退出。

只关闭窗口不等于退出应用的平台行为,由产品设置决定;一旦进入真正退出路径,上述清扫不可跳过。

Electron 下 main 在壳关闭之后调用并等待 Kernel 的 `stop()`;即使壳关闭失败,也会进入这个等待。
`stop()` 发送已有 STOP IPC,sidecar 直接正常退出,由 exit hook 同步清扫地理子进程,不先等待可能被活动
任务拖住的 HTTP listener 关闭。main 以进程真实退出为完成依据,六秒超时后才调用强制终止。

Windows 的 `utilityProcess.kill()` 不触发 JavaScript 退出钩子,因此只能用于超时兜底,不能作为正常
清扫通道。事件循环卡死或清扫超过时限时,强制终止仍不能保证地理子进程全部回收,属于下节的强退边界。

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
- Kernel 口令会进入环境变量,两侧都是上游的读取方式决定的:Shell Runtime 按上游的外部服务器路径从环境读它,
  所以 main 起完 Kernel 后把它写进自己的 `process.env`,此后 main 起的子进程随之继承,实测一个 Electron 辅助
  进程的环境块里有它;Kernel 的服务端同样只从环境读,sidecar 把它设进 Kernel 自己的 `process.env`,Kernel 起的
  子进程随之继承(`ENVIRONMENT.md` §8)。读得到它的只有同一用户的进程;
- preload 只向受信任的打包 UI origin 暴露 Shell Runtime 凭据与桌面能力;
- 供应商 OAuth / API key 的存储仍由 Agent Kernel 的既有认证体系负责;
- 日志、错误页、启动参数和 URL 不得包含口令或供应商凭据。

### 6.3 权限

Shell Runtime 与 UI 可以改善权限交互,但不能代替内核裁决。允许 / 询问 / 拒绝的最终事实仍来自
Agent Kernel。GeoCode 产品配置中被排除的能力也不能只靠隐藏按钮;相应路由、后台任务与进程
必须不注册或不启动。

---

## 7. 产品能力边界

**本节是产品排除项的判据登记处**:每一处关掉上游功能的补丁,块标记里的 why 指回这里的段号。所以
这三个小节的编号不要动。

一条判据贯穿全节:**GeoCode 面向地理工作者,不是面向程序员。** 但「面向谁」要看机制,不看上游给
它起的名字——§7.1 末尾那四项就是照抄上游的自我定位判错、后来重判回来的。

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

**判过之后保留的四项**:计划任务、Session Goals、Multi-run / Fusion,以及 agent 与 command 管理
表面。它们原先被归类为「面向编程工作的」准备关掉,**而那个分类是照抄 OpenChamber 对自己的定位,
我们从未重判**。逐一读过实现之后它不成立:三者都是**通用的智能体能力,机制里没有一处与编程绑定**,
对地理工作反而对路——定期抓取与刷新、多轮且容易半途宣布完成的清洗任务、同一分析换几套参数比着看;
斜杠命令就是可复用的提示词模板。保留不等于原样照搬,三条落点:

- **权限一律走既有体系,不为它们新增任何机制。** 自动批准是「用户提前回答确认框」,不是绕过它,
  与用户在会话里手动打开是同一件事。
- **新建 agent 由构造保证安全**:全局权限块关掉了 geodata、qgis、osm、gee 与 browser,新 agent 继承
  这些关闭状态,除非用户明确打开。编辑内置 agent 会生成用户级覆盖文件,那是配置体系本身的性质;
  界面以「重置」代替删除,重置删的是覆盖文件而不是 agent。
- **两处提示词各去掉一个词。** 上游写「You audit progress of a **coding** agent」(Session Goals 的
  评估)与「Only suggest work the **coding** agent can perform」(会话辅助)。评估模型是唯一有权判定
  目标达成的角色——干活的 agent 没有渠道结束自己的目标——它把什么当作证据就决定循环何时停止。
  判据与 `KERNEL.md` §5.2 同形:只改那一个词,其余照上游。

**GitHub 的 PR 与工单面同样判为保留**,判据见 §7.3 末尾。

### 7.2 桌面内后续接入

- diff 与文件查看;
- 本地终端;
- 原生通知;
- 地理环境设置;
- OpenLayers 地图、矢量表格与栅格预览;
- GeoCode 受管技能商店;
- 应用更新通知。

**应用更新只通知,不安装。** 应用不签名,macOS 上装不了应用内更新。主进程匿名查发布仓库最新一条
Release,按语义化版本比较,有新版就把版本号与 Release 页地址交给上游的更新对话框,「下载」按钮打开
那一页由用户自己装。上游的 electron-updater 不配更新源,应用内下载入口直接拒绝;壳向 OpenChamber
更新服务上报安装标识的那条路由在 Electron 下只答「无更新」,不出网。

#### 注入给内核的两个工具

这是内核对接面的一部分。上游那条 agent-tool 注入管道本身已出局(§7.3),GeoCode 自己注入一个插件
文件,里面装着两个工具;记忆工具不注入。

**链路与上游不同,因为启动顺序反了。** 上游是壳把插件写到磁盘、再由壳 spawn 的 OpenCode 加载;
GeoCode 的内核由主进程启动且**先于壳**。所以改成:主进程在选定壳端口之后、启动内核之前把插件写到
`<壳数据根>/agent-tool/`,铸一枚一次性令牌,经内核进程环境的 `overrides` 递进去三个变量——插件
地址、回调地址、令牌;壳启动后从主进程环境采纳同一枚令牌,之后主进程把它删掉。

**内核侧并没有因此开放插件。** `loadExternal` 对配置声明与目录扫描一律返回空,唯一的例外是「主进程
点名、且解析路径恰为那一个文件」,并且仅限 server 形态(`KERNEL.md` §6 第 1 项)。回调路由在 Electron
下只接受两个工具各自的动作:**持令牌也调不到记忆动作,一个工具也调不到另一个的动作**;解析不出来的
动作名只列发起调用的那个工具自己的动作——上游原本会把它知道的二十八个全列出来,那等于把关掉的功能
广告给模型。

| 工具 | 给谁 | 能做什么 |
|---|---|---|
| `browser` | GeoAgent、plan | 上游 Web 工具的十个动作:打开、读页、点击、输入、滚动、前进后退、读样式、截图、改视口。它与地理数据预览是两件事,不共用任何部件 |
| `geocode` | GeoAgent | 上游 `openchamber` 工具的十三个动作:列项目与会话、读会话消息、新建与分叉会话、发提示词,以及定时任务的增删与启停 |

两个都**强制开启,没有开关**。权限在装配层点名,其余 agent 落在全局的 deny 上——`Permission.disabled`
只认「通配 + deny」,所以未点名的 agent **连工具列表里都看不到它**,而不是调用时才被拒。

⚠️ **这条链上不设询问,理由是询问在这里不区分风险**:GeoAgent 的 `bash` 本来就能做到同样的事(本机
只带一个受信任的 `Origin` 头就能调通壳的控制路由),一个能任意执行 shell 的智能体,点一下网页并没有
多拿到什么。插件**仍然每次调用都走一遍 `ask`**,机制留着、策略由配置决定:将来要收紧改一行配置,
不必改代码,裁决也会进日志。`plan` 拿得到浏览器工具却拿不到控制工具——它会建会话、删定时任务,而
`plan` 只读。

⚠️ **模型常把 `browser.` 前缀省掉只发 `click`。** 壳会把它解析成唯一同名的动作,而插件必须在 `ask`
**之前**做同一次归一,否则权限规则永远匹配不到、由通配放行。

⚠️ **两个工具名都是我们起的**,所以渲染层的工具元数据表**两个都得有条目**:缺条目的工具落到未知
工具的兜底,输出语言变成 `text`,JSON 回答因此丢掉高亮。

**截图落在 `<项目>/.browser/`**,与智能体在工作区里写文件同级,不单独询问。不用上游的
`.openchamber/screenshots`(那是别人的产品),也不用 `.geocode/`(那里是用户手写的配置)。截图需要
面板正在显示——面板关着或不是当前标签时合成器不出帧;读页、点击这些在页面内执行脚本的动作不需要。

#### 品牌资产的维护约束

**这个标志在仓库里有九处表现,要紧的是其中五处画在源码里而不是图片文件里**:两个启动闪屏、Logo
组件、图标精灵、内核的 OAuth 回调页。改标志时它们不会被任何图片替换流程带到。

- **两份母版不是一个尺寸**:静态母版比动画母版多一层 `scale(0.86)`。所以启动期的整屏加载面**一律用
  动画母版**,否则交接时标志会当场缩一下。
- **标志在启动路径上画三次,而那是三个互不相干的 SMIL 时钟**(主进程闪屏、`index.html`、React 组件
  各一份文档)。三段都把相位对到墙上时钟,否则每次交接星星都跳回轨道起点。
- **托盘图不是正方形。** 这个标志天然 1.5:1,塞进正方形画布只能缩到轨道宽度装得下为止,在菜单栏里
  明显比别的应用小。
- **加载标志不跟随系统的「减少动态效果」**,动画一直放。
- **启动末段星星会停一下,判为接受、不修。** 主线程解析 bundle 时 SMIL 会冻住,改成 CSS 动画的代价
  不值得。上游没有这个问题,是因为它的闪屏根本不做动画。
- macOS 继续走上游的 Icon Composer 管线,所以应用图标是**零代码改动**:只换前景图层。⚠️ **但要记得
  跑一次 `bun run generate:macos-icon` 重新生成 `Assets.car` 并提交**——那一步不在打包链里,而打包
  钩子找不到它会**直接让 macOS 打包失败**。
- OAuth 回调页的字标另算一份资产:横版的 `GeoCode` 像素画,与应用内那枚方形图形不是同一张。

### 7.3 不进入 GeoCode 产品

- Web / PWA;
- VS Code extension;
- iOS / Android;
- 对外 CLI / Server(`packages/web/bin` 不随应用分发,`ENVIRONMENT.md` §5.7);
- LAN、SSH host、Remote Instance、Relay、Tunnel 与设备配对;
- 选择或自动发现系统 OpenCode;
- OpenCode 自升级;
- 会话分享(内核侧的截断见 `KERNEL.md` §6 第 5 项,这里关的是界面入口);
- 仓库共享的项目配置与它带的仓库计划目录;
- 项目操作(把 shell 命令绑到顶栏按钮)与 worktree 的初始化命令;
- 写给程序员的斜杠命令(内核内置的 `/init`、`/review` 与界面自带的八条);
- OpenChamber 的外部插件管理、system-prompt optimizer,以及上游那条 agent-tool 注入管道
  (两个工具改由 GeoCode 自己注入,见 §7.2;记忆工具不注入)。

上游源码中的这些模块可以保留,但 GeoCode profile 下不得注册路由、启动定时器、建立网络连接或显示入口。
三条通则:

⚠️ **不注册不等于关上,关掉的路由要由壳自己抢先答 404。** 壳的通用代理注册在所有路由之后,把谁都没
接住的 `/api/*` 转给内核;而上游内核的兜底路由会把它不认识的路径**原样转发到 `app.opencode.ai`**,请求
头里还带着内核口令。「只是不注册」因此不等于不出网——实测过一次真的出去了。

⚠️ **按整个前缀关,不按路由逐条关。** 这样上游日后在组内新增的路由一并被拦,不必等人发现。

⚠️ **此约束必须用运行时测试验证,不能从「构建命令没有点名它」推断。**

**那几条与团队开发相关的,判据是同一条**:GeoCode 面向地理从业者,他们的代码需求很轻,基本不涉及
团队项目开发。共享项目配置是上游让一个团队把项目设置 commit 进仓库、队友 pull 就自动拿到的机制,
而它的内容是 worktree 初始化命令与绑在按钮上的项目操作——**也就是别人写的 shell 命令**,而我们的用户
常在不是自己写的仓库里工作。

**没有关掉的是 worktree 本身。** 它是两个会话改同一个项目而不打架的机制,创建入口在聊天输入区而不在
设置页;「现有工作树」列表照旧显示,它既是完整清单,也是删掉它们的入口之一。

**GitHub 的 PR 与工单面判为保留,判据与上面那些关掉的面不同,要分清。** 保留的是 Git 视图里的 PR 面板
(新建、编辑、合并、标为可评审、在 GitHub 打开)、它下面的 CI 检查详情、把失败的检查贴进对话让模型去
修,以及在聊天框里挂一个 GitHub 工单当上下文。⚠️ **判据是「它不往外送用户自己的数据」**——动的是
用户已经在 GitHub 上的东西,用的是用户自己的令牌。会话分享与 Routing 关掉是因为研究数据出门,这条
没有那个理由;它确实会写(建 PR、合并),但写的对象是用户自己的仓库,由用户按下按钮。启动时自动读取
`gh` 令牌同样判为不改。

GitHub 登录走 GeoCode 自有的 OAuth App,沿用上游的设备授权流程,不引入 Client Secret、回调服务或新的
登录协议;默认 scope 去掉了允许改写工作流文件的 `workflow`(读 PR 检查与工作流任务不需要它)。默认值
放在服务端代码里而不是用户设置里——**用户设置只覆盖本机,不能为新安装提供产品身份**。⚠️ 换 Client ID
**不影响已有授权**:旧令牌仍归原签发应用,已保存的账号需要重新连接;撤销原授权由用户自己在 GitHub 做,
因为那份授权可能还被他的 OpenChamber 用着。

## 8. 磁盘与身份

### 8.1 两类数据所有者

| 所有者 | 内容 | 位置原则 |
|---|---|---|
| Electron / Shell | 窗口、主题、布局、桌面偏好 | `~/.config/GeoCode/desktop/`(挂在 HOME 下的理由见 `PATHS.md` §5);壳日志见 `PATHS.md` §3.3 |
| Agent Kernel / GeoKernel | 会话、账号、配置、缓存、快照、地理环境 | `PATHS.md` 定义的 GeoCode XDG 根 |

Shell Runtime 不得沿用 OpenChamber 的 `~/.config/openchamber`,也不得直接读写
`~/.config/opencode`、`~/.local/share/opencode`、`.opencode/` 或 `opencode.json`。

面向内核的设置照上游的形态:壳自己读写内核的配置与凭据文件,只是根换成了内核的(`PATHS.md` §5);
登录供应商(API key 与 OAuth)经代理调 Kernel。磁盘上因此只有一份事实,要防的是两个读写方对不上——
壳写的根、文件名与层级顺序必须正是内核读的那一份,由门里的设置往返逐类比对(`CONVENTIONS.md` §7);
写完之后怎样让 Kernel 看见,见 §5.2。

### 8.2 环境变量边界

规则与实现记录在 `ENVIRONMENT.md`:**带商标的剥,不带商标的不动。** 壳与内核用同一份前缀表
(`kernel-environment.mjs`),剥离在主进程的登录 shell 合并之后、我们自己的注入之前,壳的第一条 import
就是它;仍能到达内核的只有 `startEmbeddedKernel` 的 `overrides` 与 sidecar 经 IPC 自设的凭据。

## 9. 双上游维护

规则在 `CONVENTIONS.md` §5:两棵 vendored 树用的是同一套机制——原味分支、闭包清单、补丁标记、
绊线、合并纪律与锁文件处理。本节只记 desktop 这一棵自己的参数。

```
GeoCode/
├── kernel/    OpenCode vendor    ← kernel-upstream
└── desktop/   OpenChamber vendor ← chamber-upstream
```

| | |
|---|---|
| 原味分支 | `chamber-upstream` |
| 闭包清单 | `scripts/chamber-manifest.txt`,**排除项的理由写在清单里**,不在本文 |
| 圈选脚本 | `scripts/chamber-vendor.sh`,取完做文件集对账,commit 由维护者亲自执行 |
| 闭包边界 | **包层面全取**,排除的只有上游的开发设施。为证明「只做 Desktop」而删 mobile / vscode / web 源码已在 §12 否决 |
| 当前基线 | 不记在本文里,它每次升级都变。查法:`git log -1 --format=%s chamber-upstream` |

两个 vendor 根各自是独立的安装与测试单元。仓库根只编排构建,不把二者揉成一个依赖方向混乱的
workspace。

Shell 侧的定制阶梯与内核同一条,落点是:能在 `geocode-desktop` profile 里关掉的能力,**不删除上游
实现**;必须修改上游文件的地方集中在组合根、构建入口与身份边界,不在大量叶子组件里撒条件分支。

---

## 10. 迁移定下的常驻约束

OpenChamber 的迁移已经做完,逐批的经过与结论在 `.artifacts/DECISIONS.md`。本节只留**迁移期定下、
此后一直生效的约束**——它们不随迁移结束而失效,新写的代码同样要守。

**壳与别的产品共用的东西一律改到我们自己的根下,哪怕它看起来只是缓存。** 判据不是「会不会泄漏
数据」,而是**「它会不会替别人做决定」**。受管进程登记表就是这条的来源:孤儿回收在任何分支判断
之前无条件运行,而**它按登记表里的 pid 去杀进程**——共用一份就会杀掉用户自己的 OpenChamber 正在
跑的东西。落点见 `PATHS.md` §3.3。

**往用户项目里写东西,位置既不能是别人的产品,也不能是用户手写配置的地方。** 智能体截图落
`.browser/` 就是这条的应用:`.openchamber/screenshots` 是别人的,`.geocode/` 是用户自己写配置的。

**属于别的 agent 工具的目录,判据是归属,不是开放与否**(判法与落点在 `PATHS.md` §7)。⚠️ 关闭
这类目录时**读与写必须一起关**:只关读会让用户建得出、改不了,比两头都开更糟。

**迁移查出来的缺陷里最多的一类不是泄漏,是坏掉的功能。** 读的一侧改了、写的一侧没改,两边各自
自洽,单看任何一侧都正常——计划面板因此永远报「没有计划」,行为页保存成功而 agent 一个字都看不到。
**改一条路径时必须同时数清它的读取方与写入方**(`PATHS.md` §5)。

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
- Kernel 运行中死亡时 UI 切到可归因的失败屏,重试重开应用后恢复快照与事件流;
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
- 每次上游合并后逐项审阅 GeoCode 在该目录上的全部改动(清单取自 `git diff --name-status`,见 `CONVENTIONS.md` §5);上游自己的套件不归我们维护(`CONVENTIONS.md` §7);
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

## 14. 相关文档

| 文档 | 分工 |
|---|---|
| `DESIGN.md` | 产品定位与总架构 |
| `OVERVIEW.md` | 当前实现状态与执行时序 |
| `KERNEL.md` | OpenCode 薄 fork、Agent 装配与生产 bundle |
| `GEOKERNEL.md` | 地理执行内核与三个出口面 |
| `TOOLS.md` | 模型工具、权限和输出契约 |
| `PATHS.md` | 磁盘、系统身份与命名空间隔离 |
| `ENVIRONMENT.md` | 环境变量边界 |
| `CONVENTIONS.md` | 开发、补丁、测试,以及两棵 vendored 树的闭包与合并纪律 |
