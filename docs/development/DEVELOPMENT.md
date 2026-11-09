# 开发环境与运行

怎样安装依赖、构建、在沙箱里启动应用、打包与运行检查,以及开发中常见的坑。要守的规则见 `CONVENTIONS.md`;测试与写入检测见 `TESTING.md`。

## 1. 仓库结构

```
docs/        设计说明;docs/development/ 下是开发文档
scripts/     构建与暂存、测试的运行器、打包版的检查、写入检测、检查用的小工具、维护上游用的工具
kernel/      内核,基于 OpenCode
desktop/     桌面应用,基于 OpenChamber
geoengine/   地理引擎 GeoEngine,以及 Python 包 geocodekit(geoengine/python/)
```

`scripts/` 里:

| 文件 | 做什么 |
|---|---|
| `stage-kernel.sh`、`stage-geoengine.sh`、`stage-python.sh` | 构建并暂存内核、GeoEngine 与内置的 Python 环境(第 4 节) |
| `test.mjs` | 测试的唯一入口(`TESTING.md`) |
| `app/` | 打包版的检查(`TESTING.md` 第 7 节) |
| `foreign-writes.sh` | 写入检测(`TESTING.md` 第 8 节) |
| `own-anti-slop.mjs`、`dead-code.mjs` | 检查用的小工具(第 7 节) |
| `vendor.sh`、`patch-surface.sh`、`kernel-manifest.txt`、`chamber-manifest.txt` | 导入上游的源码、量对上游的改动,由维护者使用 |

`kernel/`、`desktop/` 与 `geoengine/` 各自独立安装依赖。

## 2. 工具链

- bun:版本以 `kernel/package.json`、`desktop/package.json` 与 `geoengine/package.json` 的 `packageManager` 为准,三者应当一致。版本过低或主版本不同时,内核的构建脚本拒绝运行。
- Node:`geoengine/` 的测试由 Node 直接运行 TypeScript,至少要 22.18;`desktop/package.json` 的 `engines` 另声明了它要求的版本(来自上游,安装与运行时不强制)。

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

它只构建本机平台的内核,产物放到 `desktop/packages/electron/resources/opencode-cli/geocode-kernel`(Windows 上为 `geocode-kernel.exe`,名字见 `DESKTOP.md` 第 2.5 节)。脚本把 `kernel/package.json` 的 `version` 注入内核并核对它报出的版本;不经这个脚本构建的内核带的是预览版本号,过不了启动内核前的版本检查。改动 `kernel/` 之后要重新运行它,应用才会用上新的内核。

GeoEngine 由 `./scripts/stage-geoengine.sh` 构建并暂存到 `desktop/packages/electron/resources/geoengine/geoengine.mjs`,打包时收进 `app.asar`。Python 包 `geocodekit`(`geoengine/python/`)在这一步原样编进 `geoengine.mjs`,由 GeoEngine 装进内置环境(`GEOCODEKIT.md` 第 2.5 节),所以改了其中的文件同样要重新构建。开发模式的启动脚本与打包流程都会运行它,平时不用手动执行;`geoengine/` 没装依赖时它报错退出。

OSM 工具读的预设库 `geocodekit/osm/_data.json` 由 `geoengine/` 里的 `bun ./script/osm-data.ts` 按脚本里锁定的版本下载、裁剪后写出;改了版本之后运行它,与写出的文件一起提交。

内置的 Python 环境(`PYTHON.md`)由 `./scripts/stage-python.sh` 按 `geoengine/environment/` 里的定义打包,与这个平台的 pixi-unpack 一起暂存到 `desktop/packages/electron/resources/python/`,打包时作为额外资源收进应用。环境的标识没变时它直接跳过,开发模式的启动脚本每次启动前都运行它;给出 `win32-x64` 或 `darwin-arm64` 能为另一个平台准备。改了 `geoengine/environment/pixi.toml` 之后,运行 `./scripts/stage-python.sh --lock` 重新生成两个平台的锁定清单 `pixi.lock`,与它一起提交:打包只照锁定清单,两者对不上时暂存直接报错。

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

