# 开发环境与运行

本文档说明怎么安装依赖、构建内核、在沙箱里启动应用、打包,以及怎样运行检查、测试与写入检测。

## 1. 仓库结构

```
docs/        设计与规范
scripts/     上游导入(vendor.sh 与圈选清单)、内核与 GeoEngine 的构建与暂存、按套件运行测试、写入检测、补丁面统计、死代码检查、GeoCode 自有文件的 anti-slop 检查
kernel/      OpenCode 的源码(见 UPSTREAM.md)
desktop/     OpenChamber 的源码(见 UPSTREAM.md)
geoengine/   GeoEngine,GeoCode 自己的地理引擎(见 GEOENGINE.md)
```

`kernel/`、`desktop/` 与 `geoengine/` 各自独立安装依赖。上游的项目介绍类文件(README、CHANGELOG 等)不在本仓库里,要看上游某个包的说明,到上游仓库对应的版本查看。

## 2. 工具链

- bun:版本以 `kernel/package.json`、`desktop/package.json` 与 `geoengine/package.json` 的 `packageManager` 为准,三者应当一致。版本过低或主版本不同时,内核的构建脚本拒绝运行。
- Node:22.18 或更新,`geoengine/` 的测试命令需要这个版本。
- gh:`scripts/vendor.sh` 用它下载上游源码。

## 3. 安装依赖

```bash
(cd kernel && bun install)
(cd desktop && bun install)
(cd geoengine && bun install)
```

`desktop/` 的安装会下载 Electron,并构建 SDK 与内置扩展。

## 4. 构建内核与 GeoEngine

```bash
./scripts/stage-kernel.sh
```

它只构建本机平台的内核,产物放到 `desktop/packages/electron/resources/opencode-cli/geocode-kernel`(改成 GeoCode 自己的文件名,见 `DESKTOP.md` 第 6 节;Windows 上为 `geocode-kernel.exe`)。脚本把 `kernel/package.json` 的 `version` 注入内核,并核对它报出的版本;直接用上游的构建命令得到的是预览版本号,过不了壳启动内核前的版本检查。

改动 `kernel/` 之后要重新运行它,应用才会用上新的内核。

GeoEngine 由 `./scripts/stage-geoengine.sh` 构建并暂存到 `desktop/packages/electron/resources/geoengine/geoengine.mjs`,打包时收进 `app.asar`。GeoCode 的 Python 包 `geocodekit`(`geoengine/python/`)在这一步原样编进 `geoengine.mjs`,由 GeoEngine 装进内置环境(`GEOCODEKIT.md` 第 6 节),改了其中的 `.py` 文件同样要重新构建。开发模式的启动脚本每次启动前都运行它,打包流程也运行它,平时不用手动执行;`geoengine/` 没装依赖时它报错退出。

内置的 Python 环境(见 `PYTHON.md`)由 `./scripts/stage-python.sh` 按 `geoengine/environment/` 里的定义准备:用 pixi-pack 把锁定清单里这个平台的包打成 `python.tar`,与这个平台的 pixi-unpack 一起暂存到 `desktop/packages/electron/resources/python/`,打包时作为额外资源收进应用。它按 `tools.json` 下载固定版本的工具并核对校验和,工具与下载的包放在仓库的 `.cache/python/`,不读用户自己的 pixi 配置。环境的标识没变时它直接跳过,所以开发模式的启动脚本每次启动前也运行它。默认准备本机平台的环境,并用 pixi-unpack 在 `.cache/python/` 里装一份,核对 Python 的版本并运行 `pip check`;给出 `win32-x64` 或 `darwin-arm64` 也能为另一个平台准备,只是不装、不核对。改了 `geoengine/environment/pixi.toml` 之后,运行 `./scripts/stage-python.sh --lock` 重新生成两个平台的锁定清单 `pixi.lock`,与它一起提交。

## 5. 在沙箱里启动应用

开发时在沙箱主目录里启动。应用把配置、数据与缓存放在主目录下名为 `geocode` 的几个目录里(见 `PATHS.md`),在沙箱里启动,开发与测试留下的会话、登录与设置就不会混进真实主目录里的那一份,删掉沙箱即可从头再来。

