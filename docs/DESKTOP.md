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
| `OPENCODE_SERVER_USERNAME/PASSWORD` | 本次启动生成的 Kernel Basic 凭据 |
| `OPENCODE_SKIP_START` / `OPENCHAMBER_SKIP_OPENCODE_START` | 固定为 `true` |

这些名字不成为 GeoCode 的公开配置;main 会先剥离继承的 `OPENCODE_*`,再从公开的
`GEOCODE_*` 映射,最后用受管连接覆盖 host 与认证。对 Shell Runtime 而言 Kernel 是
「外部服务」,但对整个应用而言它仍是 Electron 自己拥有的内嵌进程。

Shell Runtime 到 Kernel 的这一段使用固定到本次应用进程的连接。OpenChamber 的 external
restart 当前只会重新探测健康,不会重启 Kernel;将配置 Apply/Restart 委托回 Electron main
并完成事件流重绑,仍是阶段 3 完成前必须补齐的生命周期接缝。

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

## 5. 启动、重启与退出

### 5.1 启动顺序

1. Electron main 建立 GeoCode appId、userData 与日志路径;
2. 清理上次崩溃留下且能证明属于 GeoCode 的孤儿进程;
3. 从公开 `GEOCODE_*` 环境构造 Kernel 内部环境,剥离继承来的 `OPENCODE_*` 后再映射;
4. 选择 Kernel loopback 端口并生成随机口令;
5. 启动 Kernel utility process,等待 ready 与 `/global/health`;
6. 启动 Shell Runtime,以注入的 Kernel URL 与认证作为唯一上游;
7. 选择 Shell Runtime loopback 端口并确认健康;
8. 创建窗口,经 preload 下发 Shell Runtime 连接信息;
9. renderer 加载打包内 React UI 并开始同步。

窗口不能在「服务地址尚未确定」时自行猜测默认端口。失败必须落在可诊断的启动阶段,
而不是让 UI 在一个永远连不上的地址上转圈。

### 5.2 Kernel 重启

需要重启 Kernel 的配置变更由 Shell Runtime 请求 Electron main 执行:

1. UI 发起明确的 apply / restart 动作;
2. main 将 Shell Runtime 的上游状态置为 restarting;
3. main 停止旧 Kernel,确认端口释放;
4. main 启动新 Kernel并完成健康检查;
5. main 将新的 URL / 认证注入 Shell Runtime;
6. Shell Runtime 重绑代理与事件流;
7. UI 从快照重新建立状态。

Shell Runtime 不得自行 spawn 第二个 Kernel;renderer 也不得持有旧 Kernel 地址并尝试直连。

### 5.3 正常退出

顺序固定:

1. 停止接受新的 UI 请求;
2. 关闭 Shell Runtime 的 SSE / WebSocket 与监听器;
3. 请求 Agent Kernel 正常停止;
4. Agent Kernel 清扫 GeoKernel 登记的全部地理子进程;
5. 超过上限仍未退出时,Electron main 强制结束 Kernel 进程树;
6. main 最后退出。

只关闭窗口不等于退出应用的平台行为,由产品设置决定;一旦进入真正退出路径,上述清扫不可跳过。

### 5.4 崩溃恢复

正常退出覆盖不了断电、主进程崩溃与强制结束。每次启动需要一份范围严格的孤儿清扫:

- 只处理有 GeoCode 所有权记录的 pid / 端口;
- pid 复用时必须以进程身份或启动记录复核,不能凭一个旧数字杀进程;
- 外部 QGIS / Python 只有在它是已登记 Kernel 后代时才能清理;
- 清扫失败写日志并继续给出可诊断状态,不得无限阻塞启动。

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

### 7.3 不进入 GeoCode 产品

- Web / PWA;
- VS Code extension;
- iOS / Android;
- 对外 CLI / Server;
- LAN、SSH host、Remote Instance、Relay、Tunnel 与设备配对;
- 选择或自动发现系统 OpenCode;
- OpenCode 自升级;
- OpenChamber 的外部插件管理、system-prompt optimizer 与 agent-tool 注入;
- 面向编程工作的 GitHub 发布流、Multi-run / Fusion、Session Goals 与 Scheduled Tasks;
- 面向编程项目的 agent / command 管理表面。

上游源码中的这些模块可以保留,但 GeoCode profile 下不得注册路由、启动定时器、建立网络连接
或显示入口。此约束需用运行时测试验证,不能从「构建命令没有点名它」推断。

