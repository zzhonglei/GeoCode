# 开发环境与运行

本文档说明怎么安装依赖、构建内核、在沙箱里启动应用。

## 1. 仓库结构

```
docs/        设计与规范
scripts/     上游导入(vendor.sh 与圈选清单)、写入检测、补丁面统计、死代码检查
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
cd kernel/packages/cli
OPENCODE_VERSION=<版本> bun run script/build.ts --single --skip-web-ui --skip-install
```

- `<版本>` 取 `kernel/package.json` 的 `version`。壳启动内核前会检查它报出的版本号;不带正式版本号构建的内核报的是 `local`,过不了这道检查。
- `--single`:只构建本机平台。
- `--skip-web-ui`:不打包 OpenCode 自带的网页界面。GeoCode 的界面来自 OpenChamber,那份网页界面不在本仓库里。
- `--skip-install`:跳过构建脚本自带的全平台依赖安装,只构建本机平台时用不到。

产物是 `kernel/packages/cli/dist/cli-<平台>/bin/opencode`,一个单文件可执行程序。

## 5. 在沙箱里启动应用

开发时在沙箱主目录里启动。开发机上往往装着 OpenCode 与 OpenChamber:壳会读写 `~/.config/openchamber`,内核会读写 `~/.config/opencode`、`~/.local/share/opencode` 等目录,直接启动就会改动它们的设置与数据。

```bash
SANDBOX=<一个空目录,放在仓库外>
KERNEL=<仓库>/kernel/packages/cli/dist/cli-<平台>/bin/opencode

cd desktop
HOME="$SANDBOX" \
OPENCODE_BINARY="$KERNEL" \
OPENCHAMBER_DESKTOP_USER_DATA_DIR="$SANDBOX/electron-user-data" \
bun run electron:dev:bundled
```

- `HOME`:壳与内核都从它推导自己的数据、配置、缓存目录。前提是环境里没有设 `XDG_*` 变量,设了的话内核会改用它们。
- `OPENCODE_BINARY`:壳要启动的内核。不设时壳会去 `PATH` 里找 `opencode`,可能找到本机另装的版本。启动日志里「bundled OpenCode CLI missing」的提示可以忽略,这个环境变量的优先级更高。
- `OPENCHAMBER_DESKTOP_USER_DATA_DIR`:Electron 自己的配置目录。macOS 上 Electron 按系统账户找主目录,不看 `HOME`,所以要单独指定。
- `electron:dev:bundled`:先构建界面,再用构建好的界面启动。

Electron 的日志仍会写到 `~/Library/Logs/OpenChamber/`,和本机安装的 OpenChamber 共用。

沙箱里没有登录信息,可以用 OpenCode 提供的免费模型,也可以在沙箱里登录。测完删掉沙箱目录即可。

## 6. 写入检测

安装依赖、启动应用这类可能写盘的操作,前后各运行一次:

```bash
./scripts/foreign-writes.sh before
# 安装、构建、启动应用并操作
./scripts/foreign-writes.sh after
```

它检查 OpenCode、OpenChamber 与 Claude 的目录有没有被写入。用沙箱启动时,结果应当是干净的。退出码:0 干净;1 发现写入;3 需要人确认,表示本机的 OpenChamber 在这段时间里运行过,它自己的写入被单独列出,要得到干净的结论就关掉它重跑。