```bash
SANDBOX=<一个空目录,放在仓库外>

cd desktop
HOME="$SANDBOX" \
OPENCHAMBER_DESKTOP_USER_DATA_DIR="$SANDBOX/electron-user-data" \
bun run electron:dev:bundled
```

壳与内核都从 `HOME` 推导自己的数据、配置与缓存目录,前提是环境里没有设 `XDG_*` 变量,设了的话两者都会改用它们。Electron 自己的配置目录在 macOS 上按系统账户找主目录,不看 `HOME`,所以要用 `OPENCHAMBER_DESKTOP_USER_DATA_DIR` 单独指定。系统的偏好设置同样按系统账户存放,沙箱挡不住:开发时写进 Electron 通用的 `~/Library/Preferences/com.github.Electron.plist`(打包出的应用写的那一份见 `PATHS.md` 第 5 节),里面只有文件对话框的位置这类系统记下的状态。Electron 的日志写在 `$SANDBOX/Library/Logs/` 下,跟着 `HOME` 走。

`electron:dev:bundled` 先构建界面,再用构建好的界面启动,壳使用第 4 节暂存的内核;没有暂存时,启动日志提示「bundled OpenCode CLI missing」,内核起不来。`electron:dev` 用热更新的界面,适合改界面时快速查看,但它另起的壳服务端不在 Electron 里,访问控制(`DESKTOP.md` 第 4 节)在那里不生效,也接不到 GeoEngine,地理环境与地理工具都不可用;验证这些要用 `electron:dev:bundled` 或打包出的应用。这两种启动里,窗口的加载动画都等内置的 Python 环境就绪(`PYTHON.md` 第 7 节),新沙箱第一次启动要多等一会;`electron:dev` 没有 GeoEngine,不等。

沙箱里没有登录信息,要对话就在沙箱里连接一个模型服务,或在沙箱的全局配置里配一个本机的 OpenAI 兼容接口。OpenCode 的免费模型只对 OpenCode 自己的客户端开放,GeoCode 用不了。测完删掉沙箱目录即可。

## 6. 打包(macOS)

```bash
cd desktop/packages/electron
CSC_IDENTITY_AUTO_DISCOVERY=false bun run package -- --dir -c.mac.identity=- -c.mac.notarize=false
```

`package` 依次构建界面、暂存内核与 GeoEngine(第 4 节)、打包主进程、重建原生模块,再调用 electron-builder。`--dir` 只生成应用目录 `dist/mac-arm64/GeoCode.app`,不生成 dmg 与 zip;`-c.mac.identity=-` 用临时签名(ad-hoc),不需要开发者证书;`-c.mac.notarize=false` 不公证。不要单独运行上游的 `verify:opencode-cli`:它找的是上游的文件名 `opencode`,核对的是上游固定的版本,对 GeoCode 的内核必然失败。

macOS 的应用图标不在打包时生成。`resources/icons/AppIcon.icon` 是它的源(Icon Composer 的文档,图层在其中的 `Assets/` 里),编译出的 `resources/icons/Assets.car` 提交在仓库里,打包只把它拷进应用,缺了它打包会失败。改了图层或 `icon.json` 之后,在 `desktop/packages/electron` 运行 `bun run generate:macos-icon` 重新生成(需要 Xcode),与源一起提交。浅色与深色两张图层沿用上游的文件名,灰度的一张是 GeoCode 加的。

在沙箱里运行打包出的应用,直接执行 `.app/Contents/MacOS/` 下的可执行文件,带上第 5 节的 `HOME`,Electron 的配置目录改用参数 `--user-data-dir=<沙箱里的目录>` 指定:打包出的应用不接受 `OPENCHAMBER_` 开头的环境变量(见 `DESKTOP.md` 第 5 节)。这个参数来自 Chromium,Electron 的文档没有列出,升级 Electron 后要确认它仍然有效。再加上 `--remote-debugging-port=<端口>`,就能以 DevTools 协议从外部检查各个窗口,例如读取页面状态、记录网络请求,或取出窗口的令牌来测试壳服务端的接口。

## 7. 检查与测试

类型检查与 lint 的命令见 `CONVENTIONS.md` 第 2 节,测试写什么、放在哪里、怎么证明它会失败见同一篇第 4 节。