---

## 8. 磁盘与身份

### 8.1 两类数据所有者

| 所有者 | 内容 | 位置原则 |
|---|---|---|
| Electron / Shell | 窗口、主题、布局、桌面偏好、壳日志 | `<appData>/ai.geocode.desktop/` |
| Agent Kernel / GeoKernel | 会话、账号、配置、缓存、快照、地理环境 | `PATHS.md` 定义的 GeoCode XDG 根 |

Shell Runtime 不得沿用 OpenChamber 的 `~/.config/openchamber`,也不得直接读写
`~/.config/opencode`、`~/.local/share/opencode`、`.opencode/` 或 `opencode.json`。

保留功能优先通过 Agent Kernel API 操作配置与认证。确实没有 API 的壳侧偏好留在 Electron
userData;不能为了复用 OpenChamber 一段读文件代码而重新引入第二套 Agent 配置事实。
OpenChamber Settings 的逐页调查、Kernel API 缺口、目标请求流与实施门,在阶段 2 开工时
落成 `DESKTOP-CONFIG-MIGRATION.md`(§10)。

### 8.2 环境变量边界

公开命名空间仍为 `GEOCODE_*`;Agent Kernel 内部继续保留 `OPENCODE_*` wire 指纹。
翻译只发生在 Electron main 构造 utility process 环境时:

1. 从继承环境中剥离全部 `OPENCODE_*`;
2. 将 `GEOCODE_X` 映射为 Kernel 认识的 `OPENCODE_X`;
3. 最后注入本次启动生成的内部口令与进程标记。

Shell Runtime 不再拥有另一条独立的 Kernel spawn 路径,因此不会出现一个入口做了翻译、另一个
入口漏做的情况。

---

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

**当前基线不记在本文里。** 它每次升级都变,写下就会漂(`CONVENTIONS.md` §10 第二条)。查法是
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
| `.agents/` 与 `AGENTS.md` | **会被 Kernel 读进去**:`.agents/skills` 下的 `SKILL.md` 经 `fsys.up`(从 cwd 向上找到 worktree)进入技能列表;`AGENTS.md` 经 `findUp` 进入系统提示,而它收集**所有**祖先匹配、不是最近的一个。两者都不受 Claude Code 屏蔽开关保护——KERNEL.md §6 第 3 项管的是另外两个来源 |
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

Shell 迁入时建立 `docs/SHELL.md` 或本文的扩展注入表,逐项记录:

- 修改的上游位置;
- 为什么配置、注入或新增文件做不到;
- 用户可见效果;
- 对应运行时绊线;
- 上游将来提供正式扩展点时如何撤销补丁。

所有 Shell 补丁使用统一 `GeoCode:` 标记,一条命令可列全。提示词、翻译资源等不能容纳标记的
文件由测试绑定。

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

- 先落成 `DESKTOP-CONFIG-MIGRATION.md`——对着已落地的 vendor 代码调查 Settings 各页的所有权
  与 Kernel API 缺口,再定实施批次;
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

- 先落成 `DESKTOP-PATH-MIGRATION.md`,再按它分批实施并执行零访问验收;
- 完成 GeoCode 品牌与系统注册项;
- 将 Shell 偏好迁到 Electron userData;
- 消除生产运行产生的 OpenChamber / OpenCode 用户目录;
- 验证环境变量翻译;
- 验证与用户自装 OpenCode 并存互不读写。

### 阶段 7:桌面功能与地理界面

在基础闭环稳定后,按独立批次接入 diff、终端、通知、地理设置、地图与预览。每一批都有自己的
用户流程和验收,不回头改变基础进程边界。

### 阶段 8:双平台打包

macOS arm64 与 Windows x64 分别完成:

- 干净机器首次安装;
- 开发版与正式版数据隔离;
- 启动、更新通知、卸载与重装;
- 原生模块与 Kernel 架构验证;
- 正常退出、崩溃恢复和孤儿清扫;
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
3. Shell 补丁的注入表放 `docs/SHELL.md` 还是本文的扩展章节(§9.4),待补丁实际分布可见后定;
4. Shell Runtime 凭据的具体 token 形状与过期策略;
5. utility process 异常退出后的自动重启次数与退避;
6. GeoCode 应用更新通知的检查间隔和发布清单格式。

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
