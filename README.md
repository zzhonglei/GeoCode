# GeoCode

GeoCode 是面向地理数据处理任务的桌面端智能体应用。用自然语言描述地理任务,内置的 GeoAgent 会调用 QGIS、GDAL、Google Earth Engine 与 OpenStreetMap 等工具或者 Python 代码,完成各种 GIS 与遥感数据的处理分析。

## 构成

GeoCode 建在两个开源项目之上:

- [OpenCode](https://github.com/anomalyco/opencode):Agent 引擎,位于 `kernel/`;
- [OpenChamber](https://github.com/openchamber/openchamber):桌面应用,位于 `desktop/`。

地理能力由 GeoCode 自己的地理引擎 GeoEngine 提供,位于 `geoengine/`(见 [`docs/GEOENGINE.md`](docs/GEOENGINE.md))。

两个上游的源码放在本仓库里,并持续合并上游的新版本(见 [`docs/UPSTREAM.md`](docs/UPSTREAM.md))。GeoCode 尽量通过配置与装配来定制它们,做不到时才修改上游源码,对上游的全部修改都能用 git 列出来。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | 设计大纲:定位、原则与路线 |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | 开发规范:代码、对上游的修改、测试、文档与提交怎样写 |
| [`docs/UPSTREAM.md`](docs/UPSTREAM.md) | 两个上游怎样导入与升级 |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 怎样安装、构建、运行、打包与检查 |
| [`docs/DESKTOP.md`](docs/DESKTOP.md) | 桌面应用由什么组成、守哪些边界 |
| [`docs/PATHS.md`](docs/PATHS.md) | GeoCode 在用户电脑上与项目里产生的文件 |
| [`docs/GEOENGINE.md`](docs/GEOENGINE.md) | 地理引擎 GeoEngine:各能力域共用的框架 |
| [`docs/QGIS.md`](docs/QGIS.md) | QGIS 能力域:读取地理数据、查阅与执行算法 |
| [`docs/GEE.md`](docs/GEE.md) | Google Earth Engine 能力域:运行 GEE 脚本,在任务里保存与沿用结果 |

## 许可

MIT,见 [`LICENSE`](LICENSE)。`kernel/` 与 `desktop/` 下的代码分别保留 OpenCode 与 OpenChamber 的版权声明,见各自目录里的 `LICENSE`。
