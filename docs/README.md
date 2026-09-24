# Lumii 文档中心

本目录是 Lumii 的项目文档根。仓库级协作规范见 [`AGENTS.md`](../AGENTS.md)。

## 目录导航

| 目录 | 定位 | 什么时候看 |
| --- | --- | --- |
| [`standards/`](standards/README.md) | **开发规范（权威正本）** — 项目结构、代码风格、组件/UI、页面模板、功能开发 | 写代码前；新增目录或组件时 |
| [`wiki/`](wiki/README.md) | **结构化知识库** — 10 大部分 47 篇，覆盖需求→架构→设计→实施→测试→排障→规范→索引 | 新人上手；需要跨模块的系统认知 |
| [`design/`](design/README.md) | **设计文档** — 14 个主题子目录，与 `plans/` 一一配对 | 改动某个模块前了解它的设计意图 |
| [`plans/`](plans/README.md) | **实施计划与交付记录** — 15 个主题子目录，与自己配对的设计同名；**根目录无散篇** | 接手多阶段工作；查"这件事当时怎么做的" |
| [`test/`](test/README.md) | **CLI / E2E 测试资产** — `lumii-cli/` 按域组织的现行套件 + `历史归档/` | 写或跑真实环境测试 |
| [`guide/`](guide/) | **用户指南源文件** — 经 `pnpm sync:guides` 同步进安装包 | 改用户手册（改这里，不要改产物） |
| [`fix/`](fix/) | **问题修复记录** — 症状 / 根因 / 修复 / 回归验证 | 遇到相似故障先来查 |
| [`reference/`](reference/README.md) | **外部技术参考** — 外部文章剪藏 + 11 个开源项目的解构分析 | 需要通用技术背景时 |
| [`implementation/`](implementation/README.md) | **实施总结**（跨主题通用落点，当前为空） | 查某功能最终交付了什么 |
| [`analysis/`](analysis/README.md) | **分析与反思**（跨主题通用落点，当前为空） | 做技术选型前 |
| [`features/`](features/README.md) | **功能需求规格**（跨主题通用落点，当前为空） | 写需求规格时 |
| [`temp/`](temp/) | **本地暂存**（`.gitignore` 忽略，不入库） | 临时草稿；有价值的内容应及时转正 |

> **主题轴与职能轴**：`design/`、`plans/` 按**主题**分（记忆系统、客户端UI……）；`fix/` 按**职能**分；`implementation/`、`analysis/`、`features/` 是**跨主题的通用落点，当前为空**——单一主题的总结/分析一律放到它的主题目录里（见各自 README 的「落点约定」），查一件事不用跨目录。

## 文档产出规范

### 五件套流程

跨功能/跨层的工作按「设计 → 计划 → 实施 → 测试 → 总结」产出，完整定义见 [`wiki/05-implementation/01-开发流程与规范.md`](wiki/05-implementation/01-开发流程与规范.md)。落点约定：

| 阶段 | 落点 | 命名 |
| --- | --- | --- |
| ① 设计 | `docs/design/<领域>/` | `YYYY-MM-DD-中文名.md` |
| ② 实施计划 | `docs/plans/<领域>/` | `YYYY-MM-DD-中文名.md` |
| ③ 实施总结 | `docs/plans/<领域>/` | `YYYY-MM-DD-中文名.md` |
| ④ 测试报告 | `docs/test/lumii-cli/<域>/` | `<套件名>-report.md` + `<套件名>-evidence.jsonl` |
| ⑤ 问题修复 | `docs/fix/` | `YYYY-MM-DD-中文名修复.md` |

**`<领域>` 两侧同名**：写设计时在 `design/<领域>/`，写计划时在 `plans/<领域>/`，两个目录名必须一致。新增领域时两边同时建，并在两侧 README 登记。

### 命名约定

- **过程文档**（design / plans / fix / analysis / implementation / test 报告）：`YYYY-MM-DD-中文名.md`，如 `2026-08-24-记忆系统P0实施计划.md`。技术专有名词保留原文——Qwen3-TTS、P0/P1/P2、Wiki、IPC、CLI、Agent、UI/UX、Git、CUDA、ASR、TTS、MCP、Hub、API、Bash、Typecheck、Cron、Composer。
- **系列文档**：用 `NN-中文名.md` 编号表示阅读顺序，如 [`design/自主进化Agent/1-核心设计理念.md`](design/自主进化Agent/)。
- **稳定标识文档**：规范（[`standards/`](standards/)）、手册（[`guide/`](guide/)）、CLI 测试执行器（`test/lumii-cli/**/run-*.mjs`）保持英文原名——它们被 [`AGENTS.md`](../AGENTS.md)、`sync-user-guides.mjs`、[`CLI-TEST-SPEC.md`](test/lumii-cli/CLI-TEST-SPEC.md) 当作稳定标识引用。
- **索引文件**统一叫 `README.md`，放在目录根部。

