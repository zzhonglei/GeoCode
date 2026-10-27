# GeoCode

GeoCode 是面向地理数据处理任务的桌面端智能体应用。用自然语言描述地理任务,内置的 GeoAgent 会调用 QGIS、GDAL、Google Earth Engine 与 OpenStreetMap 等工具或者 Python 代码,完成各种 GIS 与遥感数据的处理分析。

## 构成

GeoCode 建在两个开源项目之上:

- [OpenCode](https://github.com/anomalyco/opencode):Agent 引擎,位于 `kernel/`;
- [OpenChamber](https://github.com/openchamber/openchamber):桌面应用,位于 `desktop/`。

地理能力由 GeoCode 自己的地理引擎 GeoEngine 提供,位于 `geoengine/`(见 [`docs/geoengine/GEOENGINE.md`](docs/geoengine/GEOENGINE.md))。

## 文档

设计说明:

| 文档 | 内容 |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | 设计大纲:定位、原则与路线 |
| [`docs/DESKTOP.md`](docs/DESKTOP.md) | 桌面应用由什么组成:私有内核、本机访问控制、环境变量、名字与标志、许可证 |
| [`docs/PATHS.md`](docs/PATHS.md) | GeoCode 在用户电脑上与项目里产生与读取的文件,以及怎样删除 |
| [`docs/geoengine/GEOENGINE.md`](docs/geoengine/GEOENGINE.md) | 地理引擎 GeoEngine:各能力域共用的框架 |
| [`docs/geoengine/PYTHON.md`](docs/geoengine/PYTHON.md) | 内置的 Python 环境:组成、构建与分发,在用户电脑上的准备,GeoAgent 怎样使用 |
| [`docs/geoengine/GEOCODEKIT.md`](docs/geoengine/GEOCODEKIT.md) | GeoCode 的 Python 包 `geocodekit`:结构、函数的约定、运行的场合与安装 |
| [`docs/geoengine/QGIS.md`](docs/geoengine/QGIS.md) | QGIS 能力域:读取地理数据、查阅与执行算法 |
| [`docs/geoengine/GEE.md`](docs/geoengine/GEE.md) | Google Earth Engine 能力域:运行 GEE 脚本,在任务里保存与沿用结果 |
| [`docs/geoengine/OSM.md`](docs/geoengine/OSM.md) | OpenStreetMap 能力域:按名字检索、查看区域里的标签与数量、下载干净的矢量数据 |

开发文档:

| 文档 | 内容 |
|---|---|
| [`docs/development/CONVENTIONS.md`](docs/development/CONVENTIONS.md) | 开发规范:原则、产品约束、代码、测试、文档与提交 |
| [`docs/development/DEVELOPMENT.md`](docs/development/DEVELOPMENT.md) | 怎样安装、构建、运行、打包、检查与测试 |

## 许可

GeoCode 以 MIT 许可证发布,见 [`LICENSE`](LICENSE)。`kernel/` 与 `desktop/` 下的代码基于 OpenCode 与 OpenChamber,保留它们各自的版权声明与许可证,见 [`kernel/LICENSE`](kernel/LICENSE) 与 [`desktop/LICENSE`](desktop/LICENSE)。
