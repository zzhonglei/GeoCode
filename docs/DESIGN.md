# 设计总纲

本文档是 GeoCode 设计说明的入口:它是什么、由哪几部分组成、各部分怎样配合,以及贯穿各部分的几条设计原则。各部分的设计在各自的文档里,本文只讲到能找到它们为止。

## 1. 定位

GeoCode 是面向地理数据处理任务的桌面端智能体应用。用户用自然语言描述地理任务,内置的 GeoAgent 调用 QGIS、GDAL、Google Earth Engine 与 OpenStreetMap 等工具或者 Python 代码,完成各种 GIS 与遥感数据的处理分析。

GeoCode 只做桌面应用,支持 Apple 芯片的 macOS 13 以上与 Windows(x64)。macOS 的下限来自内核:以 Bun 编译的内核可执行文件要求 macOS 13。

## 2. 整体架构

```
Electron 主进程
 ├─ 壳服务端(在主进程内运行)
 │    └─ 子进程:内核(GeoAgent 所在)
 ├─ 辅助进程:GeoEngine
 │    └─ 任务进程:QGIS 的 Python、内置的 Python 环境
 └─ 界面(渲染进程)── 只与壳服务端通信
```

- 桌面应用(`desktop/`,`DESKTOP.md`):主进程管理窗口与各个进程;壳服务端为界面提供文件、终端、设置等接口,启动内核并把它的接口代理给界面,也守着本机的访问控制。
- 内核(`kernel/`):agent 引擎,负责会话、模型接入与登录、权限裁决与工具调度。GeoAgent 与地理工具都在这里;地理工具接到任务,交给 GeoEngine 去做。
- 地理引擎 GeoEngine(`geoengine/`,`GEOENGINE.md`):管理用户电脑上的地理执行环境,执行地理任务。它的各能力域互不依赖:QGIS(`QGIS.md`)、Google Earth Engine(`GEE.md`)与 OpenStreetMap(`OSM.md`);后两者运行在 GeoCode 自带的 Python 环境里(`PYTHON.md`),用 GeoCode 自己的 Python 包 `geocodekit`(`GEOCODEKIT.md`)。
- 文件与存储:各部分在用户电脑上与项目里产生与读取的文件,见 `PATHS.md`。

`kernel/` 与 `desktop/` 分别基于开源项目 OpenCode 与 OpenChamber。GeoCode 用不到的上游功能只是关掉,不删源码,以便持续合并上游的更新。

## 3. 设计原则

- 一个应用,只在本机为一个用户工作。安装、启动、退出都只有一个入口;不让其他设备连进来,只有应用自己的窗口能使用它(`DESKTOP.md`)。
- agent 与地理执行分开。内核管 agent、工具与权限,GeoEngine 只负责做事。一次空间分析可能运行很久、占用大量内存,调用的外部程序可能卡住或崩溃,所以 GeoEngine 单独成一个进程,任务出了问题拖不垮应用(`GEOENGINE.md` 第 1 节)。
- 用用户已有的软件,不替用户改环境。QGIS 由用户自己安装,GeoCode 找到它、验证它能否运行,不安装软件,也不改动用户已有的环境;GeoCode 自带的只有一个内置的 Python 环境,放在它自己的数据目录里(`PYTHON.md`)。
- 地理结果要可信。地理数据没有撤销:工具的输出不覆盖已有的文件,不留下写了一半的文件;请求或读取失败时报告失败,不当作没有数据(`CONVENTIONS.md` 第 2 节)。
- 数据只去用户选的地方。GeoCode 自己不收集、不上传任何运行数据与对话:没有遥测,没有崩溃上报,也不检查更新。对话只发给用户选择的模型服务商。agent 使用工具时,工具请求所需的内容发给对应的服务,例如搜索词发给用户选的搜索服务,GEE 脚本发给 Google Earth Engine,地名发给 OpenStreetMap 的检索服务。
