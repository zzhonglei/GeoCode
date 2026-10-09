# GeoCode

GeoCode 是面向地理数据处理任务的桌面端智能体应用。用自然语言描述地理任务,内置的 GeoAgent 会调用 QGIS、GDAL、Google Earth Engine 与 OpenStreetMap 等工具或者 Python 代码,完成各种 GIS 与遥感数据的处理分析。

## 构成

GeoCode 建在两个开源项目之上:

- [OpenCode](https://github.com/anomalyco/opencode):Agent 引擎,位于 `kernel/`;
- [OpenChamber](https://github.com/openchamber/openchamber):桌面应用,位于 `desktop/`。

地理能力由 GeoCode 自己的地理引擎 GeoEngine 提供,位于 `geoengine/`(见 [`docs/GEOENGINE.md`](docs/GEOENGINE.md))。

两个上游的源码放在本仓库里,并持续合并上游的新版本(见 [`docs/UPSTREAM.md`](docs/UPSTREAM.md))。GeoCode 尽量通过配置与装配来定制它们,做不到时才修改上游源码;修改处带有注释标记,对上游的全部修改都能用 git 列出来。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | 设计大纲:定位、基础、原则、待定问题与路线 |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | 开发规范:写代码、改上游代码、测试、文档与提交 |
| [`docs/UPSTREAM.md`](docs/UPSTREAM.md) | 两个上游怎么导入与升级 |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 安装、构建、运行、打包与检查 |
| [`docs/DESKTOP.md`](docs/DESKTOP.md) | 桌面应用:组成、内核、边界、本机访问控制、环境变量、名字与标识 |
| [`docs/PATHS.md`](docs/PATHS.md) | 路径与存储:GeoCode 在用户电脑上的目录 |
| [`docs/GEOENGINE.md`](docs/GEOENGINE.md) | 地理引擎:定位、在应用中的位置、结构、边界、约束、验收、QGIS 能力域与待定问题 |
| [`docs/GEE.md`](docs/GEE.md) | Google Earth Engine 能力域:为什么不直接经 shell 运行 Python、一次运行、不被误杀的运行、任务与资产、内置的 Python 包、运行中的信息、环境、权限、界面、验收与待定问题 |

## 许可

MIT,见 [`LICENSE`](LICENSE)。`kernel/` 与 `desktop/` 下的代码分别保留 OpenCode 与 OpenChamber 的版权声明,见各自目录里的 `LICENSE`。
