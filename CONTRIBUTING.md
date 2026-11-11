# 参与开发

怎样给 GeoCode 提 issue 与 PR:什么要先讨论、代码放在哪里、跑哪些检查、标题怎样写、怎样审查与合并。开发环境与规则不在这里重复,在 `docs/development/` 的三份文档里:`CONVENTIONS.md` 是必须守的规则,`DEVELOPMENT.md` 讲怎样安装、构建与运行,`TESTING.md` 讲怎样测试。

GeoCode 的主线 `main` 由维护者维护,其他人的改动经 PR 合入。issue、PR 的描述与讨论用中文或英文都可以;代码、注释与提交信息用英文。

## 1. 先开 issue 还是直接提 PR

修 bug 可以直接提 PR,描述里说明问题是什么、怎样复现;已有 issue 的写上 `Fixes #<编号>`。只改文档措辞、只补测试的,也可以直接提。

下面这些先开 issue,等维护者同意之后再动手,否则写好的 PR 可能不被合并:

- 新功能,或改变已有的行为:新的按钮、设置、命令,改默认值,改界面上的文字与交互。
- 交给模型的文字:工具的说明与答复、提示词、技能、`geocodekit` 公开函数的说明。措辞的一点差别就会改变模型的做法,这类文字由维护者逐段定稿。
- 改变 OpenCode 或 OpenChamber 原有的行为,包括打开 GeoCode 有意关闭的功能。
- 新的能力域,新的依赖,往内置的 Python 环境里加包:加一个包,每个用户的环境都要重装一次。
- 新的文档或章节。

拿不准属于哪一种,开一个 issue 问,一段话的事。

## 2. 代码放在哪里

GeoCode 自己的代码在 `geoengine/`、`scripts/`,以及 `kernel/`、`desktop/` 里各包的 `geocode/` 目录。

`kernel/` 与 `desktop/` 是 OpenCode 与 OpenChamber 的源码,GeoCode 持续合并它们的新版本。要改那里的功能时,把逻辑写进所在包的 `geocode/` 目录,上游的文件里只留调用它的一两行,并用 `GeoCode:` 注释标出来;不格式化、不重排上游的行。合并上游时怎样照顾这些改动,由维护者负责:拿不准怎样改上游文件时,在 PR 里说明,维护者会调整。

写代码之前,通读 `CONVENTIONS.md`:每一节都是要守的规则。最常用到的是第 2 节的产品约束(输出不覆盖已有的文件,失败不当成空结果,路径与其他产品分开)、第 4 节各个目录的写法与第 9 节的提交信息。代码在 macOS 与 Windows 上都会运行,常见的坑在 `DEVELOPMENT.md` 第 8 节。

## 3. 准备环境

安装依赖、构建与在沙箱里启动应用,照 `DEVELOPMENT.md` 第 2 至 5 节。在沙箱里启动,开发留下的会话与设置不会混进自己平时用的那一份。

## 4. 检查与测试

提 PR 之前,在本机跑:

- 改到的部分的类型检查与 lint,命令在 `DEVELOPMENT.md` 第 7 节;改了 `desktop/` 再跑 `node scripts/own-anti-slop.mjs`,它要的 `chamber-upstream` 分支怎样取得也在那一节。
- `node scripts/test.mjs changed`,它按改动挑出要跑的测试。它只看还没提交的改动,所以在提交之前跑;已经提交的,指名改到的部分的套件,如 `node scripts/test.mjs kernel web`,套件见 `TESTING.md` 第 3 节。

测试只经 `scripts/test.mjs` 运行:它给每次运行一个临时的主目录;直接运行包目录里的测试命令,有的会写进自己电脑上真实的主目录。新写的测试要先证明它会失败,做法在 `TESTING.md` 第 9 节。

PR 提交后,GitHub 在 macOS 与 Windows 上各跑一遍检查(`TESTING.md` 第 10 节),四项都通过才能合并;第一次提 PR 的人,检查要等维护者批准才开始运行。接真实 QGIS、Earth Engine 的测试与打包版的检查,由维护者在合并前补跑。PR 里写的检查结果是实际跑出来的;没有条件跑的检查,写明没有跑。

## 5. 提交 PR

PR 用 squash 合并,PR 的标题就是 `main` 上那次提交的信息,所以标题照提交信息的格式写:

```
type(scope): summary
```

用英文写,`type` 与 `scope` 怎样取见 `CONVENTIONS.md` 第 9 节。`summary` 写用户能感受到的变化,而不是改了哪个函数,例如 `fix(desktop): show the agent's name, not its id, under each answer`。

一个 PR 只做一件事。顺手看到的别的问题另开 issue 或 PR,不混进这次的改动。描述照模板填,简短说明改了什么、为什么、怎样验证的,写 diff 本身说不出的事,不必逐个文件列改动;改了界面的附上改动前后的截图。在 fork 上提 PR 时勾选「Allow edits by maintainers」,小问题维护者可以直接在 PR 上改。

## 6. 审查与合并

维护者逐个审查,只看改动合不合规范。提交的人要能说明每一处改动为什么这样改。小问题维护者可能直接在 PR 上修改,或者请提交者修改。合并时用 squash,并按需要整理提交信息。小而专一的 PR 审查得最快。

## 7. 许可

提交的贡献按项目的 MIT 许可证发布,不需要另签协议。

## 8. 不写代码也能帮忙

- 报 bug、提建议,用 issue 的模板;使用上的提问发到 [Discussions 的 Q&A](https://github.com/zzhonglei/GeoCode/discussions/categories/q-a)。
- 在 Windows 上试用并报告问题:GeoCode 的开发多在 macOS 上进行,Windows 上的使用报告格外有用。
- 回答别人的提问,改进文档里说得不清楚的地方。
