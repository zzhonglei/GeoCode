# Python 环境

GeoCode 内置一套 Python 环境:GeoAgent 处理数据、GEE 的脚本与以后的出图都在它上面运行。本文档说明为什么内置、环境由什么组成、怎样构建与分发、怎样在用户电脑上安装与更新,以及 GeoAgent 怎样使用它。框架(进程、状态、配置)在 `GEOENGINE.md`,GEE 自己的部分在 `GEE.md`。

## 1. 定位

地理用户多半不会自己搭 Python 环境:conda 的环境与频道、pip 与 conda 混装的冲突、Windows 上编译不出来的 GDAL,每一样都可能让人在第一步就放弃。而 GeoAgent 几乎每个任务都要用 Python 读写与处理地理数据,`geerun` 也离不开它。所以 GeoCode 自带一套装好常用地理包的环境,用户安装 GeoCode 之后不需要再装任何 Python 软件,也不需要联网准备环境。

这套环境属于 GeoCode:它放在 GeoCode 的数据目录里,只由 GeoCode 准备与替换。用户自己装的 Python、conda 与它们的配置,GeoCode 照旧不碰(`GEOENGINE.md` 第 1 节);QGIS 用它自带的 Python(`QGIS.md` 第 2 节),与这套环境无关。

反过来,用户电脑上的 Python、conda、GDAL 与它们的配置也不能影响这套环境:地理用户的电脑上常有好几套 GDAL(conda 的、QGIS 的、OSGeo4W 的),它们的环境变量与配置文件一旦被这套环境读到,就会加载不属于它的插件与数据。怎样隔开见第 6.1 节。

支持的平台随 GeoCode:Apple 芯片的 Mac,最低 macOS 13;Windows x64。

## 2. 组成

环境的全部包,包括 Python 本身,来自 conda-forge。conda-forge 是社区维护的软件源,地理 Python 生态的标准来源:GDAL 在这里是完整的一套,PyPI 上没有现成的安装包。只用这一个频道,不用 Anaconda 公司的 defaults 频道:conda-forge 的包不在 Anaconda 的收费条款之内,defaults 频道与镜像它的仓库则要商业授权。用户的电脑上不装 conda,也看不到它(第 4、6 节)。

### 2.1 解释器

解释器是 conda-forge 的 Python 3.13。

小版本固定为 3.13,只跟补丁版本(3.13.x)。补丁版本不改变包的安装位置与二进制接口,已装的包与 GeoAgent 建的环境都照常可用;换小版本会让所有带编译代码的包与虚拟环境失效,所以不换。3.13 的维护期到 2029 年 10 月左右,之后不再有安全更新,地理包也会逐渐不再为它发布新版本;那时换小版本按一次重大升级单独处理。

### 2.2 预装的包

| 类别 | 包 |
|---|---|
| GDAL | GDAL 本身、它的 Python 接口与命令行工具,以及 NetCDF、HDF4、HDF5、Parquet、JPEG2000 的驱动插件 |
| GEE | earthengine-api、geedim、geopandas |
| 矢量 | shapely、pyproj、pyogrio |
| 栅格与多维数据 | rasterio、rioxarray、xarray、netCDF4 |
| 科学计算 | numpy、pandas、scipy |
| 出图 | matplotlib |
| 其他 | openpyxl、requests |

清单只收 GeoAgent 在地理任务里经常要用的包;用得少的由 GeoAgent 按需装进它的工作环境(第 3 节)。

geopandas 用只含核心的 `geopandas-base`:完整的 `geopandas` 连带装上 scikit-learn、folium 等可选依赖。numpy 与 scipy 用 OpenBLAS:Windows 上默认的 Intel MKL 一个就有一百多 MB。不装 PDF 驱动:它带来 GPL 的 poppler,而读写地理 PDF 的任务很少。

两个平台共用一份锁定清单,每个包(含间接依赖)在两个平台上是同一个版本并带校验和:同一段脚本在两个平台上的行为才一致,出了问题也能复现。

环境里的二进制文件要求最低 macOS 12(Google 接口库带来的 gRPC 与 protobuf;GDAL 与 Python 要求 11),低于 GeoCode 本身的下限 13(`DESIGN.md` 第 1 节)。

### 2.3 GDAL