### 7.1 三层

GeoCode 的测试分三层,分开运行:

- 单元测试:只碰替身与假对象(替身的 earthengine-api、假的 QGIS 应用包、测试自己打的环境包、上游的夹具),只写临时目录,不联网。
- 真实软件的测试:接本机真实的 QGIS 与真实的 Earth Engine,测替身证明不了的。它们慢,GEE 的还用用户的额度,所以不和单元测试一起跑,只在改动可能影响它们时跑。
- 应用:开发版或打包版里的真实会话,在写入检测(第 8 节)的监视下。

什么时候跑哪一层,见 `CONVENTIONS.md` 第 4 节。

### 7.2 运行

前两层都用仓库根目录的 `scripts/test.mjs` 按套件运行:

```bash
node scripts/test.mjs changed           # 工作区相对 HEAD 的改动要求的套件
node scripts/test.mjs geoengine qgis    # 指名的套件
node scripts/test.mjs all               # 全部套件
node scripts/test.mjs --list changed    # 只列出要跑的套件与原因,不运行
```

| 套件 | 内容 |
|---|---|
| `kernel` | 内核各包里 GeoCode 的测试:自己的测试文件整份运行,上游测试文件里只运行以 `GeoCode: ` 开头的用例 |
| `ui`、`web`、`electron` | 桌面端这三个包 `geocode/` 目录下的测试 |
| `geoengine` | GeoEngine 的单元测试(`geoengine/test/unit/`) |
| `qgis` | 在本机每一套 QGIS 上运行的测试(`geoengine/test/real/` 里 QGIS 的) |
| `gee` | 在真实 Earth Engine 上运行的测试(`geoengine/test/real/` 里 GEE 的),设了 `GEOENGINE_GEE_PROJECT=<项目 ID>` 才跑,没设时只提示 |

套件依次运行,一个失败不影响后面的,最后列出每个套件的结果与用时;GeoEngine 的套件还列出跳过了几项,全部跳过的算没跑。有套件失败时退出码为 1;没有失败、但有套件没跑(如没设项目时的 `gee`、本机没有 QGIS 时的 `qgis`)时为 3;用法错误时为 2。

`changed` 按改动的路径挑选。内核与桌面端的测试有几项读或导入别的部分的源码,它们又都很快,所以除了文档与 GeoEngine 的测试文件,任何改动都跑这四个套件;GeoEngine 的单元测试只在 `geoengine/` 有改动时跑;真实软件的测试只在改动可能影响它时跑:能力域自己的代码影响它自己的,内置环境影响在环境里运行的能力域,各能力域共用的部分影响全部。规则写在脚本里;加了新的能力域,在那里登记它有没有真实软件的测试、用不用内置环境。

改代码、反复试的时候,在包目录直接跑改到的那个测试文件,不必跑整个套件,如在 `geoengine/` 里 `node --test <文件>`。

### 7.3 各部分的测试

各部分的测试都不能写真实的主目录:

- `kernel/`:GeoCode 的测试有两种,加在上游测试文件里的用例(命名见 `CONVENTIONS.md` 第 4 节)与 GeoCode 自己的测试文件(位置见 `CONVENTIONS.md` 第 3.4 节),都借用上游的夹具,在包目录以 `bun run test <文件>` 运行。`packages/core` 的这条命令把主目录、`XDG_*` 与 `TMPDIR` 换成临时目录,其他包(如 `packages/server`)的不换,所以 `scripts/test.mjs` 给每次运行一个临时主目录;在包里单独跑时照下面上游测试的办法换。不要在包里直接执行 `bun test`。
- `desktop/`:GeoCode 的测试在各包的 `geocode/` 目录。包的 `bun run test` 会连上游的测试一起跑,所以只跑这些目录。
- 上游的测试不保证只写临时目录,`web` 包里就有测试在主目录下建目录、写 npm 缓存。要跑它们时换一个临时主目录:`env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_STATE_HOME HOME=<临时目录> bun run test -- <路径>`。`XDG_*` 要去掉而不是设成空值,否则 Bun 会把转译缓存写到当前目录下。
- `geoengine/`:单元测试在 `test/unit/`,按能力域分目录(`qgis`、`gee`、`python`,引擎本身的直接放在 `test/unit/` 下);真实软件的测试在 `test/real/`,每个能力域一个文件,以能力域命名;共用的夹具在 `test/support/`。包的 `bun run test` 只跑单元测试,`bun run test:qgis` 与 `bun run test:gee` 各跑一种真实软件的测试,`scripts/test.mjs` 照这几条命令运行它们。测试在系统临时目录下建以 `geoengine-` 开头的目录,结束时删掉;有的测试启动外部进程并验证它们被结束,所以按顺序逐个运行。

