# 开发环境与运行

本文档说明怎么安装依赖、构建内核、在沙箱里启动应用、打包。

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

它在 `kernel/packages/cli` 执行 `bun run script/build.ts --single --skip-web-ui --skip-install`,把产物放到 `desktop/packages/electron/resources/opencode-cli/opencode`,并核对这个内核报出的版本。

- 版本取 `kernel/package.json` 的 `version`,以 `OPENCODE_VERSION` 注入。壳启动内核前会检查它报出的版本号;不注入时,构建出的内核报的是 `0.0.0-<分支>-…` 这样的预览版本号,过不了这道检查。
- `--single`:只构建本机平台。
- `--skip-web-ui`:不打包 OpenCode 自带的网页界面。GeoCode 的界面来自 OpenChamber,那份网页界面不在本仓库里。
- `--skip-install`:跳过构建脚本自带的全平台依赖安装,只构建本机平台时用不到。

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

- `HOME`:壳与内核都从它推导自己的数据、配置、缓存目录。前提是环境里没有设 `XDG_*` 变量,设了的话内核会改用它们。
- `OPENCHAMBER_DESKTOP_USER_DATA_DIR`:Electron 自己的配置目录。macOS 上 Electron 按系统账户找主目录,不看 `HOME`,所以要单独指定。
- `electron:dev:bundled`:先构建界面,再用构建好的界面启动。壳使用第 4 节暂存的内核;没有暂存时,启动日志提示「bundled OpenCode CLI missing」,内核起不来(见 `DESKTOP.md`)。

Electron 的日志写在 `$SANDBOX/Library/Logs/` 下,也跟着 `HOME` 走。

沙箱里没有登录信息,可以用 OpenCode 提供的免费模型,也可以在沙箱里登录。测完删掉沙箱目录即可。

## 6. 打包(macOS)

```bash
cd desktop/packages/electron
CSC_IDENTITY_AUTO_DISCOVERY=false bun run package -- --dir -c.mac.identity=- -c.mac.notarize=false
```

- `package` 依次构建界面、暂存内核(第 4 节)、打包主进程、重建原生模块,再调用 electron-builder。
- `--dir`:只生成应用目录 `dist/mac-arm64/<应用名>.app`,不生成 dmg 与 zip。
- `-c.mac.identity=-`:临时签名(ad-hoc),不需要开发者证书;`-c.mac.notarize=false`:不公证。
- 在沙箱里运行打包出的应用,直接执行 `.app/Contents/MacOS/` 下的可执行文件,并带上第 5 节的 `HOME` 与 `OPENCHAMBER_DESKTOP_USER_DATA_DIR`。

## 7. 写入检测

安装依赖、启动应用这类可能写盘的操作,前后各运行一次:

```bash
./scripts/foreign-writes.sh before
# 安装、构建、启动应用并操作
./scripts/foreign-writes.sh after
```

它检查 OpenCode、OpenChamber 与 Claude 的目录有没有被写入。用沙箱启动时,结果应当是干净的。退出码:0 干净;1 发现写入;3 需要人确认,表示本机的 OpenChamber 在这段时间里运行过,它自己的写入被单独列出,要得到干净的结论就关掉它重跑。
