# Python 环境

GeoCode 内置一套 Python 环境:GeoAgent 处理数据、GEE 的脚本与以后的出图都在它上面运行。本文档说明为什么内置、环境由什么组成、怎样构建与分发、怎样在用户电脑上解压与更新,以及 GeoAgent 怎样使用它。框架(进程、状态、配置)在 `GEOENGINE.md`,GEE 自己的部分在 `GEE.md`。

## 1. 定位

地理用户多半不会自己搭 Python 环境:conda 的环境与频道、pip 与 conda 混装的冲突、Windows 上编译不出来的 GDAL,每一样都可能让人在第一步就放弃。而 GeoAgent 几乎每个任务都要用 Python 读写与处理地理数据,`geerun` 也离不开它。所以 GeoCode 自带一套装好常用地理包的环境,用户安装 GeoCode 之后不需要再装任何 Python 软件,也不需要联网准备环境。

这套环境属于 GeoCode:它放在 GeoCode 的数据目录里,只由 GeoCode 准备与替换。用户自己装的 Python、conda 与它们的配置,GeoCode 照旧不碰(`GEOENGINE.md` 第 1 节);QGIS 用它自带的 Python(`QGIS.md` 第 2 节),与这套环境无关。

支持的平台随 GeoCode:Apple 芯片的 Mac,最低 macOS 14;Windows x64。

## 2. 组成

### 2.1 解释器

解释器是 Python 3.13 的独立构建(python-build-standalone)。它是一个完整的目录,按相对位置找自己的标准库与动态库,解压到任何路径都能运行,不需要安装,也不读写系统的注册表或全局位置。

小版本固定为 3.13,只跟补丁版本(3.13.x)。补丁版本不改变包的安装位置与二进制接口,已装的包与 GeoAgent 建的环境都照常可用;换小版本会让所有带编译代码的包与虚拟环境失效,所以不换。3.13 的维护期到 2029 年 10 月左右,之后不再有安全更新,地理包也会逐渐不再为它发布新版本;那时换小版本按一次重大升级单独处理。

### 2.2 预装的包

| 类别 | 包 |
|---|---|
| GEE | earthengine-api、geedim、geopandas |
| 矢量 | shapely、pyproj、pyogrio |
| 栅格与多维数据 | rasterio、rioxarray、xarray、netCDF4 |
| 科学计算 | numpy、pandas、scipy |
| 出图 | matplotlib |
| 其他 | openpyxl、requests |

清单只收 GeoAgent 在地理任务里经常要用的包;用得少的由 GeoAgent 按需装进它的工作环境(第 3 节)。

全部包来自 PyPI,只用现成的安装包(wheel),不在任何一端从源码编译。两个平台共用一份锁定清单,每个包(含间接依赖)在两个平台上是同一个版本并带校验和:同一段脚本在两个平台上的行为才一致,出了问题也能复现。

不用 conda。PyPI 的安装包已覆盖全部清单,只用一套工具链,也不牵涉 Anaconda 的使用条款。代价是平台下限:pyproj、netCDF4 在 PyPI 上只为 macOS 14 以上发布 Python 3.13 的安装包,pyproj 又是 geopandas 的必需依赖,所以 GeoCode 的最低 macOS 版本是 14。所有 Apple 芯片的 Mac 都能升级到 macOS 14 以上。

### 2.3 GDAL

GDAL 与 PROJ 随 rasterio、pyogrio、pyproj 的安装包而来:这些项目在发布时把 GDAL、PROJ 与它们的依赖编译好,作为动态库放进自己的安装包,安装只是解压文件。Windows 上 GDAL 难装,难在从源码编译;这套环境不经过编译,用户的电脑上也不运行 pip。

rasterio 与 pyogrio 各带一份 GDAL,同一个进程里两份并存、各自工作。锁定清单要让两者带的 GDAL 版本相同。

环境里没有 GDAL 官方的 Python 接口(`from osgeo import gdal`):PyPI 上它只有源码。也没有 `gdalwarp`、`ogr2ogr` 这类 GDAL 命令行工具。同样的事在这套环境里用 rasterio(栅格)、geopandas 与 pyogrio(矢量)、pyproj(坐标系)做,GeoAgent 的规范要写明这一点(第 5 节)。GDAL 命令行工具由 GDAL 能力域决定怎样提供。

### 2.4 字体

环境不带字体,也不预先配置 matplotlib。出图要中文时,由 GeoAgent 自己选用系统里的中文字体:系统自带的字体随操作系统授权,只能调用,不能随 GeoCode 分发。macOS 的苹方放在 matplotlib 不查找的系统位置,用不了;黑体-简、冬青黑体、宋体-简等可以。

