# 工具层与权限

## 1. 这一层是什么

地理内核提供执行能力,Agent 内核提供会话与调度,**工具层是把两者接起来的那一层**:它把地理内核的门面 API 包装成模型可调用的工具,并决定哪个 agent 能调哪一组。

它是一个真实的层,不是某份文档的边角。两份相邻文档都明确把它交出去:

> GEOKERNEL.md §1.4:不定义 Agent、**工具与权限规则**;
> GEOKERNEL.md §11.2:**M4 移交清单**——内核完成后,旧版工具层中不能静默消失的职责;
> KERNEL.md §4.1:地理工具注册 | 工具注册表 + 权限分组 | 未开始。

**移交清单的正本在 GEOKERNEL.md §11.2,本文只引用不复制。** 那份清单描述的是内核交出来的契约,复述必然漂移(KERNEL.md §6 立过同一条规矩)。本文回答的是另一个问题:这些职责在工具层**由谁承担、放在哪里**。

依赖方向:工具层依赖地理内核的门面与 Agent 内核的工具契约,反向皆无。地理内核不认识工具,Agent 内核不认识地理。

## 2. 引擎的形状:会咬到我们的那几条

上游的工具契约(`tool/tool.ts` 的 `Tool.define`)不在这里复述。只记录**违反了就出事**的约束,每条都实测确认过。

| # | 约束 | 位置 | 后果 |
|---|---|---|---|
| 1 | **不自报截断就被代截**——包装层见 `metadata.truncated === undefined` 即调 `truncate.output` | `tool/tool.ts:131` | 见 §5,对地理工具是致命的 |
| 2 | `ctx.metadata()` 走 `updateToolCall`,**是实时广播** | `session/tools.ts:67` | 环境头绝不能走这里(GEOKERNEL §9.1 第二条硬性形态) |
| 3 | 附件形态是 `{ type:"file", mime, url:"data:<mime>;base64,…" }`,id 与会话字段由装配层补 | `tool/read.ts:317`、`session/tools.ts:114` | 预览图给模型的唯一通道 |
| 4 | **权限过滤发生在最后一步**,不在工具注册表里 | `session/llm/request.ts:208` | 注册表只按 provider 与模型家族筛 |
| 5 | 工具是 `Effect<Info, never, R>`,`R` 传导到注册表 | `tool/tool.ts:151` | 见 §7:这是必须打补丁的根因 |
| 6 | 参数解码失败抛 `InvalidArgumentsError`,`formatValidationError` 可定制 | `tool/tool.ts:24` | §11.2 那条"参数 JSON 解析失败的归因文案"的挂点 |

第 5 条值得展开。上游给了两条装配路径接入自定义工具——配置目录扫描 `{tool,tools}/*.ts`、插件的 `tool` 字段——**两条都经 `fromPlugin`**(`tool/registry.ts:120`),而它把工具锁死在插件形态:Zod 参数、`Promise` 执行、**没有 Effect 服务上下文**。地理工具必须 `yield* GeoQgis.Service` 一类,插件形态给不了,也没有全局逃生口能把服务句柄递进去。

所以工具层有且只有一处源码补丁,理由记在 §7。

## 3. 八个工具

| 工具 id | 能力 | 权限键 | 组 | 门禁 |
|---|---|---|---|---|
| `ReadGeoData` | 读矢量/栅格元信息与预览 | `geo_qgis_read` | **QGIS** | QGIS 统一门禁 |
| `QgisDoc` | 算法文档与检索 | `geo_qgis_doc` | QGIS | 同上 |
| `RunQgisAlgorithm` | 执行 Processing 算法 | `geo_qgis_run` | QGIS | 同上 |
| `RunGeeScript` | 执行 GEE 脚本 | `geo_gee_run` | **GEE** | GEE 三层状态 |
| `OsmSearch` | 搜索地名与要素 | `geo_osm_search` | **OSM** | 无环境 |
| `OsmProbe` | 下载前侦察数据量 | `geo_osm_probe` | OSM | 无环境 |
| `OsmGetObjects` | 按对象下载 | `geo_osm_objects` | OSM | 无环境 |
| `OsmGetFeatures` | 按范围与标签批量下载 | `geo_osm_features` | OSM | 无环境 |