壳与内核都从 `HOME` 推导自己的数据、配置与缓存目录,不看 `XDG_*`。Electron 自己的配置目录在 macOS 上按系统账户找主目录,不看 `HOME`,所以要用 `OPENCHAMBER_DESKTOP_USER_DATA_DIR` 单独指定。系统的偏好设置同样按系统账户存放,沙箱挡不住,开发时写进 Electron 通用的 `~/Library/Preferences/com.github.Electron.plist`。Electron 的日志写在 `$SANDBOX/Library/Logs/` 下。

`electron:dev:bundled` 先构建界面,再用构建好的界面启动,使用第 4 节暂存的内核;没有暂存时启动日志提示「bundled OpenCode CLI missing」,内核起不来:提示里说退回 `PATH`,但壳只认随包的内核。`electron:dev` 用热更新的界面,适合改界面时快速查看,但它另起的壳服务端不在 Electron 里,本机访问控制(`DESKTOP.md` 第 2.3 节)在那里不生效,也接不到 GeoEngine,地理环境与地理工具都不可用;验证这些要用 `electron:dev:bundled` 或打包出的应用。窗口的加载动画等内置的 Python 环境就绪(`PYTHON.md` 第 2.6 节),新沙箱第一次启动要多等一会;`electron:dev` 没有 GeoEngine,不等。

沙箱里没有登录信息,要对话就在沙箱里连接一个模型服务,或在沙箱的全局配置里配一个本机的 OpenAI 兼容接口。opencode.ai 的免费模型不对 GeoCode 开放。测完删掉沙箱目录即可。

## 6. 打包(macOS)

```bash
cd desktop/packages/electron
CSC_IDENTITY_AUTO_DISCOVERY=false bun run package -- --dir -c.mac.identity=- -c.mac.notarize=false
```

`package` 依次构建界面,暂存内核、ripgrep、GeoEngine 与内置的 Python 环境(第 4 节),打包主进程,重建原生模块,再调用 electron-builder;步骤以 `desktop/packages/electron/package.json` 的 `package` 脚本为准。`--dir` 只生成应用目录 `dist/mac-arm64/GeoCode.app`,不生成 dmg 与 zip;`-c.mac.identity=-` 用临时签名(ad-hoc),不需要开发者证书;`-c.mac.notarize=false` 不公证。包里的 `verify:opencode-cli` 找的是别的文件名与版本,对 GeoCode 的内核必然失败,不要单独运行它。

macOS 的应用图标不在打包时生成。`resources/icons/AppIcon.icon` 是它的源(Icon Composer 的文档,图层在其中的 `Assets/` 里),编译出的 `resources/icons/Assets.car` 提交在仓库里,打包只把它拷进应用,缺了它打包会失败。改了图层或 `icon.json` 之后,在 `desktop/packages/electron` 运行 `bun run generate:macos-icon` 重新生成(需要 Xcode),与源一起提交。

在沙箱里运行打包出的应用,直接执行 `.app/Contents/MacOS/` 下的可执行文件,带上第 5 节的 `HOME`,Electron 的配置目录改用参数 `--user-data-dir=<沙箱里的目录>` 指定:打包出的应用不接受 `OPENCHAMBER_` 开头的环境变量(`ENVIRONMENT.md` 第 2.1 节)。这个参数来自 Chromium,Electron 的文档没有列出。再加上 `--remote-debugging-port=<端口>`,就能以 DevTools 协议从外部检查各个窗口。

## 7. 检查

| 部分 | 命令 |
|---|---|
| `kernel/` | 在包目录 `bun run typecheck`,整棵树在 `kernel/` 执行 `bun turbo typecheck`;格式化用 `kernel/node_modules/.bin/prettier`(不用 `bunx prettier`,它会拉取别的版本) |
| `desktop/` | 在 `desktop/` 执行 `bun run type-check` 与 `bun run lint`,再在仓库根目录执行 `node scripts/own-anti-slop.mjs`。壳服务端与主进程的 JS 不在类型检查与 lint 的范围里,只由 anti-slop 与测试把关 |
| `geoengine/` | 在 `geoengine/` 执行 `bun run typecheck`;格式化用它自己目录下的 prettier |

