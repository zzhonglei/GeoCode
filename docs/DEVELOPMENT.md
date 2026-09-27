# 开发环境与运行

本文档说明怎么安装依赖、构建内核、在沙箱里启动应用、打包,以及怎样运行检查、测试与写入检测。

## 1. 仓库结构

```
docs/        设计与规范
scripts/     上游导入(vendor.sh 与圈选清单)、内核构建与暂存、写入检测、补丁面统计、死代码检查
kernel/      OpenCode 的源码(见 UPSTREAM.md)
desktop/     OpenChamber 的源码(见 UPSTREAM.md)
```

`kernel/` 与 `desktop/` 各自独立安装依赖。上游的项目介绍类文件(README、CHANGELOG 等)不在本仓库里,要看上游某个包的说明,到上游仓库对应的版本查看。

## 2. 工具链

- bun:版本以 `kernel/package.json` 与 `desktop/package.json` 的 `packageManager` 为准,两者应当一致。版本不对时,内核的构建脚本会拒绝运行。
- Node:22 或更新。
- gh:`scripts/vendor.sh` 用它下载上游源码。

## 3. 安装依赖

```bash
(cd kernel && bun install)
(cd desktop && bun install)
```

`desktop/` 的安装会下载 Electron,并构建 SDK 与内置扩展。

## 4. 构建内核

```bash
./scripts/stage-kernel.sh
```

它在 `kernel/packages/cli` 执行 `bun run script/build.ts --single --skip-web-ui --skip-install`:只构建本机平台,不打包 OpenCode 自带的网页界面(GeoCode 的界面来自 OpenChamber,那份网页界面不在本仓库里),也跳过只有全平台构建才需要的依赖安装。产物放到 `desktop/packages/electron/resources/opencode-cli/opencode`,脚本随后核对它报出的版本。版本取 `kernel/package.json` 的 `version`,以 `OPENCODE_VERSION` 注入;不注入时,内核报的是 `0.0.0-<分支>-…` 这样的预览版本号,过不了壳启动内核前的版本检查。

改动 `kernel/` 之后要重新运行它,应用才会用上新的内核。

## 5. 在沙箱里启动应用

开发时在沙箱主目录里启动。开发机上往往装着 OpenCode 与 OpenChamber:壳会读写 `~/.config/openchamber`,内核会读写 `~/.config/opencode`、`~/.local/share/opencode` 等目录,直接启动就会改动它们的设置与数据。

```bash
SANDBOX=<一个空目录,放在仓库外>

cd desktop
HOME="$SANDBOX" \
OPENCHAMBER_DESKTOP_USER_DATA_DIR="$SANDBOX/electron-user-data" \
bun run electron:dev:bundled
```

壳与内核都从 `HOME` 推导自己的数据、配置与缓存目录,前提是环境里没有设 `XDG_*` 变量,设了的话内核会改用它们。Electron 自己的配置目录在 macOS 上按系统账户找主目录,不看 `HOME`,所以要用 `OPENCHAMBER_DESKTOP_USER_DATA_DIR` 单独指定。Electron 的日志写在 `$SANDBOX/Library/Logs/` 下,跟着 `HOME` 走。

`electron:dev:bundled` 先构建界面,再用构建好的界面启动,壳使用第 4 节暂存的内核;没有暂存时,启动日志提示「bundled OpenCode CLI missing」,内核起不来。`electron:dev` 用热更新的界面,适合改界面时快速查看,但它另起的壳服务端不在 Electron 里,GeoCode 对壳服务端的改动与访问控制在那里不生效,验证这些要用 `electron:dev:bundled` 或打包出的应用(见 `DESKTOP.md` 第 6 节)。

沙箱里没有登录信息,可以用 OpenCode 提供的免费模型,也可以在沙箱里登录。测完删掉沙箱目录即可。

## 6. 打包(macOS)

```bash
cd desktop/packages/electron
CSC_IDENTITY_AUTO_DISCOVERY=false bun run package -- --dir -c.mac.identity=- -c.mac.notarize=false
```

`package` 依次构建界面、暂存内核(第 4 节)、打包主进程、重建原生模块,再调用 electron-builder。`--dir` 只生成应用目录 `dist/mac-arm64/<应用名>.app`,不生成 dmg 与 zip;`-c.mac.identity=-` 用临时签名(ad-hoc),不需要开发者证书;`-c.mac.notarize=false` 不公证。不要单独运行上游的 `verify:opencode-cli`:它按上游固定的 npm 版本核对暂存的内核,与 `kernel/` 的版本不符。

在沙箱里运行打包出的应用,直接执行 `.app/Contents/MacOS/` 下的可执行文件,带上第 5 节的 `HOME`,Electron 的配置目录改用参数 `--user-data-dir=<沙箱里的目录>` 指定:打包出的应用不接受 `OPENCHAMBER_` 开头的环境变量(见 `DESKTOP.md` 第 5 节)。这个参数来自 Chromium,Electron 的文档没有列出,升级 Electron 后要确认它仍然有效。再加上 `--remote-debugging-port=<端口>`,就能以 DevTools 协议从外部检查各个窗口,例如读取页面状态、记录网络请求,或取出窗口的令牌来测试壳服务端的接口。

## 7. 检查与测试

类型检查与 lint 的命令见 `CONVENTIONS.md` 第 2 节,测试写什么、怎么证明它会失败见第 4 节。`desktop/` 里 GeoCode 自己的测试放在各包的 `geocode/` 目录,壳服务端的那些在 `desktop/packages/web` 里以 `bun run test -- server/geocode/` 运行;`kernel/` 里的用例怎样命名、怎样单独运行,见 `CONVENTIONS.md` 第 4 节。

## 8. 写入检测

安装依赖、启动应用这类可能写盘的操作,前后各运行一次:

```bash
./scripts/foreign-writes.sh before
# 安装、构建、启动应用并操作
./scripts/foreign-writes.sh after
```

它检查 OpenCode、OpenChamber 与 Claude 的目录有没有被写入。用沙箱启动时,结果应当是干净的。退出码:0 干净;1 发现写入;3 需要人确认,表示本机的 OpenChamber 在这段时间里运行过,它自己的写入被单独列出,要得到干净的结论就关掉它重跑。