**工具 id 逐字沿用旧版**,不改名。它们是模型看到的名字,而旧版那八份经多轮打磨的描述文件通篇以它们为准(§8);改名等于让那份积累失去锚点,换来的只是好看一点。

**分组按环境依赖划分,不按功能。** 三组恰好对应三种就绪条件,所以"关掉一组"在用户心里对应"这套环境我没配"——这个心智模型是准确的,而按功能分组(读/写/查)则不是。

`ReadGeoData` 归入 QGIS 组不是归类方便:工具侧的数据读取**走 QGIS 的 Python**(GEOKERNEL §7.9),并与算法执行**共用同一个就绪门禁**(§4.9)。QGIS 没就绪它一样不能用。

## 4. 权限体系

### 4.1 两层键空间

这是最容易搞错的地方:**同一个工具在两个层面用不同的键**。

| 层 | 键 | 判定 | 效果 |
|---|---|---|---|
| **可见性** | 工具 id(`ReadGeoData`) | `Permission.disabled`(`permission/index.ts:204`) | 工具**从模型的工具清单里消失** |
| **执行** | `ctx.ask` 的 permission(`geo_qgis_read`) | `Permission.evaluate`(`permission/index.ts:28`) | 调用时放行 / 询问 / 拒绝 |

可见性层的键无法自定义——`disabled` 直接拿工具 id 当权限键(edit/write/apply_patch 与三个 MCP 资源工具是仅有的例外映射)。执行层的键由工具自己在 `ctx.ask` 里声明,因此可以任意设计。

一处订正:KERNEL.md 早期记载旧版的蛇形权限规则"很可能从未真正生效过"。实测不成立——旧版的规则**在执行层精确命中**,落空的只有可见性层。这个区分很重要,因为它决定了"名字对不上"到底会漏掉什么。

### 4.2 三条裁决语义

**① 只有"通配全拒"才让工具消失。**

```
"geo_qgis_run": "deny"                  → 工具从模型清单消失
"geo_qgis_run": { "buffer": "deny" }    → 工具仍在册,只在调 buffer 时拒
```

两种是**不同的产品行为**。地理工具一律用前者,不做算法级细则——规则读起来就是产品行为,不需要在两种语义之间换算。

**② 未命中的默认是 `ask`,不是 `deny`。**

```ts
findLast(...) ?? { action: "ask", permission, pattern: "*" }
```

所以全局那条 `"geo_*": "deny"` 不能省。少了它,未授权的 agent 调地理工具会**弹窗问用户**——对用户是莫名其妙的授权请求,对我们是边界静默失效。

**③ 后来者胜,而 agent 层永远在最后。**

合成顺序是 `defaults → 全局 user → agent 自己的`(`agent/agent.ts:279` 与 `:295`),裁决用 `findLast`。所以 agent 级规则盖过全局规则。

同一条规则里,键序也有语义:`fromConfig` 按 `Object.entries` 顺序生成规则。**泛的写前面、具体的写后面**,写反了结果相反。

### 4.3 装配

```jsonc
"permission": { "geo_*": "deny" },

"agent": {
  "GeoAgent": {
    "permission": {
      "geo_qgis_*": "allow",
      "geo_gee_*": "allow",
      "task": { "*": "deny", "osmfetch": "allow" }
    }
  },
  "osmfetch": {
    "permission": {
      "geo_osm_*": "allow",
      "geo_qgis_read": "allow",
      "webfetch": "deny", "websearch": "deny",
      "task": { "*": "deny" }, "question": "deny", "skill": "deny"
    }
  },
  "plan": { "permission": { "task": { "*": "deny" } } }
}
```

