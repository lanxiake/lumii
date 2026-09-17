# Lumii 文档中心

本目录是 Lumii 的项目文档根。仓库级协作规范见 [`AGENTS.md`](../AGENTS.md)。

## 目录导航

| 目录 | 定位 | 什么时候看 |
| --- | --- | --- |
| [`standards/`](standards/README.md) | **开发规范（权威正本）** — 项目结构、代码风格、组件/UI、页面模板、功能开发 | 写代码前；新增目录或组件时 |
| [`wiki/`](wiki/README.md) | **结构化知识库** — 10 大部分 36 篇，覆盖需求→架构→设计→实施→测试→排障→规范→索引 | 新人上手；需要跨模块的系统认知 |
| [`design/`](design/) | **设计文档** — 按领域分目录（记忆设计、自主进化Agent、数据同步功能、AGENT优化、专项AGENT、性能优化、Linux客户端移植） | 改动某个模块前了解它的设计意图 |
| [`plans/`](plans/) | **实施计划与交付记录** — 按领域分目录 + 带日期的单篇计划 | 接手多阶段工作；查"这件事当时怎么做的" |
| [`test/`](test/README.md) | **CLI / E2E 测试资产** — 用例、执行器、证据、报告 | 写或跑真实环境测试 |
| [`guide/`](guide/) | **用户指南源文件** — 经 `pnpm sync:guides` 同步进安装包 | 改用户手册（改这里，不要改产物） |
| [`fix/`](fix/) | **问题修复记录** — 症状 / 根因 / 修复 / 回归验证 | 遇到相似故障先来查 |
| [`implementation/`](implementation/) | **实施总结** — 功能模块的完成报告 | 查某功能最终交付了什么 |
| [`analysis/`](analysis/) | **分析与反思** — 方案对比、批判性复盘 | 做技术选型前 |
| [`features/`](features/) | **需求规格样例** — 单个功能的规格说明写法参考 | 写需求规格时 |
| [`reference/`](reference/) | **外部技术参考** — 外部文章、方案剪藏 | 需要通用技术背景时 |
| [`temp/`](temp/) | **本地暂存**（`.gitignore` 忽略，不入库） | 临时草稿；有价值的内容应及时转正到上述目录 |

## 文档产出规范

### 五件套流程

跨功能/跨层的工作按「设计 → 计划 → 实施 → 测试 → 总结」产出，完整定义见 [`wiki/05-implementation/01-开发流程与规范.md`](wiki/05-implementation/01-开发流程与规范.md)。落点约定：

| 阶段 | 落点 | 命名 |
| --- | --- | --- |
| ① 设计 | `docs/design/<领域>/` | `YYYY-MM-DD-<功能名>-design.md` |
| ② 实施计划 | `docs/plans/<领域>/` | `YYYY-MM-DD-<功能名>-implementation-<阶段>.md` |
| ③ 实施总结 | `docs/implementation/` 或 `docs/plans/<领域>/交付总结.md` | `YYYY-MM-DD-<功能名>-implementation.md` |
| ④ 测试报告 | `docs/test/**/` | `*-report.md` + `*evidence.jsonl` |
| ⑤ 问题修复 | `docs/fix/` | `YYYY-MM-DD-<功能>-<问题>-fix.md` |

单篇实验性、一次性文档（如调研笔记）可直接放 `docs/plans/` 根或对应领域的单文件。

### 命名约定

- **带日期的文档**用 `YYYY-MM-DD-` 前缀（英文 slug 或中文主题，与所在目录既有风格保持一致）。
- **领域系列文档**用 `NN-主题.md` 编号（如 `design/自主进化Agent/1-核心设计理念.md`）。
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
| 了解记忆/Wiki 系统 | [`design/记忆设计/`](design/记忆设计/) + [`plans/记忆重构/`](plans/记忆重构/) |
| 了解自主进化 Agent | [`design/自主进化Agent/`](design/自主进化Agent/) + [`plans/AGENT自我进化/`](plans/AGENT自我进化/) |
| 了解数据同步 | [`plans/数据同步功能/README.md`](plans/数据同步功能/README.md)（三代方案脉络） |
| 跑真实环境测试 | [`test/README.md`](test/README.md) + [`test/lumii-cli/CLI-TEST-SPEC.md`](test/lumii-cli/CLI-TEST-SPEC.md) |
| 改用户手册 | [`guide/`](guide/)（改完跑 `pnpm --filter ./apps/windows sync:guides`） |

## 维护须知

- `docs/guide/**` 是**源**，`apps/windows/resources/user-guides/**` 是**产物**（脚本生成，勿手改）。改路径或文件名须同步 `apps/windows/scripts/sync-user-guides.mjs`。
- `docs/test/lumii-cli/materials/` 存放测试素材（docx/mp4/PDF），体积大且**不入库**，需手动放置，详见 [`test/lumii-cli/CLI-TEST-SPEC.md`](test/lumii-cli/CLI-TEST-SPEC.md) §6。
- `docs/wiki/` 是**派生层**：内容由 `design/`、`plans/`、`standards/` 的源文档提炼整合而成。修改时以源文档为准，改完回灌 wiki。
- 源码注释中的 `设计：docs/...` 指针指向本目录的真实文档，移动文档时请同步更新引用（可用 `git grep` 检索旧路径）。