环境里只有一份 GDAL,rasterio、pyogrio 与 GDAL 官方的 Python 接口(`from osgeo import gdal`)都用它。命令行工具(`gdalwarp`、`ogr2ogr`、`gdalinfo` 等)在环境里,不在 `PATH` 上(第 5 节)。Windows 上 GDAL 难装,难在从源码编译;这套环境用 conda-forge 编译好的包,用户的电脑上不编译任何东西。

GDAL 找驱动插件与数据、PROJ 找投影数据库,有的靠安装时写进文件的位置(第 3 节),有的靠 conda「激活」环境时设的环境变量:Windows 上全靠后者;工作环境里的 pyproj 按工作环境的位置去找,也找不到 `base` 里的数据。GeoCode 不激活环境,这些变量由环境在 Python 启动时自己设好(第 6.1 节)。GDAL 能力域可以直接用这套环境里的 GDAL。

### 2.4 字体

环境不带字体,也不预先配置 matplotlib。出图要中文时,由 GeoAgent 自己选用系统里的中文字体:系统自带的字体随操作系统授权,只能调用,不能随 GeoCode 分发。macOS 的苹方放在 matplotlib 不查找的系统位置,用不了;黑体-简、冬青黑体、宋体-简等可以。

## 3. 结构

```
<数据目录>/python/
├── base/              基础环境:装好的 conda 环境,解释器、预装的包与 GDAL
├── base.json          base 的标识,安装完成后最后写入
├── .unpack-<随机名>/  安装时 pixi-unpack 的缓存,中途退出时留下,下次启动清掉
├── proj/              PROJ 下载的网格的缓存,用到需要网格的转换时才出现(第 6.1 节)
└── envs/
    └── default/       GeoAgent 的工作环境:继承 base 的虚拟环境
```

两层分开,是为了让 GeoAgent 能自由装包,而预装的部分不会被它改坏。

- `base` 只由安装产生与替换,运行时不往里装包。它带着 `EXTERNALLY-MANAGED` 标记(PEP 668):pip 与 uv 拒绝往里装包。Python 自己写的字节码缓存不算改动。
- `envs/default` 是以 `--system-site-packages` 建的虚拟环境:预装的包都能直接导入,GeoAgent 额外装的包只进这里。同名的包在这里装了别的版本,只在这个环境里生效。

GeoAgent 运行的 Python 是 `envs/default` 的解释器;`geerun` 用的是 `base` 的(第 8 节),GeoAgent 装的包不进 GEE 的脚本。恢复不需要专门的入口:GeoEngine 启动时缺什么补什么(第 6 节)。`envs/default` 装坏了,删掉它,下次启动时从 `base` 重建,额外装的包随之清空;`base` 被删改坏了,删掉整个 `python/`,下次启动时重新安装。

`base` 不能挪动:conda 的包在安装时把所在的位置写进一些文件,包括二进制文件,GDAL 靠它找驱动插件与数据,curl 与 OpenSSL 靠它找证书。所以 `base` 在用户的电脑上就地安装(第 6 节),不在打包时装好再搬过来。

只有一个工作环境,不按项目分开:它够用,也最简单。

## 4. 构建与分发

环境的定义放在仓库的 `geoengine/environment/` 里:pixi 的项目文件 `pixi.toml`(频道、预装清单)与锁定清单 `pixi.lock`(两个平台各自的全部包,带下载地址与校验和),以及构建要用的三个工具的版本与校验和。三个工具都是单个可执行文件:

| 工具 | 用在 | 做什么 |
|---|---|---|
| pixi | 开发者的电脑 | 解析两个平台的依赖,写出锁定清单 |
| pixi-pack | 打包 | 按锁定清单下载一个平台的全部包,核对校验和,原样打成一个文件 |
| pixi-unpack | 用户的电脑 | 把这个文件里的包装成一个 conda 环境 |

pixi 由 prefix.dev 维护,pixi-pack 与 pixi-unpack 由 Quantco 维护,都是 BSD 许可证;它们装的是 conda-forge 的包,用户的电脑上只多一个 pixi-unpack。换成 micromamba 一类的工具,装出的环境相同。

打包时由构建脚本按平台准备:用 pixi-pack 打出这个平台的包,与这个平台的 pixi-unpack 一起放进应用的资源目录(在 `app.asar` 之外)。它和暂存内核、GeoEngine 一样是打包流程的一步。pixi-pack 不运行包里的任何东西,所以 Windows 的包也能在 macOS 上打;它是否真能装好、运行,仍要在 Windows 上验证(第 11 节)。

