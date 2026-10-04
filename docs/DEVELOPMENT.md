# 开发环境与运行

本文档说明怎么安装依赖、构建内核、在沙箱里启动应用、打包,以及怎样运行检查、测试与写入检测。

## 1. 仓库结构

```
docs/        设计与规范
scripts/     上游导入(vendor.sh 与圈选清单)、内核构建与暂存、写入检测、补丁面统计、死代码检查、GeoCode 自有文件的 anti-slop 检查
kernel/      OpenCode 的源码(见 UPSTREAM.md)
desktop/     OpenChamber 的源码(见 UPSTREAM.md)
geoengine/   GeoEngine,GeoCode 自己的地理引擎(见 GEOENGINE.md)
```

`kernel/`、`desktop/` 与 `geoengine/` 各自独立安装依赖。上游的项目介绍类文件(README、CHANGELOG 等)不在本仓库里,要看上游某个包的说明,到上游仓库对应的版本查看。

## 2. 工具链

- bun:版本以 `kernel/package.json`、`desktop/package.json` 与 `geoengine/package.json` 的 `packageManager` 为准,三者应当一致。版本不对时,内核的构建脚本会拒绝运行。
- Node:22.18 或更新,`geoengine/` 的测试命令需要这个版本。
- gh:`scripts/vendor.sh` 用它下载上游源码。

## 3. 安装依赖

```bash
(cd kernel && bun install)
(cd desktop && bun install)
(cd geoengine && bun install)
```

`desktop/` 的安装会下载 Electron,并构建 SDK 与内置扩展。

## 4. 构建内核

```bash
./scripts/stage-kernel.sh
```

它在 `kernel/packages/cli` 执行 `bun run script/build.ts --single --skip-web-ui --skip-install`:只构建本机平台,不打包 OpenCode 自带的网页界面(GeoCode 的界面来自 OpenChamber,那份网页界面不在本仓库里),也跳过只有全平台构建才需要的依赖安装。产物放到 `desktop/packages/electron/resources/opencode-cli/geocode-kernel`(改成 GeoCode 自己的文件名,见 `DESKTOP.md` 第 6 节),脚本随后核对它报出的版本。版本取 `kernel/package.json` 的 `version`,以 `OPENCODE_VERSION` 注入;不注入时,内核报的是 `0.0.0-<分支>-…` 这样的预览版本号,过不了壳启动内核前的版本检查。

改动 `kernel/` 之后要重新运行它,应用才会用上新的内核。

## 5. 在沙箱里启动应用

开发时在沙箱主目录里启动。应用把配置、数据与缓存放在主目录下的 `geocode` 目录里(见 `PATHS.md`),在沙箱里启动,开发与测试留下的会话、登录与设置就不会混进真实主目录里的那一份,删掉沙箱即可从头再来。

```bash
SANDBOX=<一个空目录,放在仓库外>

cd desktop
HOME="$SANDBOX" \
OPENCHAMBER_DESKTOP_USER_DATA_DIR="$SANDBOX/electron-user-data" \
bun run electron:dev:bundled
```

壳与内核都从 `HOME` 推导自己的数据、配置与缓存目录,前提是环境里没有设 `XDG_*` 变量,设了的话内核会改用它们。Electron 自己的配置目录在 macOS 上按系统账户找主目录,不看 `HOME`,所以要用 `OPENCHAMBER_DESKTOP_USER_DATA_DIR` 单独指定。系统的偏好设置同样按系统账户存放,沙箱挡不住:开发时写进 Electron 通用的 `~/Library/Preferences/com.github.Electron.plist`,打包出的应用写进 `~/Library/Preferences/io.github.zzhonglei.geocode.plist`,里面只有文件对话框的位置这类系统记下的状态。Electron 的日志写在 `$SANDBOX/Library/Logs/` 下,跟着 `HOME` 走。

`electron:dev:bundled` 先构建界面,再用构建好的界面启动,壳使用第 4 节暂存的内核;没有暂存时,启动日志提示「bundled OpenCode CLI missing」,内核起不来。`electron:dev` 用热更新的界面,适合改界面时快速查看,但它另起的壳服务端不在 Electron 里,访问控制(`DESKTOP.md` 第 4 节)在那里不生效,验证访问控制要用 `electron:dev:bundled` 或打包出的应用。

