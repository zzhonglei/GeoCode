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
└── envs/
    └── default/       GeoAgent 的工作环境:继承 base 的虚拟环境
```

两层分开,是为了让 GeoAgent 能自由装包,而预装的部分不会被它改坏。

- `base` 只由解压产生与替换,运行时不往里装包。它带着 `EXTERNALLY-MANAGED` 标记(PEP 668):pip 与 uv 拒绝往里装包,并按标记里写的说明指向 `envs/default`。Python 自己写的字节码缓存不算改动。
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

环境由 GeoEngine 的一个能力模块准备与管理,它也发布环境的状态:准备中(带进度)、就绪、失败(带诊断)。

环境的标识是它的定义的校验和(Python 的版本与平台、锁定清单与组装它的构建脚本),由构建脚本写在压缩包旁边:内容不变,重新打包也不变,用户装上只是重新打包的新版时不必重新解压。GeoEngine 启动时比较 `base.json` 与应用自带环境的标识:

- 一致:直接使用;`envs/default` 不在了就从 `base` 重建它。
- 不存在或不一致:在后台准备。用系统自带的 `tar` 解压到同一目录下的临时目录(macOS 与 Windows 10 起都自带),完成后写入标识,再改名为 `base` 并删掉旧的;然后重建 `envs/default`。中途应用退出,临时目录在下次启动时清掉重来,不会用到解压了一半的环境。
- 两个 GeoCode 同时启动(如开发版与打包版)时不另加锁:各自解压到自己的临时目录,改名时 `base` 已经存在就失败,后到的丢掉自己的临时目录,改用已有的那个。

准备不阻塞 GeoEngine 的启动(`GEOENGINE.md` 第 5 节)。解压完成、工作环境建好就是就绪;之后在后台把预装的重包导入一遍(预热)。macOS 第一次加载一个新的动态库时会检查它,检查结果按文件记住,GDAL 这样几十 MB 的库要十几秒;不预热,这几十秒就落在用户第一次运行 `geerun` 或 GeoAgent 的第一个脚本上。预热不影响就绪:此时运行的脚本只是慢一些。

准备期间调用的地理工具,等环境就绪再执行,与等环境检查落定相同(`GEOENGINE.md` 第 3.3 节)。

### 6.1 重装与更新

GeoCode 没有自动更新,用户卸载旧版、安装新版。卸载只删应用本身,数据目录与其中的环境留着:

- 新版自带的环境标识不变:直接沿用,第一次启动不用等。
- 标识变了(锁定清单变了):替换 `base`,重建 `envs/default`。GeoAgent 额外装的包随之清空,需要时它再装;它们是对旧的 `base` 装的,留着可能与新的预装包不兼容。

完全卸载时要删的位置里有这个环境(`PATHS.md`)。

## 7. 界面

设置的「地理环境」页增加「Python 环境」一行,只显示状态:第一次准备时的进度,就绪后的 Python 版本与工作环境的路径,失败时的诊断。

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
- 第一次启动显示准备的进度;准备期间调用的地理工具等环境就绪再执行;预热之后,第一次运行没有明显的等待。
- 准备中途退出应用,下次启动重新准备,不用半个环境。
- 重装同一版本不重新解压;装上环境标识不同的新版,环境被替换、工作环境被重建。
- 往 `base` 装包被拒绝;往工作环境装的包在 GeoAgent 的脚本与 `geerun` 里都可用;删掉工作环境再启动,它回到只有预装包的状态。
- 用户的 `PATH` 里有 QGIS、OSGeo4W 或 conda 的 GDAL 时,环境照常工作。
- macOS 与 Windows 上都通过第 9 节的检查;准备环境不写 GeoCode 目录以外的地方。

## 11. 待验证

- Windows 实机:环境能运行并通过第 9 节的检查;VC++ 运行库是否齐全,不依赖用户电脑上装过什么;`PATH` 里有别的 GDAL(QGIS、OSGeo4W)时加载的是自带的那一份;数据目录下的深层路径是否超过 260 个字符;Windows Defender 第一次扫描这些动态库要多久,预热是否够用;卸载程序是否留下数据目录。
- macOS 14 与 15 上第一次加载动态库的耗时。
- 用户环境里的 `GDAL_DRIVER_PATH`(激活带 GDAL 的 conda 环境时设置)指向同一小版本的 GDAL 插件时,会不会被自带的 GDAL 加载而出错。`PROJ_DATA`、`GDAL_DATA` 不影响这套环境。
- 正式签名与公证时,应用里的环境压缩包与解压出来的动态库是否需要单独签名(`DESIGN.md` 第 4 节)。

## 12. 待定

- 压缩格式:先用 gzip;xz 小三成左右,解压慢一倍,要等确认 Windows 自带的 `tar` 能解它再考虑。
- cartopy、scikit-learn、osmnx 要不要预装:osmnx 随 OpenStreetMap 能力域一起定。
