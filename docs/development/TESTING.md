# 测试

GeoCode 自己的测试怎样组织、怎样运行、结果怎样读,以及写入检测。测试要守的规则(测什么、放在哪、新测试先证明会失败)见 `CONVENTIONS.md` 第 4 节。

测试主要由 AI 助手编写与运行,改完代码靠它的结果判断工作是否完成,所以只有一个入口:仓库根目录的 `scripts/test.mjs`。它给每次运行一个临时的主目录,测试碰不到用户的文件,只拿到明确交给它的;结果从各测试工具的 JUnit 报告读出:跑了多少、跳过了什么、为什么跳过、失败在哪,都由它核对;测试工具的退出码只作兜底,报告里没有失败、工具却异常退出,也算失败。

## 1. 三层

- 单元测试:只碰替身与假对象,只写临时目录,不联网。
- 真实软件的测试:接本机真实的 QGIS、真实的 Earth Engine 与装好的内置 Python 环境,测替身证明不了的。它们慢,GEE 的还用用户的额度,所以和单元测试分开成套件。
- 应用:开发版或打包版里的真实会话,在写入检测(第 6 节)的监视下。

## 2. 运行

```bash
node scripts/test.mjs --file <测试文件>   # 改代码、反复试时:只跑这一个文件,像它的套件那样跑
node scripts/test.mjs changed            # 完工前:工作区的改动要求的套件
node scripts/test.mjs geoengine qgis     # 指名的套件
node scripts/test.mjs geoengine/osm      # GeoEngine 单元测试里一个能力域的
node scripts/test.mjs all                # 全部套件,升级上游之后
node scripts/test.mjs --list changed     # 只列出要跑什么与原因,不运行
```

`changed` 看的是工作区相对 `HEAD` 的改动,包括还没加入 git 的文件;已经提交的不算。它按改动的路径挑选套件,规则写在脚本的 `calledFor` 里:`geoengine/` 以外的改动跑内核与桌面的四个套件,GeoEngine 的改动只跑涉及的能力域的单元测试与真实软件测试,改了引擎本身或各能力域共用的部分(内置环境、启动解释器的方式)才跑得更多;`src/`、`test/` 以外的 Markdown 不挑套件,改了运行器自己就跑全部。

不在包目录里直接执行测试命令(`bun test`、`vitest`、`node --test` 或包的 `test` 脚本):它们不换主目录,有的会写真实的主目录,上游的测试也会一起跑,结果也没人核对。`--file` 给的就是单个文件的跑法。

## 3. 套件

| 套件 | 内容 | 前提 | 用时 |
|---|---|---|---|
| `kernel` | 内核各包里 GeoCode 的测试:GeoCode 自己的测试文件整份运行,上游测试文件里只运行名称含 `GeoCode:` 的用例 | 无 | 约半分钟 |
| `ui`、`web`、`electron` | 桌面端这三个包 `geocode/` 目录下的测试;界面的每个文件单独一个进程 | 无 | 几秒 |
| `geoengine` | GeoEngine 的单元测试(`geoengine/test/unit/`),逐个文件运行;`geoengine/<能力域>` 只跑 `engine`(引擎本身,直接放在 `test/unit/` 下的)、`python`、`qgis`、`gee` 或 `osm` 目录下的 | `PATH` 里的 `python3`,没有时相关的用例跳过 | 约两分半 |
| `qgis` | 在本机每一套 QGIS 上运行 | macOS 上的 QGIS | 约一分钟 |
| `gee` | 在真实 Earth Engine 上运行 | `GEOENGINE_GEE_PROJECT=<项目 ID>`、登录过 Earth Engine、装好的内置环境 | 几分钟 |
| `osm` | 在装好的内置环境上运行 OSM 下载,服务是本机的假服务 | 装好的内置环境 | 约半分钟 |
| `scripts` | `scripts/test.mjs` 自己的测试 | 无 | 一秒 |

GeoEngine 的单元测试慢在 OSM 与 GEE:它们验证暂停、重试、每秒一次请求这类与时间有关的行为,测试里真的等这些时间。产品代码里不为测试加缩短等待的开关;`changed` 只在改到它们的能力域或引擎本身时才挑它们。

内核与桌面的测试不按能力域分:四个套件加起来约半分钟,大半是内核两个真等的用例,细分省不下多少;内核的地理工具测试一个文件里同时测 QGIS、GEE 与 OSM,要分就得按用例名挑,再维护一张源码属于哪个能力域的对照表,它本身就会悄悄过期。

新的测试文件放在约定的位置(`CONVENTIONS.md` 第 4 节)就会被运行。测试目录里文件名像测试、却没有套件运行的文件,运行器报用法错误,而不是悄悄漏掉;加了新的能力域,在脚本里登记它的真实软件测试与 `changed` 的规则。

## 4. 隔离

每一次运行(一个测试工具的一次调用)有一个新建的临时主目录,运行结束就删掉:

- `HOME` 与 `TMPDIR` 指向它;Windows 上还有 `USERPROFILE`、`TMP`、`TEMP`、`APPDATA` 与 `LOCALAPPDATA`。
- 去掉会把测试指向用户自己的目录、账号与仓库或上游应用的变量(`XDG_CONFIG_HOME` 这类目录变量,以 `OPENCODE_`、`OPENCHAMBER_`、`GIT_` 开头的,`SSH_AUTH_SOCK` 等),应用自己也去掉的运行时开关(`BUN_`、`ELECTRON_`、`OTEL_`),以及密钥与令牌。

真实软件的测试另外拿到运行器在换主目录之前定下的东西:

- 内置环境:`GEOENGINE_DATA` 指向 GeoCode 的数据目录,默认是真实主目录下的那个,事先设了 `GEOENGINE_DATA` 就用它所指的。测试只读这个环境;它的启动文件与 `geocodekit` 不是当前代码写的时,GEE 的测试失败并说明(改了之后启动一次开发版),没有装好的环境时这些用例跳过。
- Earth Engine 的凭据:复制一份进临时主目录,随它删掉。
- QGIS:`/Applications` 下的应用包,或 `GEOENGINE_QGIS_APPS` 列出的。

隔离只管环境变量。测试写到绝对路径、或不看 `HOME` 直接问系统要主目录的,拦不住:真实的 QGIS 在 macOS 上照它的默认位置写自己的配置(`~/Library/Application Support/QGIS`),与在应用里一样,`PATHS.md` 不列这类文件。别的产品的目录由写入检测把关;整个主目录不做检测,同一段时间里别的应用与系统在那里写的文件太多,结果分辨不出来。

## 5. 结果

每个套件(或 `--file` 给的每个文件)报一行,状态是下面之一:

| 状态 | 含义 |
|---|---|
| `PASS` | 有用例通过,没有失败;另列跳过了几个与原因 |
| `FAIL` | 有用例失败,测试工具异常退出或超时,给的文件一个用例都没跑或留着 `.only`,或一个测试文件都没找到 |
| `NOT RUN` | 没有运行:缺前提(没设 GEE 项目、没有 QGIS、没装内置环境),或全部用例都跳过了,附原因 |

失败时列出每个失败用例的文件与行、名称和断言信息,测试工具异常时列出它输出的结尾,再给出重跑这个文件的命令与完整日志的位置;全部通过时不留日志。

退出码:有失败为 1;没有失败、但有没运行的为 3;参数错误为 2;否则为 0。`NOT RUN` 与跳过都不是通过:报告工作时把失败、跳过、没运行的套件与没验证的平台分开说。

## 6. 各部分的测试与外部软件

- `kernel/`:内核的 `packages/core` 有自己的测试脚本,它在运行器给的主目录里再换一层。上游测试文件里的 GeoCode 用例按名称挑选,文件里其余的用例不运行,但文件本身的准备代码照常执行。
- `desktop/`:只有各包 `geocode/` 目录下的测试属于 GeoCode;在上游测试文件里加的用例不会被运行。
- `geoengine/`:单元测试在 `test/unit/`,按能力域分目录(`qgis`、`gee`、`osm`、`python`,引擎本身的直接放在 `test/unit/` 下);真实软件的测试在 `test/real/`,每个能力域一个文件;共用的夹具在 `test/support/`。测试在临时目录下建以 `geoengine-` 开头的目录,结束时删掉;有的测试启动外部进程并验证它们被结束,所以按顺序逐个运行。

GeoEngine 的测试涉及四种外部软件:

- QGIS:单元测试用假的应用包,其中的解释器是一段 shell 脚本,只在 macOS 上跑。真实软件的测试用 `/Applications` 下每一个认得出的 `QGIS*.app`,或 `GEOENGINE_QGIS_APPS` 列出的应用包路径(以冒号分隔);本机没有 QGIS 时记为没运行。Windows 上认路径与发现安装的逻辑在任何平台上都测,用照 OSGeo4W 的组件包搭出的假目录树;经启动脚本运行 QGIS 只能在 Windows 上验证。
- 内置的 Python 环境:单元测试自己打一个很小的包,配一个替身 pixi-unpack,包里的 `python3` 转去运行 `PATH` 里的 `python3`;没有 `python3` 时与在 Windows 上这些用例跳过。真实的环境要在应用里验证。
- GEE:单元测试不联网,环境检查、运行、登录与查额度的脚本用 `PATH` 里的 `python3` 以隔离模式真实执行,earthengine-api 与它用到的 Google 库换成测试自带的替身,`geocodekit` 用 `geoengine/python/` 里的源码。存资产的 `gee.save` 不在其中,改动它时另在真实 Earth Engine 上试一次。真实软件的测试用这台电脑上登录的账号与它的额度,只查询、下载到临时目录,不存资产。
- OSM:都不联网,Overpass、Nominatim、Photon 与 Wikidata 换成测试在本机回环地址上开的一个假服务。检索与查看在单元测试里用 `PATH` 里的 `python3` 运行;下载要 shapely 与 GDAL,由 `osm` 套件在装好的内置环境上运行,用源码里的 `geocodekit`。对真实公共服务的检查不做成自动测试,它会给社区的服务器添负担,结果又随服务的忙闲而变;改了请求公共服务的方式之后,另对真实服务手动试一次。

## 7. 写入检测

安装依赖、启动应用这类可能写盘的操作,前后各运行一次:

```bash
./scripts/foreign-writes.sh before
# 安装、构建、启动应用并操作
./scripts/foreign-writes.sh after
```

它检查 OpenCode、OpenChamber(包括它在 `~/Library` 下的窗口数据与日志)的目录、Claude 的技能、`CLAUDE.md` 与凭据,以及通用的 `~/.agents` 目录有没有被写入,文件的新增、修改、删除与权限变化都算。无论在沙箱里还是在真实主目录下启动,结果都应当是干净的。退出码:0 干净;1 发现写入;3 需要人确认,表示变动全在 OpenChamber 与 OpenCode 自己的目录里,而本机的 OpenChamber 在这段时间里运行过,多半是它自己写的,关掉它重跑才能得出结论。