四件事同时成立:三组各一条通配 · 单个工具可单独授权(osmfetch 只拿 `geo_qgis_read`,不带算法执行) · `geo_*` 是整个地理能力的总开关 · 工具 id 不受权限设计牵连。

**GeoAgent 不放行 `geo_osm_*`**:OSM 下载只走 osmfetch 子代理,这是刻意的能力隔离。osmfetch 的网络出口锁是点名禁 `webfetch`/`websearch`/`task` 三样,**不是** `"*": "deny"`——后者会连带砍掉它写下载结果所需的 write 权限。

`patterns` 这一维留给操作对象(哪个文件、哪个算法),不用来区分工具。占用了它,就再也写不出"允许读 `./data/*.tif`,其他要问"。

### 4.4 两条 task 规则不只是权限

`task: { "*": "deny", "osmfetch": "allow" }` 除了做子代理白名单,还修好一处上游缺陷。

`tool/truncate.ts:129` 在输出超限时按 `hasTaskTool(agent)` 二选一给建议,而它查的是 `evaluate("task", "*")`——**pattern 是字面量 `"*"`**。有 task 工具时给的建议是"用 Task 工具让 **explore agent** 处理这个文件",并附一句"**不要自己读完整文件**"。GeoCode 禁用了 explore,模型照做会拿到 `Unknown agent type`,同时被禁止用唯一可行的办法(Grep / Read 带 offset)。

上面那条规则让三处判定各得其所:

| 判定 | 过程 | 结果 |
|---|---|---|
| `evaluate("task","*")` | `match("*","osmfetch")` 不成立,只剩通配那条 | **deny** → 落到正确的建议分支 |
| `evaluate("task","osmfetch")` | 两条都匹配,`findLast` 取后者 | **allow** → 仍可派生 |
| `disabled(["task"])` | 最后匹配的规则 `pattern !== "*"` | **不隐藏** → task 工具照常在册 |

plan agent 那条 `task: { "*": "deny" }` 同理,并且比上游更准确:上游写的是 `task: { general: "deny" }`,语义是"计划阶段不许派**可写**代理";general 被禁用后该规则空转,而 osmfetch 恰恰要往磁盘写下载结果。

**这两条是靠权限规则的副作用改一段文案,必须配绊线**:断言超限提示中不出现 `explore`。上游若改动 `hasTaskTool` 的判据,测试变红。

## 5. 输出超限由工具自管

### 5.1 为什么不能用上游机制

上游是 **head 截断**:保留开头、丢弃结尾,超限全文写盘,模型拿到前 2000 行或 50 KB。而 §11.2 要求"不能静默消失"的东西**恰恰都在结尾**——五种终止路径的横幅、耗时页脚、`drainIncomplete`/`truncated` 的呈现、接在非零退出上的结构化错误。

一次超限的算法执行,上游机制会**精确切掉归因所需的全部信息**,只留下前 2000 行进度刷屏。这不是截得不够好,是截反了方向。

逃生口是 `tool/tool.ts:131`:自设 `metadata.truncated` 即完全跳过 `truncate.output`。判定是 `!== undefined`,所以 `false` 也算表过态。

### 5.2 三种策略

| 策略 | 工具 | 做法 |
|---|---|---|
| **不产生大输出** | `OsmSearch` `OsmProbe` `OsmGetObjects` `OsmGetFeatures` `ReadGeoData` | 数据落盘(GEOKERNEL §6.7 落盘契约),输出只给路径与统计摘要;预览图走附件不进正文 |
| **检索类裁剪** | `QgisDoc` | 限条数返回并附"还有 N 条,请缩小查询",让模型收敛而不是让机制截断 |
| **执行类结构化保留** | `RunQgisAlgorithm` `RunGeeScript` | 裁剪发生在**中间**,两头不可裁 |

第三种的形状:

```
<环境头>            必留
…<中间输出裁剪 N 行>…
<尾部保留>          必留
<终止横幅>          必留
<耗时页脚>          必留
```