## 3. 结构

```
<数据目录>/python/
├── base/              基础环境:解释器、标准库与预装的包
├── base.json          base 的标识,解压完成后最后写入
├── .unpack-<随机名>/  解压中的临时目录,中途退出时留下,下次启动清掉
└── envs/
    └── default/       GeoAgent 的工作环境:继承 base 的虚拟环境
```

两层分开,是为了让 GeoAgent 能自由装包,而预装的部分不会被它改坏。

- `base` 只由解压产生与替换,运行时不往里装包。它带着 `EXTERNALLY-MANAGED` 标记(PEP 668):pip 与 uv 拒绝往里装包。Python 自己写的字节码缓存不算改动。
- `envs/default` 是以 `--system-site-packages` 建的虚拟环境:预装的包都能直接导入,GeoAgent 额外装的包只进这里。同名的包在这里装了别的版本,只在这个环境里生效。

GeoAgent 运行的 Python 与 `geerun` 用的都是 `envs/default` 的解释器,所以 GeoAgent 装的包在 GEE 脚本里同样可用。恢复不需要专门的入口:GeoEngine 启动时缺什么补什么(第 6 节)。`envs/default` 装坏了,删掉它,下次启动时从 `base` 重建,额外装的包随之清空;`base` 被删改坏了,删掉整个 `python/`,下次启动时重新解压。

只有一个工作环境,不按项目分开:它够用,也最简单。

## 4. 构建与分发

环境的定义放在仓库的 `geoengine/environment/` 里:Python 独立构建的发布版本与两个平台的压缩包校验和、uv 的版本、预装清单与两个平台的锁定清单。两份锁定清单由同一个脚本生成:先按 macOS 14 解析,再以它的版本为约束解析 Windows,版本因此一致,只多出 Windows 自己的依赖。打包时由构建脚本按平台组装:下载 Python 独立构建并核对校验和,用 uv 按锁定清单装进它(只用现成的安装包,并核对每个包的校验和),写入 `EXTERNALLY-MANAGED` 标记,再压成一个文件放进应用的资源目录(在 `app.asar` 之外)。它和暂存内核、GeoEngine 一样是打包流程的一步。

只装现成的安装包,组装不需要目标平台的编译器,所以 Windows 的环境也能在 macOS 上组装;它是否真能运行,仍要在 Windows 上验证(第 11 节)。

压缩包随安装包分发,不在用户电脑上下载:准备环境不需要联网,两岸的用户一样。安装包因此大约增大一两百 MB,解压后约 650 到 720 MB。

更新锁定清单(跟进 Python 的补丁版本,或某个包的安全修复)时,两个平台一起重新解析、组装,并跑一遍环境的检查(第 9 节);锁定清单一变,环境的标识就变,用户装上新版 GeoCode 后环境随之替换(第 6 节)。

随环境分发的 Python 与各个包的许可证声明,与两个上游的一起放在发布仓库里(`DESKTOP.md` 第 6 节)。其中有 LGPL 的库(如 shapely 带的 GEOS),以动态库的形式随包分发。

## 5. GeoAgent 怎样使用

GeoAgent 得到工作环境的 Python 的绝对路径,运行脚本、装包都用它。环境不放进 `PATH`:用户在终端里、GeoAgent 在 shell 里敲 `python`,仍是用户自己的那一个,不打乱用户已有的环境与习惯。路径怎样交给 GeoAgent(提示词或工具说明),随内核装配一起定。

GeoAgent 的规范:

- 先用预装的包;缺的包用工作环境的 `python -m pip install` 装进工作环境,照 `shell` 的权限询问。
- 不往用户自己的 Python 里装包,不全局安装,不另建环境。
- 不用 `osgeo`;栅格用 rasterio,矢量用 geopandas,坐标系用 pyproj。
- 工作环境装坏了,删掉 `envs/default` 并告诉用户重启 GeoCode。

pip 与 matplotlib 这类软件把缓存与配置写在它们自己的默认位置(用户的缓存目录、`~/.matplotlib`),照 `GEOENGINE.md` 第 5 节的原则不归 GeoCode 管。

## 6. 在用户电脑上的准备

环境由 GeoEngine 的一个能力模块准备与管理,它也发布环境的状态(能力域 `python`):检查中、准备中(解压或建立工作环境)、就绪(带 Python 版本与工作环境的解释器)、失败(带诊断:哪一步、原因与命令打印的内容)。失败不重试,下次启动再准备。主进程启动 GeoEngine 时告诉它两个位置:应用自带环境的目录与数据目录。