`own-anti-slop.mjs` 只查 `desktop/` 里 GeoCode 自己的文件,即原味分支 `chamber-upstream` 上没有的文件,还没加入 git 的也算;它要 `desktop/` 装好依赖、本地有 `chamber-upstream` 分支,缺了就拒绝运行(退出码 2)。`kernel/` 与 `geoengine/` 没有对应的检查。确实要保留的违规写进脚本的例外清单,注明原因与处数。

`node scripts/dead-code.mjs <文件…>` 列出文件里没有被调用的函数与默认导入,可在改完代码后作参考。它只看单个文件,导出给别处用的也会报出,具名导入不查。

## 8. 常见的坑

### 写代码

- 改一行里的一段时,行尾注释可能把后面的表达式一起注释掉;改完先跑 `node --check` 或类型检查。
- 界面构建开着 React Compiler,它会缓存渲染时读的模块变量;随交互变化的值放进 state 或 store,改了交互的界面打包前自己先点一遍。
- 并列的 JSX 元素各自要有不同的 key:两个并列的条带用了同一个 key 时,React 留下旧的副本,界面显示早已结束的命令。单元测试与类型检查都看不出来,要在打包版上数一次 DOM 才抓得到。

### 运行时

- 判断谁最先执行时把运行时算进去:Electron 与 Chromium 在任何 JS 之前就读了几个 `ELECTRON_` 变量;开发启动时设了 `OPENCODE_BINARY` 会绕过随包的内核。

### Windows

代码按两个平台都会运行来写(`CONVENTIONS.md` 第 1 节),而开发中的检查都在 macOS 上跑,下面这些写错了不会报。平台分支怎样测见 `TESTING.md` 第 9 节。

- 路径:拼接与解析用 `path`,不手写 `/`;判断一个路径在不在另一个之下,`path.resolve` 之后用 `path.relative`,不比较字符串前缀。Windows 的路径不分大小写,盘符的大小写也不固定。文件网址与路径互转用 `fileURLToPath`、`pathToFileURL`,`new URL(...).pathname` 在 Windows 上得到 `/C:/…`。
- 路径长度:超过 260 个字符的路径有的程序打不开,`snapshot`、`worktree` 与 `npm` 下容易超;套接字的路径也有约 100 字节的上限。
- 启动程序:`.bat` 与 `.cmd` 不经 shell 就启动不了(Node 拒绝),经 `cmd.exe` 时命令行里的 `"`、`%`、`^` 与空格会被改写,所以脚本与请求经标准输入交给子进程(`docs/geoengine/QGIS.md` 第 2.1 节)。cross-spawn 经 `cmd.exe` 启动时,程序不存在不一定报 `ENOENT`。
- 结束程序:没有 POSIX 信号,`kill()` 直接终止,不带走子进程;结束整棵进程树用 `taskkill /T`。崩溃表现为很大的退出码(如 3221225477),`signal` 是空的,判断崩溃不能只看信号。
- 文件:打开着的文件删不掉也改不了名(`EBUSY`、`EPERM`),杀毒软件与索引服务正扫着它时也一样;删除与改名要处理失败,目标被占着时改名覆盖它也会失败。可执行权限没有意义;建符号链接要管理员或开发者模式。
- 环境变量:名字不分大小写,系统给的可能是 `Path`。`process.env` 本身不分,复制成普通对象后就分了,再设 `PATH` 会多出一份,子进程取哪一份不确定(`geoengine/src/runtime.ts` 的 `overlay`)。主目录在 `USERPROFILE`,没有 `HOME`,用 `os.homedir()`。
- 文本与编码:外部程序的输出可能以 `\r\n` 换行,按行切分用 `/\r?\n/`。中文 Windows 的控制台与许多程序用系统代码页(简体是 GBK,繁体是 CP950),不是 UTF-8,读外部程序的输出要明确编码;内置环境的 Python 以 `-X utf8` 运行(`geoengine/src/bundled.ts`)。会被执行的 `.sh` 由 `.gitattributes` 固定为 LF 换行。
- 脚本:`.sh` 在 Windows 上要 Git Bash 才能运行,新的构建与开发脚本用 Node 写。
