# 开发环境与运行

怎样安装依赖、构建、在沙箱里启动应用、打包,以及怎样运行检查、测试与写入检测。要守的规则见 `CONVENTIONS.md`。

## 1. 仓库结构

```
docs/        设计说明;docs/development/ 下是开发文档
scripts/     内核、GeoEngine 与 Python 环境的构建与暂存,按套件运行测试,写入检测,检查用的小工具
kernel/      内核,基于 OpenCode
desktop/     桌面应用,基于 OpenChamber
geoengine/   地理引擎 GeoEngine,以及 Python 包 geocodekit(geoengine/python/)
```

`kernel/`、`desktop/` 与 `geoengine/` 各自独立安装依赖。

## 2. 工具链

- bun:版本以 `kernel/package.json`、`desktop/package.json` 与 `geoengine/package.json` 的 `packageManager` 为准,三者应当一致。版本过低或主版本不同时,内核的构建脚本拒绝运行。
- Node:22.18 或更新,`geoengine/` 的测试需要这个版本。

## 3. 安装依赖

```bash
(cd kernel && bun install)
(cd desktop && bun install)
(cd geoengine && bun install)
```

`desktop/` 的安装会下载 Electron,并构建 SDK 与内置扩展。

## 4. 构建

```bash
./scripts/stage-kernel.sh
```

它只构建本机平台的内核,产物放到 `desktop/packages/electron/resources/opencode-cli/geocode-kernel`(Windows 上为 `geocode-kernel.exe`,名字见 `DESKTOP.md` 第 6 节)。脚本把 `kernel/package.json` 的 `version` 注入内核并核对它报出的版本;不经这个脚本构建的内核带的是预览版本号,过不了启动内核前的版本检查。改动 `kernel/` 之后要重新运行它,应用才会用上新的内核。

GeoEngine 由 `./scripts/stage-geoengine.sh` 构建并暂存到 `desktop/packages/electron/resources/geoengine/geoengine.mjs`,打包时收进 `app.asar`。Python 包 `geocodekit`(`geoengine/python/`)在这一步原样编进 `geoengine.mjs`,由 GeoEngine 装进内置环境(`GEOCODEKIT.md` 第 6 节),所以改了其中的文件同样要重新构建。开发模式的启动脚本与打包流程都会运行它,平时不用手动执行;`geoengine/` 没装依赖时它报错退出。

OSM 工具读的预设库 `geocodekit/osm/_data.json` 由 `geoengine/` 里的 `bun ./script/osm-data.ts` 按脚本里锁定的版本下载、裁剪后写出;改了版本之后运行它,与写出的文件一起提交。

内置的 Python 环境(`PYTHON.md`)由 `./scripts/stage-python.sh` 按 `geoengine/environment/` 里的定义准备:用 pixi-pack 把锁定清单里这个平台的包打成 `python.tar`,与这个平台的 pixi-unpack 一起暂存到 `desktop/packages/electron/resources/python/`,打包时作为额外资源收进应用。它按 `tools.json` 下载固定版本的工具并核对校验和,工具与下载的包放在仓库的 `.cache/python/`,不读用户自己的 pixi 配置。环境的标识没变时它直接跳过,所以开发模式的启动脚本每次启动前也运行它。默认准备本机平台的环境,并在 `.cache/python/` 里装一份,核对 Python 的版本并运行 `pip check`;给出 `win32-x64` 或 `darwin-arm64` 也能为另一个平台准备,只是不装、不核对。改了 `geoengine/environment/pixi.toml` 之后,运行 `./scripts/stage-python.sh --lock` 重新生成两个平台的锁定清单 `pixi.lock`,与它一起提交。

更新锁定清单之后,在两个平台上检查环境(还没有做成脚本,手动运行)。检查在工作环境里运行,不设任何变量,再在用户环境里的 `GDAL_DATA`、`PROJ_DATA` 等指向别处、`~/.gdal/gdalrc` 关掉了驱动时另跑一遍:

- 工作环境的 Python 启动时不打印任何错误,启动文件设的变量都指向 `base`(启动文件出错时 Python 照常运行,只是变量没设,所以要专门查)。
- 每个预装的包都能导入;经 pyogrio 读写 GeoPackage、经 rasterio 读写 GeoTIFF,两者与 `osgeo` 用的是同一份 GDAL;GDAL 的驱动插件都能加载;`gdalwarp`、`ogr2ogr` 能运行;一次真实的坐标变换成功(投影数据库缺失时它才失败)。
- Python 的 `urllib`、requests 与 GDAL 读网上的文件都能经 HTTPS 连上(证书的位置错了才失败)。
- 设了代理变量时,urllib、requests、aiohttp 与 GDAL 的请求都经过它(本机一个只记录、不转发的代理就能查,不联网);没设时系统设置里的代理不被读到。
- 装到带空格与中文的路径后照样通过。

## 5. 在沙箱里启动应用

开发时在沙箱主目录里启动。应用把配置、数据与缓存放在主目录下名为 `geocode` 的几个目录里(`PATHS.md`),在沙箱里启动,开发与测试留下的会话、登录与设置就不会混进真实主目录里的那一份,删掉沙箱即可从头再来。

```bash
SANDBOX=<一个空目录,放在仓库外>

cd desktop
HOME="$SANDBOX" \
OPENCHAMBER_DESKTOP_USER_DATA_DIR="$SANDBOX/electron-user-data" \
bun run electron:dev:bundled
```

壳与内核都从 `HOME` 推导自己的数据、配置与缓存目录,不看 `XDG_*`。Electron 自己的配置目录在 macOS 上按系统账户找主目录,不看 `HOME`,所以要用 `OPENCHAMBER_DESKTOP_USER_DATA_DIR` 单独指定。系统的偏好设置同样按系统账户存放,沙箱挡不住:开发时写进 Electron 通用的 `~/Library/Preferences/com.github.Electron.plist`(打包出的应用写的那一份见 `PATHS.md` 第 5 节),里面只有文件对话框的位置这类系统记下的状态。Electron 的日志写在 `$SANDBOX/Library/Logs/` 下。

`electron:dev:bundled` 先构建界面,再用构建好的界面启动,使用第 4 节暂存的内核;没有暂存时启动日志提示「bundled OpenCode CLI missing」,内核起不来。`electron:dev` 用热更新的界面,适合改界面时快速查看,但它另起的壳服务端不在 Electron 里,本机访问控制(`DESKTOP.md` 第 4 节)在那里不生效,也接不到 GeoEngine,地理环境与地理工具都不可用;验证这些要用 `electron:dev:bundled` 或打包出的应用。窗口的加载动画等内置的 Python 环境就绪(`PYTHON.md` 第 8 节),新沙箱第一次启动要多等一会;`electron:dev` 没有 GeoEngine,不等。

沙箱里没有登录信息,要对话就在沙箱里连接一个模型服务,或在沙箱的全局配置里配一个本机的 OpenAI 兼容接口。opencode.ai 的免费模型不对 GeoCode 开放。测完删掉沙箱目录即可。

## 6. 打包(macOS)

```bash
cd desktop/packages/electron
CSC_IDENTITY_AUTO_DISCOVERY=false bun run package -- --dir -c.mac.identity=- -c.mac.notarize=false
```

`package` 依次构建界面、暂存内核与 GeoEngine(第 4 节)、打包主进程、重建原生模块,再调用 electron-builder。`--dir` 只生成应用目录 `dist/mac-arm64/GeoCode.app`,不生成 dmg 与 zip;`-c.mac.identity=-` 用临时签名(ad-hoc),不需要开发者证书;`-c.mac.notarize=false` 不公证。包里的 `verify:opencode-cli` 找的是别的文件名与版本,对 GeoCode 的内核必然失败,不要单独运行它。

macOS 的应用图标不在打包时生成。`resources/icons/AppIcon.icon` 是它的源(Icon Composer 的文档,图层在其中的 `Assets/` 里),编译出的 `resources/icons/Assets.car` 提交在仓库里,打包只把它拷进应用,缺了它打包会失败。改了图层或 `icon.json` 之后,在 `desktop/packages/electron` 运行 `bun run generate:macos-icon` 重新生成(需要 Xcode),与源一起提交。

