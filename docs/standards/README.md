# 规范索引

仓库级要求见 [`AGENTS.md`](../../AGENTS.md)。本目录保存按主题拆分的详细规范；修改代码前阅读与任务直接相关的条目。

## 目录

| 主题 | 文档 | 适用场景 |
| --- | --- | --- |
| 项目结构 | [`project-structure.md`](project-structure.md) | 新增目录、模块或包 |
| 代码风格 | [`code-style-guide.md`](code-style-guide.md) | TypeScript、Hooks、错误处理和命名 |
| 组件开发 | [`component-standards.md`](component-standards.md) | 新增或重构 React 组件 |
| 页面模板 | [`page-template.md`](page-template.md) | 新增页面和页面状态 |
| UI 设计 | [`ui-design-standards.md`](ui-design-standards.md) | 布局、交互、可访问性和视觉令牌 |
| 功能开发 | [`feature-development-standards.md`](feature-development-standards.md) | 跨层功能、IPC 和交付流程 |
| 双连接架构 | [`dual-connection-architecture.md`](dual-connection-architecture.md) | Gateway、客户端连接和认证 |
| 改进记录 | [`improvements-summary.md`](improvements-summary.md) | 了解规范演进和历史决策 |

## 使用要求

- 先读 `AGENTS.md` 的总纲，再按任务打开本索引中的专题文档。
- 专题规范之间出现冲突时，以更具体的专题和当前测试结果为准，并在 PR 中说明。
- 新增或重命名规范文档时，同步更新本索引和 `AGENTS.md` 的专题说明。