自设 `truncated: true` 时**必须同时给 `outputPath`**,否则界面找不到完整输出。

## 6. 公共包装

八个工具共享大量职责——环境头、门禁等待、结构化错误、终止横幅、耗时页脚、凭据脱敏、参数归因文案。各写一遍就是八份会漂移的实现,而其中脱敏那条,GEOKERNEL §3.3 的原话是"**漏掉任何一个等于完全没做**"。

因此在 `Tool.define` 之上加一层地理工具专用包装 `tool/geo-tool.ts`,承担 §11.2 中属于全体工具的那部分:

- 门禁检查与中间态等待(带上限)
- 环境头快照:入口取一次、门禁后重取一次,**只前缀于返回值**
- **`NetRedact` 在构造输出的那一刻调用**——唯一出口
- 结构化错误提取、终止横幅、耗时页脚
- §5.2 的结构化保留规则(哪些段不可裁),各工具只声明自己的策略与阈值
- `formatValidationError` 的归因文案

收益不在少写代码,而在**脱敏从"要记得八次"变成结构上不可能漏**。

各工具自己实现的只有领域逻辑与"哪些段属于结构化"。

## 7. 注入点与绊线

工具层对上游只有**一处**源码补丁,即 GEOKERNEL §10.1 的注入点 #9:

**`tool/registry.ts`**——八个工具进 `builtin` 数组,`node` 的 `deps` 加 `GeoKernel.node`。后者是 §2 第 5 条的必然结果:工具的服务依赖 `R` 会传导到注册表,层图因此把"工具依赖地理内核"显式化。

其余全部落在装配层配置或新增文件。

地理工具与上游原生工具**同级平铺在 `tool/` 下**,不另设子目录:它们是 GeoCode 内置核心工具集的一部分,不是外挂。`geo-` 文件名前缀保住可审计性,而新增文件在合并时永不冲突。

绊线两条,都必须做反证(去掉改动看是否变红):

1. 八个工具 id 确实出现在 `registry.ids()` 里;
2. **换一个 agent 调用时工具确实不在模型清单中**——断言"拦住了",不是断言"写了规则"。

第二条是旧版事故的直接教训:规则写进去了不等于命中了。

同时扩充 `core/test/geocode-brand.test.ts` 里已有的文案护栏,覆盖 §4.4 那条截断提示。

## 8. 描述文件

八份描述迁自旧版(`tool/geo/*.txt`,共 181 行),它们经过多轮打磨,逐字迁移。但对照 §11.2 有三处不能照抄:

| 文件 | 处理 |
|---|---|
| `run-processing.txt` | 三处点名旧工具名 `QgisDoc`,改为新 id。**这是旧版事故的镜像**:描述里写一个名字、注册用另一个,模型照做就失败 |
| `osm-search.txt` | **新写**耗时说明。§11.2 要求写明"这一步可能要等几分钟",旧版一个字都没有——不写则 Agent 会把正常等待判为卡死并重试,而重试只是再付一次同样的代价 |
| `gee-run.txt` | 心跳契约已完备(含 `heartbeat()` 用法与"60s idle timeout will FORCE-KILL"的后果),直接迁 |

描述文件**无法承载 `GeoCode:` 标记**——内容原样送进模型,注释会污染指令。可审计性只能由绊线提供,与提示词文件同一处理方式(KERNEL.md §5.3)。

## 9. 挂起项

- **Task 工具的空清单**:`tool/registry.ts:262` 的 `describeTask` 无条件追加"Available agent types and the tools they have access to:",子代理清单为空时后面是空串。osmfetch 落地后自然消失,在那之前模型看到一个用不了的工具。不单独处理,视作 osmfetch 的排期压力。
- **可见性层未启用**:地理工具对所有 agent 可见,执行层拦截。补齐需要在配置里同时维护工具 id 与权限键两套名字,而当前只有 GeoAgent 一个领域 agent,补了也无从验证。**引入第二个领域 agent 时必须重新评估。**