在沙箱里运行打包出的应用,直接执行 `.app/Contents/MacOS/` 下的可执行文件,带上第 5 节的 `HOME`,Electron 的配置目录改用参数 `--user-data-dir=<沙箱里的目录>` 指定:打包出的应用不接受 `OPENCHAMBER_` 开头的环境变量(`ENVIRONMENT.md` 第 2.1 节)。这个参数来自 Chromium,Electron 的文档没有列出,升级 Electron 后要确认它仍然有效。再加上 `--remote-debugging-port=<端口>`,就能以 DevTools 协议从外部检查各个窗口。

## 7. 检查与测试

### 7.1 检查

| 部分 | 命令 |
|---|---|
| `kernel/` | 在包目录 `bun run typecheck`,整棵树在 `kernel/` 执行 `bun turbo typecheck`;格式化用 `kernel/node_modules/.bin/prettier`(不用 `bunx prettier`,它会拉取别的版本) |
| `desktop/` | 在 `desktop/` 执行 `bun run type-check` 与 `bun run lint`,再在仓库根目录执行 `node scripts/own-anti-slop.mjs`。壳服务端与主进程的 JS 不在类型检查与 lint 的范围里,只由 anti-slop 与测试把关 |
| `geoengine/` | 在 `geoengine/` 执行 `bun run typecheck`;格式化用它自己目录下的 prettier |

`own-anti-slop.mjs` 只查 GeoCode 自己的文件,还没加入 git 的也算;确实要保留的违规写进脚本的例外清单,注明原因与处数。

`node scripts/dead-code.mjs <文件…>` 列出文件里没有被调用的函数与默认导入,可在改完代码后作参考。它只看单个文件,导出给别处用的也会报出,具名导入不查。

### 7.2 测试的三层

- 单元测试:只碰替身与假对象,只写临时目录,不联网。
- 真实软件的测试:接本机真实的 QGIS、真实的 Earth Engine 与装好的内置 Python 环境,测替身证明不了的。它们慢,GEE 的还用用户的额度,所以不和单元测试一起跑。
- 应用:开发版或打包版里的真实会话,在写入检测(第 8 节)的监视下。

### 7.3 运行

前两层都用仓库根目录的 `scripts/test.mjs` 按套件运行:

```bash
node scripts/test.mjs changed           # 工作区相对 HEAD 的改动要求的套件
node scripts/test.mjs geoengine qgis    # 指名的套件
node scripts/test.mjs all               # 全部套件
node scripts/test.mjs --list changed    # 只列出要跑的套件与原因,不运行
```

| 套件 | 内容 |
|---|---|
| `kernel` | 内核各包里 GeoCode 的测试:GeoCode 自己的测试文件整份运行,其余测试文件里只运行以 `GeoCode: ` 开头的用例 |
| `ui`、`web`、`electron` | 桌面端这三个包 `geocode/` 目录下的测试 |
| `geoengine` | GeoEngine 的单元测试(`geoengine/test/unit/`) |
| `qgis` | 在本机每一套 QGIS 上运行的测试 |
| `gee` | 在真实 Earth Engine 上运行的测试,设了 `GEOENGINE_GEE_PROJECT=<项目 ID>` 才跑 |
| `osm` | 在装好的内置 Python 环境上运行的 OSM 下载测试,服务是本机的假服务 |

套件依次运行,一个失败不影响后面的,最后列出每个套件的结果与用时;GeoEngine 的套件还列出跳过了几项,全部跳过的算没跑。有套件失败时退出码为 1;没有失败、但有套件没跑(如没设项目时的 `gee`、本机没有 QGIS 时的 `qgis`)时为 3;用法错误时为 2。`changed` 按改动的路径挑选套件,规则写在脚本里;加了新的能力域,在那里登记它有没有真实软件的测试、用不用内置环境。

改代码、反复试的时候,在包目录直接跑改到的那个测试文件,如在 `geoengine/` 里 `node --test <文件>`;`kernel/` 的包里用 `bun run test <文件>`,只跑其中 GeoCode 的用例时加 `-t "GeoCode:"`。

### 7.4 各部分的测试

各部分的测试都不能写真实的主目录:

- `kernel/`:在包目录以 `bun run test <文件>` 运行。`packages/core` 的这条命令把主目录、`XDG_*` 与 `TMPDIR` 换成临时目录,其他包(如 `packages/server`)的不换,所以 `scripts/test.mjs` 给每次运行一个临时主目录;在包里单独跑时自己换(见下)。不要在包里直接执行 `bun test`,它用真实的主目录。
- `desktop/`:包的 `bun run test` 会连包里其余的测试一起跑,所以只跑 `geocode/` 目录。其余的测试不保证只写临时目录,要跑它们时换一个临时主目录:`env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME -u XDG_STATE_HOME HOME=<临时目录> bun run test -- <路径>`。`XDG_*` 要去掉而不是设成空值,否则 Bun 会把转译缓存写到当前目录下。
- `geoengine/`:单元测试在 `test/unit/`,按能力域分目录(`qgis`、`gee`、`osm`、`python`,引擎本身的直接放在 `test/unit/` 下);真实软件的测试在 `test/real/`,每个能力域一个文件;共用的夹具在 `test/support/`。包的 `bun run test` 只跑单元测试,`bun run test:qgis`、`test:gee` 与 `test:osm` 各跑一种真实软件的测试。测试在系统临时目录下建以 `geoengine-` 开头的目录,结束时删掉;有的测试启动外部进程并验证它们被结束,所以按顺序逐个运行。

GeoEngine 的测试涉及四种外部软件:

- QGIS:单元测试用假的应用包,其中的解释器是一段 shell 脚本,只在 macOS 上跑。真实软件的测试默认用 `/Applications` 下每一个认得出的 `QGIS*.app`,也可以用 `GEOENGINE_QGIS_APPS` 列出应用包的路径(以冒号分隔);本机没有 QGIS 时记为跳过。Windows 上认路径与发现安装的逻辑在任何平台上都测,用照 OSGeo4W 的组件包搭出的假目录树;经启动脚本运行 QGIS 只能在 Windows 上验证。
- 内置的 Python 环境:单元测试自己打一个很小的包,配一个替身 pixi-unpack,包里的 `python3` 转去运行 `PATH` 里的 `python3`;没有 `python3` 时与在 Windows 上这些项跳过。真实的环境要在应用里验证。
- GEE:单元测试不联网,环境检查、运行、登录与查额度的脚本用 `PATH` 里的 `python3` 以隔离模式真实执行,earthengine-api 与它用到的 Google 库换成测试自带的替身,`geocodekit` 用 `geoengine/python/` 里的源码。存资产的 `gee.save` 不在其中,改动它时另在真实 Earth Engine 上试一次。真实软件的测试用这台电脑上登录的账号与它的额度,只读 Earth Engine 自己的凭据,只查询、下载到临时目录,不存资产;解释器是数据目录里装好的内置环境,或 `GEOENGINE_GEE_DATA` 所指的数据目录里的,它的启动文件与 `geocodekit` 要是当前代码写的(改了之后启动一次开发版),否则这几项失败并说明。
- OSM:都不联网,Overpass、Nominatim、Photon 与 Wikidata 换成测试在本机回环地址上开的一个假服务。检索与查看在单元测试里用 `PATH` 里的 `python3` 运行;下载要 shapely 与 GDAL,由 `osm` 套件在数据目录里装好的内置环境上运行(或 `GEOENGINE_OSM_DATA` 所指的),用源码里的 `geocodekit`;没有装好的环境时这几项跳过。对真实公共服务的检查不做成自动测试,它会给社区的服务器添负担,结果又随服务的忙闲而变;改了请求公共服务的方式之后,另对真实服务手动试一次。

## 8. 写入检测

安装依赖、启动应用这类可能写盘的操作,前后各运行一次:

```bash
./scripts/foreign-writes.sh before
# 安装、构建、启动应用并操作
./scripts/foreign-writes.sh after
```

它检查 OpenCode、OpenChamber(包括它在 `~/Library` 下的窗口数据与日志)的目录、Claude 的技能、`CLAUDE.md` 与凭据,以及通用的 `~/.agents` 目录有没有被写入,文件的新增、修改、删除与权限变化都算。无论在沙箱里还是在真实主目录下启动,结果都应当是干净的。退出码:0 干净;1 发现写入;3 需要人确认,表示变动全在 OpenChamber 与 OpenCode 自己的目录里,而本机的 OpenChamber 在这段时间里运行过,多半是它自己写的,关掉它重跑才能得出结论。