沙箱里没有登录信息,可以用 OpenCode 提供的免费模型,也可以在沙箱里登录。测完删掉沙箱目录即可。

## 6. 打包(macOS)

```bash
cd desktop/packages/electron
CSC_IDENTITY_AUTO_DISCOVERY=false bun run package -- --dir -c.mac.identity=- -c.mac.notarize=false
```

`package` 依次构建界面、暂存内核(第 4 节)、打包主进程、重建原生模块,再调用 electron-builder。`--dir` 只生成应用目录 `dist/mac-arm64/GeoCode.app`,不生成 dmg 与 zip;`-c.mac.identity=-` 用临时签名(ad-hoc),不需要开发者证书;`-c.mac.notarize=false` 不公证。不要单独运行上游的 `verify:opencode-cli`:它按上游固定的 npm 版本核对暂存的内核,与 `kernel/` 的版本不符。

macOS 的应用图标不在打包时生成。`resources/icons/AppIcon.icon` 是它的源(Icon Composer 的文档,图层在其中的 `Assets/` 里),编译出的 `resources/icons/Assets.car` 提交在仓库里,打包只把它拷进应用,缺了它打包会失败。改了图层或 `icon.json` 之后,在 `desktop/packages/electron` 运行 `bun run generate:macos-icon` 重新生成(需要 Xcode),与源一起提交。浅色与深色两张图层沿用上游的文件名,灰度的一张是 GeoCode 加的。

在沙箱里运行打包出的应用,直接执行 `.app/Contents/MacOS/` 下的可执行文件,带上第 5 节的 `HOME`,Electron 的配置目录改用参数 `--user-data-dir=<沙箱里的目录>` 指定:打包出的应用不接受 `OPENCHAMBER_` 开头的环境变量(见 `DESKTOP.md` 第 5 节)。这个参数来自 Chromium,Electron 的文档没有列出,升级 Electron 后要确认它仍然有效。再加上 `--remote-debugging-port=<端口>`,就能以 DevTools 协议从外部检查各个窗口,例如读取页面状态、记录网络请求,或取出窗口的令牌来测试壳服务端的接口。

## 7. 检查与测试

类型检查与 lint 的命令见 `CONVENTIONS.md` 第 2 节,测试写什么、怎么证明它会失败见第 4 节。`desktop/` 里 GeoCode 自己的测试放在各包的 `geocode/` 目录,壳服务端的那些在 `desktop/packages/web` 里以 `bun run test -- server/geocode/` 运行。上游的测试不保证只写临时目录,`web` 包里就有测试会在主目录下建目录、写 npm 缓存,所以跑上游测试时换一个临时主目录:`env -u XDG_CONFIG_HOME -u XDG_DATA_HOME -u XDG_CACHE_HOME HOME=<临时目录> bun run test -- <路径>`。`XDG_*` 要去掉,不要设成空值,否则 Bun 会把转译缓存写到当前目录下。`geoengine/` 的测试在系统临时目录下建以 `geoengine-` 开头的临时目录,结束时删掉;有的测试会启动外部进程并验证它们被结束,所以按顺序逐个运行。`kernel/` 里的用例怎样命名、怎样单独运行,见 `CONVENTIONS.md` 第 4 节;它们写在上游的测试文件里、借用上游的夹具,同样换临时主目录运行,并把 `TMPDIR` 也指向临时目录:内核的测试会在系统临时目录下建 `geocode` 目录。

## 8. 写入检测

安装依赖、启动应用这类可能写盘的操作,前后各运行一次:

```bash
./scripts/foreign-writes.sh before
# 安装、构建、启动应用并操作
./scripts/foreign-writes.sh after
```

它检查 OpenCode、OpenChamber(包括它在 `~/Library` 下的窗口数据与日志)与 Claude 的目录有没有被写入,文件的新增、修改与权限变化都算。无论在沙箱里还是在真实主目录下启动,结果都应当是干净的。退出码:0 干净;1 发现写入;3 需要人确认,表示本机的 OpenChamber 在这段时间里运行过,它自己的写入被单独列出,要得到干净的结论就关掉它重跑。