GeoEngine 的测试涉及三种外部软件:

- QGIS:单元测试里经 QGIS 运行的几项用假的应用包,里面的解释器是一段 shell 脚本,只在 macOS 上跑。真实软件的测试在 macOS 上接真实的 QGIS,默认用 `/Applications` 下每一个认得出的 `QGIS*.app`,也可以用 `GEOENGINE_QGIS_APPS` 列出应用包的路径(以冒号分隔);本机没有 QGIS 时这几项记为跳过;`/Applications` 下有、但找不到它的 Python 的,也各记一项跳过。QGIS 照常在用户目录下写它自己的配置与缓存。Windows 上认路径与发现安装的逻辑在任何平台上都测,用的是照 OSGeo4W 的真实组件包搭出的假目录树;经启动脚本运行 QGIS 只能在 Windows 上验证。
- 内置的 Python 环境:测试自己打一个很小的包,配一个替身 pixi-unpack(一段 shell 脚本,像真的那样经临时目录解开它、留下激活脚本),包里的 `python3` 转去运行 `PATH` 里的 `python3`,不用真实的环境与 pixi-unpack;没有 `python3` 时与在 Windows 上这些项跳过。真实的环境要在应用里验证。
- GEE:单元测试不联网。环境检查、运行、登录与查额度的脚本都用 `PATH` 里的 `python3` 真实执行,它代替 `base` 的解释器,同样以隔离模式运行;earthengine-api、它用到的 Google 库与 requests 换成测试自带的替身,`geocodekit` 直接用 `geoengine/python/` 里的源码,两者都由标准输入里程序之前的一行加进导入路径(隔离模式不读 `PYTHONPATH`)。没有 `python3` 时与在 Windows 上这些项跳过。真实软件的测试用真实的 Earth Engine,测替身证明不了的:没有 Earth Engine 自己的凭据时报未登录,缺项目时报缺项目、写进项目后就绪,不可能存在的项目 ID 被报为项目不存在,运行用的是 `base` 的解释器、以 Earth Engine 自己的报错结束,以及检查与核心链路都经过本机的一个转发代理(geedim 的请求也要经过它)。它们用这台电脑上登录的账号与它的额度,设了 `GEOENGINE_GEE_PROJECT=<项目 ID>` 才跑;只读 Earth Engine 自己的凭据,只查询、下载到临时目录,不存资产。解释器是数据目录里 GeoCode 装好的 `base`,或 `GEOENGINE_GEE_DATA` 所指的数据目录里的;它的启动文件与 `geocodekit` 要是当前代码写的(改了之后启动一次开发版),否则这几项失败并说明。改了环境的定义(`environment/`)之后同样先启动一次开发版,让它装上新的环境;这一点测试查不出,装着的旧环境照样能跑过。

## 8. 写入检测

安装依赖、启动应用这类可能写盘的操作,前后各运行一次:

```bash
./scripts/foreign-writes.sh before
# 安装、构建、启动应用并操作
./scripts/foreign-writes.sh after
```

它检查 OpenCode、OpenChamber(包括它在 `~/Library` 下的窗口数据与日志)的目录、Claude 的技能、`CLAUDE.md` 与凭据,以及通用的 `~/.agents` 目录有没有被写入,文件的新增、修改、删除与权限变化都算。无论在沙箱里还是在真实主目录下启动,结果都应当是干净的。退出码:0 干净;1 发现写入;3 需要人确认,表示变动全在 OpenChamber 与 OpenCode 自己的目录里,而本机的 OpenChamber 在这段时间里运行过,多半是它自己写的,关掉它重跑才能得出结论。