环境的标识是它的定义的校验和(Python 的版本与平台、锁定清单与组装它的构建脚本),由构建脚本写在压缩包旁边:内容不变,重新打包也不变,用户装上只是重新打包的新版时不必重新解压。GeoEngine 启动时比较 `base.json` 与应用自带环境的标识:

- 一致,且 `base` 的解释器在:直接使用;`envs/default` 不在了就从 `base` 重建它。
- 否则在后台准备。用系统自带的 `tar` 解压到 `python/` 下的临时目录(macOS 自带,Windows 从 Windows 10 1803 版起自带);解压完,旧的 `base` 移进临时目录,解出的环境改名为 `base`,删掉从旧环境建的 `envs/default`,最后写入标识,再连同旧环境删掉临时目录;然后重建 `envs/default`。解压失败也删掉临时目录,`base` 原样不动;解出的环境换不上去时,旧的 `base` 放回原处。中途应用退出时,标识还是旧的或解释器不在,下次启动清掉留下的临时目录重来,不会用到解压了一半的环境。
- 两个 GeoCode 同时启动(只在开发时出现)不另作处理:准备撞在一起时可能有一方失败,下次启动再准备。

准备不阻塞 GeoEngine 的启动(`GEOENGINE.md` 第 5 节),等它的是窗口(第 7 节)。解压完成、工作环境建好就是就绪;之后每次启动都在后台把预装的重包导入一遍(预热)。macOS 第一次加载一个新的动态库时会检查它,检查结果按文件记住,GDAL 这样几十 MB 的库要十几秒;不预热,这几十秒就落在用户第一次运行 `geerun` 或 GeoAgent 的第一个脚本上。预热不影响就绪:此时运行的脚本只是慢一些。matplotlib 不预热:导入它会在用户的主目录建它的配置目录。

准备期间调用的地理工具,等环境就绪再执行,与等环境检查落定相同(`GEOENGINE.md` 第 3.3 节)。

### 6.1 环境变量

GeoEngine 运行这套环境的 Python 时,以隔离模式(`-I`)启动它,环境变量只给网络的与主目录:代理的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`,证书的 `SSL_CERT_FILE`、`SSL_CERT_DIR`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE`,名字不分大小写;再加 `HOME`。用户环境里的其余变量一个也不给:conda 的 `PYTHONPATH`、`GDAL_DRIVER_PATH`、`PROJ_DATA`,`PATH` 里 QGIS、OSGeo4W 带的 GDAL,都会让它加载不属于自己的东西。

`HOME` 不让 Python 加载别处的东西(主目录下的个人 `site-packages` 由 `-I` 关掉),只指明主目录。不给它,Python 从系统账户查出真实的主目录,结果对用户相同,但开发时的沙箱(`DEVELOPMENT.md` 第 5 节)就挡不住它:matplotlib 会写真实主目录下的缓存,GEE 会读真实的凭据。

其余的它不需要:编码由 Python 自己定,临时目录退回系统的默认位置;在系统设置里配的代理不经环境变量,Python 自己去读。Windows 上 Node 启动子进程时,会从 GeoEngine 的环境里补上进程必需而缺少的系统变量(`SystemRoot`、`TEMP`、`USERPROFILE` 等),其中也有 `PATH`,所以给它一个只含系统目录的 `PATH`,挡住用户的那一个。

隔离模式下 Python 不读任何 `PYTHON` 开头的变量,要它做的设置都以参数给:输出用 UTF-8 是 `-X utf8`,不缓冲输出是 `-u`。

### 6.2 重装与更新

GeoCode 没有自动更新,用户卸载旧版、安装新版。卸载只删应用本身,数据目录与其中的环境留着:

- 新版自带的环境标识不变:直接沿用,第一次启动不用等。
- 标识变了(锁定清单变了):替换 `base`,重建 `envs/default`。GeoAgent 额外装的包随之清空,需要时它再装;它们是对旧的 `base` 装的,留着可能与新的预装包不兼容。

完全卸载时要删的位置里有这个环境(`PATHS.md`)。

## 7. 界面

界面不单独显示这套环境:没有指示灯,设置里也没有它的一行。主窗口打开时,GeoCode 的加载动画一直显示到环境就绪才收起,第一次启动因此多等几秒,之后不到一秒;预热不等。窗口打开后,用到 Python 的地方就不必再顾虑环境还没好。