包随安装包分发,不在用户电脑上下载:准备环境不需要联网,两岸的用户一样。conda 的包本身已经压缩,打成的文件不再压缩;安装包因此增大两百多 MB(macOS 约 209 MB,Windows 约 268 MB),装好后约 900 MB。

更新锁定清单(跟进 Python 的补丁版本,或某个包的安全修复)时,两个平台一起重新解析,并跑一遍环境的检查(第 9 节);锁定清单一变,环境的标识就变,用户装上新版 GeoCode 后环境随之替换(第 6 节)。

随环境分发的 Python 与各个包的许可证声明,与两个上游的一起放在发布仓库里(`DESKTOP.md` 第 6 节)。其中有 LGPL 的库(如 GEOS),也有几个 GPL 的库(GDAL 经 SpatiaLite 带来的 librttopo、libarchive 带来的 lzo、macOS 上 Python 带来的 readline),都是 conda-forge 构建这些包的方式决定的,以动态库的形式随包分发,GeoCode 自己的代码不链接它们;声明里注明它们的源码在 conda-forge 上的出处。pixi-unpack 随应用分发,它的许可证声明也在其中。

## 5. GeoAgent 怎样使用

GeoAgent 得到工作环境的 Python 的绝对路径,运行脚本、装包都用它。环境不放进 `PATH`:用户在终端里、GeoAgent 在 shell 里敲 `python`,仍是用户自己的那一个,不打乱用户已有的环境与习惯。路径怎样交给 GeoAgent(提示词或工具说明),随内核装配一起定。

环境自己的变量由它在 Python 启动时设好(第 6.1 节),所以 GeoAgent 在 shell 里用路径直接运行这个 Python 就能用,不必设任何变量;用户激活过的 conda 设的 GDAL、PROJ 变量也被它换掉。shell 里是用户的环境,还有两样它挡不住:用户设的 `PYTHONPATH` 与个人目录里装的包,要以 `-I` 启动才挡得住;在 shell 里直接运行 GDAL 的命令行工具不经过 Python,用户的 GDAL 变量与配置文件照样影响它。所以规范里写明这两条。

GeoAgent 的规范:

- 运行这个 Python 都加 `-I`。
- 先用预装的包;缺的包用工作环境的 `python -I -m pip install` 装进工作环境,照 `shell` 的权限询问。
- 不用 pip 重装预装的包:PyPI 上的 rasterio、pyogrio 等各带一份 GDAL,装进工作环境就盖过了环境里的那一份。
- 不往用户自己的 Python 里装包,不全局安装,不另建环境。
- GDAL 的处理用 `osgeo` 等 Python 接口做;要用环境里的命令行工具(macOS 在 `base/bin`,Windows 在 `base/Library/bin`),从这个 Python 里启动它们,让它们继承环境的变量,不在 shell 里直接运行。
- 工作环境装坏了,删掉 `envs/default` 并告诉用户重启 GeoCode。

pip 与 matplotlib 这类软件把缓存与配置写在它们自己的默认位置(用户的缓存目录、`~/.matplotlib`),照 `GEOENGINE.md` 第 5 节的原则不归 GeoCode 管。

## 6. 在用户电脑上的准备

环境由 GeoEngine 的一个能力模块准备与管理,它也发布环境的状态(能力域 `python`):检查中、准备中(安装或建立工作环境)、就绪(带 Python 版本、`base` 与工作环境的解释器)、失败(带诊断:哪一步、原因与命令打印的内容)。失败不重试,下次启动再准备。主进程启动 GeoEngine 时告诉它两个位置:应用自带环境的目录与数据目录。

环境的标识是它的定义的校验和(锁定清单里这个平台的各个包的下载地址、三个工具的版本与准备它的构建脚本;conda-forge 的包名带构建号,同一个地址的内容不变),由构建脚本写在包旁边:内容不变,重新打包也不变,用户装上只是重新打包的新版时不必重新安装。`base.json` 另记着 GeoEngine 自己写进 `base` 的文件(`EXTERNALLY-MANAGED` 标记与启动文件)的校验和:新版 GeoCode 改了它们时同样重新安装,不会有 `base` 留着旧的启动文件。GeoEngine 启动时比较 `base.json` 与应用自带环境的标识:

- 一致,且 `base` 的解释器在:直接使用;`envs/default` 不在了就从 `base` 重建它。
- 否则在后台准备。先删掉旧的 `base.json`、`base` 与 `envs/default`,再用 pixi-unpack 把包装进 `base`:它把包解到临时目录下的缓存,装好后自己删掉;GeoCode 把它的临时目录设成 `python/` 下的一个 `.unpack-` 目录,缓存因此不出数据目录。装的时候它把 `base` 的位置写进需要它的文件,macOS 上改过的二进制文件当场重新签名。装好后写入 `EXTERNALLY-MANAGED` 标记与设环境变量的启动文件(第 6.1 节),删掉 pixi-unpack 另写在 `python/` 下的激活脚本与只在编译与调试时用的文件(头文件、链接库、调试符号,Windows 上有七百多 MB),最后写入标识;然后重建 `envs/default`。中途应用退出或安装失败,标识不在,下次启动清掉留下的 `.unpack-` 目录与激活脚本,从头再装,不会用到装了一半的环境。
- 两个 GeoCode 同时启动(只在开发时出现)不另作处理:准备撞在一起时可能有一方失败,下次启动再准备。

旧的 `base` 不留作退路:新环境只能装在 `base` 的位置上,装不好时窗口显示出错页(第 7 节),旧的也用不上。

准备不阻塞 GeoEngine 的启动(`GEOENGINE.md` 第 5 节),等它的是窗口(第 7 节)。安装完成、工作环境建好之后,先用 `base` 的解释器把预装的重包导入一遍(预热),然后才是就绪;每次启动都这样做。macOS 第一次加载一个新的动态库时会检查它,检查结果按文件记住:刚装好的环境预热要半分钟到一分半,之后每次约 1 秒。预热放在就绪之前,窗口与 GEE 的检查(`GEE.md` 第 7 节)就都排在它之后,碰不上冷加载:GEE 的检查有时限,运行按空闲计时,冷加载时脚本几十秒一声不响,可能被当作卡住。预热的清单包括 GEE 用到的 earthengine-api、geedim 与 geopandas;matplotlib 不预热:导入它会在用户的主目录建它的配置目录。预热只为提速,失败只记日志、不影响就绪:这时窗口给不出用户能做的补救,重启也不会重装。

窗口等环境就绪才打开(第 7 节),但地理工具不靠窗口的等待:内核里的任务(如定时任务)不经过加载动画。用到这套环境的能力域在它就绪之前停在检查中,工具调用照常等检查落定(`GEOENGINE.md` 第 3.3 节)。

### 6.1 环境变量

环境自己的变量,即 conda 激活环境时会设的那些,由环境自己设:安装时 GeoEngine 在 `base` 的 `site-packages` 里写入一个启动文件(一个模块与导入它的 `.pth` 文件),这套环境的 Python 每次启动都先执行它,不论由谁、以什么方式启动,工作环境的 Python 也一样。它按解释器自己所在的位置算出路径,覆盖用户环境里的同名变量(证书的两个除外,见下表),Python 启动的子进程(如 GDAL 的命令行工具)也继承它们:

| 变量 | 作用 |
|---|---|
| `GDAL_DATA` | GDAL 的数据文件 |
| `GDAL_DRIVER_PATH` | GDAL 的驱动插件 |
| `PROJ_DATA` | PROJ 的投影数据库 |
| `PROJ_NETWORK` | 设为 `ON`,与没装网格文件(`proj-data`)时 conda 的激活一样:需要网格的转换(如椭球高与 EGM2008 海拔高之间、美国的 NAD27 与 NAD83 之间)从 PROJ 的官方 CDN 只下载用到的部分;不开,这类转换不报错,却退回误差可达几十米的近似转换。不需要网格的转换(投影、TWD97、CGCS2000 等)不联网 |
| `PROJ_USER_WRITABLE_DIRECTORY` | 下载的网格的缓存,放在数据目录的 `python/proj/`,而不是用户目录里 PROJ 默认的位置 |
| `GDAL_CONFIG_FILE` | 指向 `base` 里一个不存在的文件。GDAL 本会读用户主目录下的配置文件 `~/.gdal/gdalrc`,里面的选项能关掉驱动、改掉行为;指向别的文件,它就不读用户的那一个 |
| `SSL_CERT_FILE`、`SSL_CERT_DIR` | 只在 Windows 上设,指向 `base` 带的证书:Windows 上的 OpenSSL 不靠写进文件的位置找证书。用户设了这两个变量且不为空时用用户的 |
| `PATH` | 只在 Windows 上设:把 conda 激活时放在 `PATH` 最前面的 `base` 的几个目录放到最前面,环境与它启动的程序先加载自己的 DLL |

