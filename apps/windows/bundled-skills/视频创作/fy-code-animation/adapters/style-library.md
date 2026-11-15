# 341 风格库原位接口

只用 Python 标准库，不安装、不下载。在技能包根目录下运行。脚本不复制原文，每次读取都校验 SHA。

## 库在哪里

脚本按以下顺序找库根目录，库根下应有 `风格提示词/` 和可选的 `示例/`：

1. 命令行 `--root <目录>`；
2. 环境变量 `FY_STYLE_LIBRARY_ROOT`；
3. [`style-library.config.json`](style-library.config.json) 里的 `root`。

**包内 `root` 默认指向 `references/代码动画`——341 种风格和 193 张静帧随技能一起分发，开箱即用，不需要用户提供路径。** 相对路径按技能根目录解析。

要换成自己整理的库：把 `root` 改成你的路径、设环境变量、或每次传 `--root` 都行，内置库不会被删除。找不到时报 `MISSING_LIBRARY_ROOT` 或 `LIBRARY_ROOT_NOT_FOUND`，不会悄悄换成别的库。`--index` 默认是 `adapters/style-index.json`。

随包的 `style-index.json` 就是用内置库建的（343 条，含 2 条示例）。如果你换了库，`get` 会报 `STYLE_VERSION_CHANGED` 或 `MISSING_STYLE_FILE`：用 `build --root <库根>` 重建一次即可，索引只记相对路径和 SHA，不复制原文。

## 三种使用情况

**作者给了明确编号**（如“用 L36”“第二章用 K12”）：

```powershell
python scripts/style_library.py get --query L36 --kind prompt --audit-dependencies
```

**作者给了一份清单**（文件里有编号；`--names` 让没有编号的行按名称查）：

```powershell
python scripts/style_library.py selection --selection-file 作者风格清单.txt --kind prompt --names
```

全部条目都能唯一定位才会输出，避免只成功一半就继续制作。

**作者委托你选，或只给了模糊方向**（如“工程感”“温暖一点的卡通”）：

```powershell
# 1. 浏览目录：每条带分类、长什么样、适合讲什么、关键词
python scripts/style_library.py list --category L_
python scripts/style_library.py list --category 卡通
python scripts/style_library.py list            # 全部 343 条，输出较长
# 2. 词面检索作补充
python scripts/style_library.py search --query "工程 纸 制图"
# 3. 对 2–4 个候选逐个 get 读完整原文，再按全文含义判断
python scripts/style_library.py get --query 蓝图
```

`list` 和 `search` 只提供候选，不代替理解。选定前必须用 `get` 读完整提示词，并按全文含义、作者意图、画幅和工程条件判断。把候选和理由写进任务卡；作者没有委托时，只把候选提给作者，不擅自定。

## 库的结构（2026-10-30 快照）

| 分类目录 | 条数 | 特点 |
|---|---:|---|
| A-G_代码样片 | 26 | 短小的代码动画手法（字雨、打字、大字冲击等），多为单一机制 |
| H_现成版式 | 12 | 版式与配色为主 |
| K_卡通画风 | 38 | 卡通角色与画法 |
| L_Lemo-Opuscar | 59 | 来自 Lemo 的完整风格，部分引用 DEMO.md 和 demo 脚本（分享库未必携带） |
| M_动态风格 | 40 | 运动语法为主 |
| O_奥斯卡98部 | 98 | 按电影美术提炼的画面风格，含年代与媒介特征 |
| R_照参考学来的 | 7 | 照参考作品学来的方法 |
| V_mg-styles-15 | 15 | MG 动画风格 |
| X_code-video | 31 | 代码视频风格，X7 另有一句话示例 |
| Z_中国风 | 15 | 中国风 |
| 示例 | 2 | B6、X7 的示例记录，不属于正式编号集合 |

“341”是观察到的正式条目数，不是上限。条目粒度不同：有的只是配色版式，有的包含完整运动方法，不是 341 个同粒度、互斥的模板。

## 必须注意的特殊情况

- **同名歧义**：X7 在正式和示例中各有一条。不指定 `--kind` 会报 `AMBIGUOUS_STYLE`，正式条目用 `--kind prompt`。
- **只在示例中**：B6 只有示例记录（12 秒单 Canvas 高能片头方案），不在正式编号集合里。
- **缺依赖**：L36 等 Lemo 条目引用 DEMO.md、paper.js、draw.js、sheet.js、film.js，分享库里并不齐全。`--audit-dependencies` 会列出字面路径的候选，但始终返回 `dependency_audit_complete=false`：Markdown 正文、动态 import、资源加载需要人工核。缺了就写进任务卡的缺项，并说明是独立实现还是去原 Lemo 仓定位，不能悄悄换成普通网格。
- **分享 HTML**：`风格挑选.html` 不含所有条目的全文，只能浏览，不能当原文。
- **版本**：库版本是所有相对路径加内容 SHA 的聚合 SHA。源文件改了，`get` 会拒绝旧索引，审阅变更后重新 `build`。整库移到别的盘，相对索引不变。
- **路径安全**：符号链接和路径穿越经 resolve 后不得逃出库根。

## 读到原文之后

把条目原文和适配解释分开记录：原提示词保留，适配另写在任务卡的风格卡里（见 [风格模块](../modules/style.md)）。示例故事、品牌、人物不要原样搬进本片。

原分享库约定免费使用、免费分享，禁止包装成课程、付费 skills 或其他收费产品。本包已随附 341 条原文与静帧（作者本人开源分享），成片演示视频因体积原因未随包分发，需要时按各示例目录里的说明自行渲染。