准备失败时,窗口显示 GeoCode 的出错页(`DESKTOP.md` 第 6 节),写明 Python 环境没能准备好,附上失败在哪一步、原因与命令打印的内容,只能重启应用,重启会再准备一次。迷你聊天窗口同样显示这一页,但不等环境。诊断也记进应用日志 `main.log`(`PATHS.md` 第 1 节)。GeoEngine 本身起不来时,照旧显示 GeoEngine 的出错页,不等环境。

没有 GeoEngine 的壳服务端(开发时的 `electron:dev`,`DEVELOPMENT.md` 第 5 节)不等:状态接口告诉窗口这个服务端有没有 GeoEngine。

## 8. GEE

GEE 只用内置环境,不支持用户自己的 Python。环境由 GeoCode 保证,包的版本是锁定的:GEE 依赖的 earthengine-api 与 geedim 的接口(包括 `geocode` 包对 geedim 的代理补丁,`GEE.md` 第 7 节)只需要对一个确定的版本核对,运行出了问题也不必先分辨是不是用户的环境不对。

GEE 由此不再需要的部分:设置里选择与发现 Python、`machine.json` 的 `gee` 块里的 `python`(只剩 Cloud 项目)、缺包与版本过旧的状态,以及引导 GeoAgent 找 Python、装包、另建环境的提示。环境没有就绪只可能是还在准备或准备失败,GEE 的环境检查从「Python 能不能用」改为等内置环境就绪,其后的登录与项目检查不变。改动的细节在 GEE 迁移到内置环境时写进 `GEE.md`。

## 9. 约束

- `base` 只由解压改变;GeoAgent 与任何运行都不往里装包。
- 准备环境不联网。
- 环境只写在 GeoCode 的数据目录里。
- 两个平台用同一份锁定清单。
- 环境的检查覆盖:每个预装的包都能导入;同一个进程里经 pyogrio 读写 GeoPackage、经 rasterio 读写 GeoTIFF;一次真实的坐标变换(投影数据库缺失时它才失败,见 `QGIS.md` 第 3 节);解压到带空格与中文的路径后照样通过。

## 10. 验收

- 在没有任何 Python 与 conda 的电脑上,安装 GeoCode 后不联网也能准备好环境;GEE 登录、填好项目之后就能运行;GeoAgent 用预装的包读写矢量与栅格、出图。
- 第一次启动时加载动画显示到环境就绪,之后的启动不明显变慢;准备失败时显示出错页,重启后再准备;预热之后,第一次运行没有明显的等待。
- 准备中途退出应用,下次启动重新准备,不用半个环境。
- 重装同一版本不重新解压;装上环境标识不同的新版,环境被替换、工作环境被重建。
- 往 `base` 装包被拒绝;往工作环境装的包在 GeoAgent 的脚本与 `geerun` 里都可用;删掉工作环境再启动,它回到只有预装包的状态。
- 用户的 `PATH` 里有 QGIS、OSGeo4W 或 conda 的 GDAL 时,环境照常工作。
- macOS 与 Windows 上都通过第 9 节的检查;准备环境不写 GeoCode 目录以外的地方。

## 11. 待验证

- Windows 实机:环境能运行并通过第 9 节的检查;VC++ 运行库是否齐全,不依赖用户电脑上装过什么;`PATH` 里有别的 GDAL(QGIS、OSGeo4W)时加载的是自带的那一份;数据目录下的深层路径是否超过 260 个字符;Windows Defender 第一次扫描这些动态库要多久,预热是否够用;卸载程序是否留下数据目录。
- macOS 14 与 15 上第一次加载动态库的耗时。
- Windows 上只给网络变量与系统的 `PATH` 时,能否照常建立环境、导入各个包与访问 HTTPS。系统自带的 `tar` 能否解到含中文的路径(如中文用户名下的数据目录);它的报错用系统的代码页,诊断里的中文可能是乱码。解压时的路径比解压后长二十来个字符,260 个字符的上限按它量。
- 正式签名与公证时,应用里的环境压缩包与解压出来的动态库是否需要单独签名(`DESIGN.md` 第 4 节)。

## 12. 待定

- 压缩格式:先用 gzip;xz 小三成左右,解压慢一倍,要等确认 Windows 自带的 `tar` 能解它再考虑。
- cartopy、scikit-learn、osmnx 要不要预装:osmnx 随 OpenStreetMap 能力域一起定。
- GeoAgent 在 shell 里运行这个 Python 时,环境变量要不要同样只给网络的(第 6.1 节):那条路经过内核,随内核装配一起定。
- GEE 怎样等环境就绪,随 GEE 迁移一起定:能力模块之间本不互相依赖(`GEOENGINE.md` 第 3 节),而准备中可能比检查中久得多,等待的上限要另定。