GeoEngine 运行这套环境的 Python 时,以隔离模式(`-I`)启动它,环境变量不继承 GeoEngine 的,只从用户的环境里取网络的与主目录:代理的 `HTTP_PROXY`、`HTTPS_PROXY`、`ALL_PROXY`、`NO_PROXY`,证书的 `SSL_CERT_FILE`、`SSL_CERT_DIR`、`REQUESTS_CA_BUNDLE`、`CURL_CA_BUNDLE`,名字不分大小写;再加 `HOME`。用户环境里的其余变量一个也不给:conda 的 `PYTHONPATH`、`PATH` 里 QGIS、OSGeo4W 带的 GDAL,都会让它加载不属于自己的东西。

`HOME` 不让 Python 加载别处的东西(主目录下的个人 `site-packages` 由 `-I` 关掉,GDAL 的配置文件由启动文件挡开),只指明主目录。不给它,Python 从系统账户查出真实的主目录,结果对用户相同,但开发时的沙箱(`DEVELOPMENT.md` 第 5 节)就挡不住它:matplotlib 会写真实主目录下的缓存,GEE 会读真实的凭据。

其余的它不需要:编码由 Python 自己定,临时目录退回系统的默认位置;在系统设置里配的代理不经环境变量,Python 自己去读。Windows 上 Node 启动子进程时,会从 GeoEngine 的环境里补上进程必需而缺少的系统变量(`SystemRoot`、`TEMP`、`USERPROFILE` 等),其中也有 `PATH`,所以 `PATH` 一定要给,挡住用户的那一个。

隔离模式下 Python 不读任何 `PYTHON` 开头的变量,要它做的设置都以参数给:输出用 UTF-8 是 `-X utf8`,不缓冲输出是 `-u`。

### 6.2 重装与更新

GeoCode 没有自动更新,用户卸载旧版、安装新版。卸载只删应用本身,数据目录与其中的环境留着:

- 新版自带的环境标识不变:直接沿用,第一次启动不用等。
- 标识变了(锁定清单变了),或新版改了 GeoEngine 写进 `base` 的文件:替换 `base`,重建 `envs/default`。GeoAgent 额外装的包随之清空,需要时它再装;它们是对旧的 `base` 装的,留着可能与新的预装包不兼容。

完全卸载时要删的位置里有这个环境(`PATHS.md`)。

## 7. 界面

界面不单独显示这套环境:没有指示灯,设置里也没有它的一行。主窗口打开时,GeoCode 的加载动画一直显示到环境就绪(含预热)才收起:第一次启动与重装环境之后要等安装与预热,在 macOS 上约半分钟到两分钟;平时启动多等约 1 秒。用户在窗口里的操作因此碰不上环境还没好。

准备失败时,窗口显示 GeoCode 的出错页(`DESKTOP.md` 第 6 节),写明 Python 环境没能准备好,附上失败在哪一步、原因与命令打印的内容,只能重启应用,重启会再准备一次。迷你聊天窗口同样显示这一页,但不等环境。诊断也记进应用日志 `main.log`(`PATHS.md` 第 1 节)。GeoEngine 本身起不来时,照旧显示 GeoEngine 的出错页,不等环境。

没有 GeoEngine 的壳服务端(开发时的 `electron:dev`,`DEVELOPMENT.md` 第 5 节)不等:状态接口告诉窗口这个服务端有没有 GeoEngine。

## 8. GEE

GEE 只用 `base`,不用工作环境,也不支持用户自己的 Python。环境由 GeoCode 保证,包的版本是锁定的:GEE 依赖的 earthengine-api 与 geedim 的接口(包括 `geocode` 包对 geedim 的代理补丁,`GEE.md` 第 7 节)只需要对一个确定的版本核对,运行出了问题也不必先分辨是不是环境不对。不用工作环境,是因为 GeoAgent 往里装的包可能盖过预装的,GEE 就跟着坏;`base` 只由安装改变,GEE 的运行因此总是确定的。代价是 GEE 的脚本只能用预装的包。

GEE 从 `python` 的状态取 `base` 的解释器,在环境就绪之前停在检查中。怎样运行、怎样登录与读取凭据,见 `GEE.md` 第 7 节。

## 9. 约束

