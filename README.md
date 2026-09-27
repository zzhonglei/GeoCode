# GeoCode

GeoCode 是面向地理工作者的桌面 AI 应用。用自然语言描述地理任务,内置的 GeoAgent 会调用 QGIS、GDAL、Google Earth Engine 与 OpenStreetMap 完成数据处理,结果在应用内可视化。

## 状态

GeoCode 正在基于 OpenCode V2 与 OpenChamber 2 重建,目前还没有可用的安装包。

## 构成

GeoCode 建在两个开源项目之上:

- [OpenCode](https://github.com/anomalyco/opencode):Agent 引擎,位于 `kernel/`;
- [OpenChamber](https://github.com/openchamber/openchamber):桌面应用,位于 `desktop/`。

两者的源码放在本仓库里,并持续合并上游的新版本。GeoCode 的功能尽量通过配置与插件接入,只在必要处修改上游源码。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/DESIGN.md`](docs/DESIGN.md) | 设计大纲:定位、基础、原则、待定问题与路线 |
| [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md) | 开发规范:写代码、改上游代码、测试、文档与提交 |
| [`docs/UPSTREAM.md`](docs/UPSTREAM.md) | 两个上游怎么导入与升级 |
| [`docs/DEVELOPMENT.md`](docs/DEVELOPMENT.md) | 安装、构建、运行与打包 |
| [`docs/DESKTOP.md`](docs/DESKTOP.md) | 桌面应用:进程组成、内核的托管与打包、对外边界 |

## 许可

MIT,见 [`LICENSE`](LICENSE)。`kernel/` 与 `desktop/` 下的代码分别保留 OpenCode 与 OpenChamber 的版权声明,见各自目录里的 `LICENSE`。
