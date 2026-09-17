# 09. 开发规范手册

## 简介

开发规范手册是团队协作的「交通规则」，通过统一的编码标准、设计约定和流程要求，确保多人协作产出的代码具备一致性、可读性和可维护性。本章节整合了 Lumii 项目全链路的开发规范体系，从 TypeScript 代码风格、React 组件设计、文件命名约定，到 Git 提交规范、文档编写标准、安全编码准则、代码审查 CheckList，覆盖了从代码产生到合入主干的每一个环节的质量控制点。

规范不仅仅是「禁止做什么」的约束清单，更是「推荐怎样做更好」的经验沉淀。每一条规范背后都有其设计意图——要么源于团队踩过的坑，要么基于业界公认的最佳实践。本章节在列出规范条文的同时，尽可能解释规范背后的理由和违反规范的典型后果，让开发者不仅知其然更知其所以然。对于确有理由需要偏离规范的场景，也提供了明确的「例外申请」流程，避免规范僵化阻碍创新。

## 本部分文档索引

| 文件名 | 说明 | 状态 |
|--------|------|------|
| [01-代码风格指南.md](./01-代码风格指南.md) | 命名/格式/TypeScript/React/Hooks/注释/错误处理/性能/测试全章规范 | ✅ 已创建 |
| [02-组件开发规范.md](./02-组件开发规范.md) | 四层组件分类、22+ UI 组件清单、CSS Modules 五强制、页面四状态、三段式检查清单、暗色优先 | ✅ 已创建 |
| [03-页面开发模板.md](./03-页面开发模板.md) | 标准页面目录结构、四状态骨架、Context 五文件结构、四层错误模式、路由与懒加载规范 | ✅ 已创建 |
| [04-UI设计规范.md](./04-UI设计规范.md) | 设计令牌体系、data-theme 切换、暖奶油与深蓝灰双色系、间距字体系统、图标独占、可访问性、六态交互 | ✅ 已创建 |
| [05-功能开发标准.md](./05-功能开发标准.md) | 三层进程架构与目录、IPC 三处同步铁律、四层错误处理 + 六子类、性能优化两反模式、Conventional Commit | ✅ 已创建 |

## 现有源文档交叉引用

- 官方标准总目录：[`../standards/README.md`](../../standards/README.md) — 现有开发规范的官方索引与专题文档入口
- 代码风格指南：[`../standards/code-style-guide.md`](../../standards/code-style-guide.md)
- 项目结构规范：[`../standards/project-structure.md`](../../standards/project-structure.md)
- 组件设计标准：[`../standards/component-standards.md`](../../standards/component-standards.md)
- UI 设计标准：[`../standards/ui-design-standards.md`](../../standards/ui-design-standards.md)
- 功能开发标准：[`../standards/feature-development-standards.md`](../../standards/feature-development-standards.md)
- 页面模板：[`../standards/page-template.md`](../../standards/page-template.md)
- 双重连接架构模式：[`../standards/dual-connection-architecture.md`](../../standards/dual-connection-architecture.md)
- AGENTS.md 协作总纲（根目录）：[`../../../AGENTS.md`](../../../AGENTS.md) — 仓库级协作与代码规范