### 写文档的三条要求

1. **交叉引用**：每份文档顶部写反向引用（关联的设计/计划），底部写前向引用（后续演进）。
2. **状态标注**：文首标明状态（设计待评审 / 已确认 / 实施中 / 已完成 / 已废弃）。
3. **不要制造孤岛**：新增文档后，在所属目录的 `README.md` 里登记一行。

## 按任务找文档

| 我要… | 去看 |
| --- | --- |
| 上手这个项目 | [`wiki/README.md`](wiki/README.md) 的三步上手 → [`wiki/01-project-overview/`](wiki/01-project-overview/) |
| 写一个新功能 | [`standards/feature-development-standards.md`](standards/feature-development-standards.md) + [`wiki/05-implementation/`](wiki/05-implementation/) |
| 加一条 IPC | [`wiki/05-implementation/03-IPC跨层开发指南.md`](wiki/05-implementation/03-IPC跨层开发指南.md) |
| 改 UI / 组件 | [`standards/ui-design-standards.md`](standards/ui-design-standards.md)、[`standards/component-standards.md`](standards/component-standards.md) |
| 查某个文件在哪 | [`wiki/10-knowledge-index/02-代码定位速查表.md`](wiki/10-knowledge-index/02-代码定位速查表.md) |
| 排查一个报错 | [`wiki/07-debugging-and-fixes/`](wiki/07-debugging-and-fixes/) + [`fix/`](fix/) |
| 了解记忆系统 | [`design/记忆系统/`](design/记忆系统/) + [`plans/记忆系统/`](plans/记忆系统/) |
| 了解 Wiki 知识库 | [`design/Wiki知识库/`](design/Wiki知识库/) + [`plans/Wiki知识库/`](plans/Wiki知识库/) |
| 了解自主进化 Agent | [`design/自主进化Agent/`](design/自主进化Agent/) + [`plans/自主进化Agent/`](plans/自主进化Agent/) |
| 做一只宠物 / 改宠物动作 | [`standards/pet-development-standards.md`](standards/pet-development-standards.md)（两条生成线、动作组与命名契约、事件/特效格式）+ [`design/客户端UI/`](design/客户端UI/) 的宠物系列 |
| 了解数据同步 | [`plans/数据同步功能/README.md`](plans/数据同步功能/README.md)（三代方案脉络） |
| 了解技术债治理 | [`plans/代码重构/README.md`](plans/代码重构/README.md)（总报告 + 大文件/死代码 + 客户端切片） |
| 跑真实环境测试 | [`test/README.md`](test/README.md) + [`test/lumii-cli/CLI-TEST-SPEC.md`](test/lumii-cli/CLI-TEST-SPEC.md) |
| 改用户手册 | [`guide/`](guide/)（改完跑 `pnpm --filter ./apps/windows sync:guides`） |

## 维护须知

- `docs/guide/**` 是**源**，`apps/windows/resources/user-guides/**` 是**产物**（脚本生成，勿手改）。改路径或文件名须同步 `apps/windows/scripts/sync-user-guides.mjs`。
- `docs/test/lumii-cli/materials/` 存放测试素材（docx/mp4/PDF），体积大且**不入库**，需手动放置，详见 [`test/lumii-cli/CLI-TEST-SPEC.md`](test/lumii-cli/CLI-TEST-SPEC.md) §6。
- `docs/test/lumii-cli/<域>/` 的**深度固定**（执行器内 `ROOT` 按 4 层计算），不要在域目录下再加一层；移动套件后必须同步 `ROOT`。
- `docs/wiki/` 是**派生层**：内容由 `design/`、`plans/`、`standards/` 的源文档提炼整合而成。修改时以源文档为准，改完回灌 wiki。
- 源码注释中的 `设计：docs/...` 指针指向本目录的真实文档，移动文档时请同步更新引用（可用 `git grep` 检索旧路径）。