- `base` 只由安装改变;GeoAgent 与任何运行都不往里装包。
- 准备环境不联网;运行时只有需要网格的坐标转换联网(第 6.1 节)。
- 环境只写在 GeoCode 的数据目录里,安装时的缓存也在其中。
- 两个平台用同一份锁定清单,只用 conda-forge 一个频道。
- 环境自己的变量只由它的启动文件设(第 6.1 节);运行它的一方(GeoEngine、GeoAgent 的 shell 与以后别的入口)不设,也不必知道,就不会漏设。
- 环境的检查在工作环境里运行,不设任何变量,并另跑一遍:用户环境里的 `GDAL_DATA`、`PROJ_DATA` 等指向别处、`~/.gdal/gdalrc` 关掉了驱动。覆盖:工作环境的 Python 启动时不打印任何错误,第 6.1 节的变量都指向 `base`(启动文件出错时 Python 照常运行,只是变量没设,所以要专门查);每个预装的包都能导入;经 pyogrio 读写 GeoPackage、经 rasterio 读写 GeoTIFF,两者与 `osgeo` 用的是同一份 GDAL;GDAL 的驱动插件都能加载;`gdalwarp`、`ogr2ogr` 能运行;一次真实的坐标变换(投影数据库缺失时它才失败,见 `QGIS.md` 第 3 节);Python 的 `urllib`、requests 与 GDAL 读网上的文件都能经 HTTPS 连上(证书的位置错了才失败);装到带空格与中文的路径后照样通过。

## 10. 验收

- 在没有任何 Python 与 conda 的电脑上,安装 GeoCode 后不联网也能准备好环境;GEE 登录、填好项目之后就能运行;GeoAgent 用预装的包读写矢量与栅格、出图,用 `osgeo` 与 GDAL 的命令行工具处理数据。
- 第一次启动时加载动画显示到环境就绪(含预热),之后的启动只多约 1 秒;准备失败时显示出错页,重启后再准备;窗口打开后,第一次运行没有明显的等待。
- 准备中途退出应用,下次启动重新准备,不用半个环境。
- 重装同一版本不重新安装环境;装上环境标识不同的新版,环境被替换、工作环境被重建。
- 往 `base` 装包被拒绝;往工作环境装的包在 GeoAgent 的脚本里可用,不进 `geerun`;删掉工作环境再启动,它回到只有预装包的状态。
- 用户的 `PATH` 里有 QGIS、OSGeo4W 或 conda 的 GDAL,激活了自己的 conda 环境(`GDAL_DATA`、`PROJ_DATA` 等指向别处),或在 `~/.gdal/gdalrc` 里关掉了驱动时,环境照常工作,GeoAgent 在 shell 里直接用路径运行的 Python 与从它启动的 GDAL 命令行工具也一样。
- macOS 与 Windows 上都通过第 9 节的检查;准备环境不写 GeoCode 目录以外的地方。

## 11. 待验证

- Windows 实机:pixi-unpack 能装好环境并通过第 9 节的检查;安装与建立工作环境要多久(第一次启动的加载动画就等多久),Windows Defender 逐个扫描新文件时会慢多少,预热要多久(加载动画也等它);`base` 上 GEE 的登录、检查与运行(凭据按 `USERPROFILE` 展开);能否装到含中文的路径(如中文用户名下的数据目录);数据目录下的路径是否超过 260 个字符(环境里最长的相对路径 108 个字符);`PATH` 里有别的 GDAL(QGIS、OSGeo4W)时加载的是自带的那一份;conda 的 Python 自带把 `Library\bin` 加进 DLL 搜索路径的补丁,它在工作环境里是否同样生效;启动文件改的 `PATH` 是否让环境与它启动的程序先加载自己的 DLL;只有 GeoEngine 给的变量与启动文件设的变量时,能否照常建立环境、导入各个包、加载驱动插件与访问 HTTPS;GDAL 的 Python 脚本(如 `gdal_calc.exe`)靠第一行找 Python,装好后是否指向 `base`;卸载程序是否留下数据目录。
- macOS 13 上能否装好、运行,第一次加载动态库的耗时。
- 正式签名与公证时,应用里的 pixi-unpack 要随应用一起签名与公证;它在用户电脑上装出、签好的环境是否还要别的处理(`DESIGN.md` 第 4 节)。

## 12. 待定

- 第 9 节的环境检查还没有做成脚本,更新锁定清单时手动跑。构建脚本可以在本机平台上用 pixi-unpack 装一份到临时目录来跑它;要不要这样做、放在构建里还是测试里,下次更新锁定清单时定。
- cartopy、scikit-learn、osmnx 要不要预装:osmnx 随 OpenStreetMap 能力域一起定。
