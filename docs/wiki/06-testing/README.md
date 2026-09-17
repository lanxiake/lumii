# 06. 测试与质量

## 简介

测试与质量保障是软件交付可靠性的基石。本章节建立 Lumii 项目的完整质量保障体系，从测试策略顶层设计（测试金字塔），到各层级测试的编写指南，再到性能测试、安全测试、兼容性测试等专项测试方法，最后通过持续集成与质量门禁确保交付物达标。内容不仅包含 Vitest 单元测试和 Playwright E2E 测试的具体写法与最佳实践，更强调「质量内建」理念——如何在需求评审、设计评审、代码审查环节提前植入质量控制点。

Lumii 的测试体系面临一些特殊挑战：AI 生成内容的不确定性如何断言、Agent 长链路行为如何模拟、Electron 多进程交互如何测试、向量检索结果如何评估、数据同步冲突如何构造测试用例等。本章节针对这些场景提供了经过验证的解决方案，包括快照测试、契约测试、模糊测试、混沌工程注入等高级测试技术的落地实践。同时还包含代码覆盖率指标设定、测试用例维护策略、Flaky Test 治理等质量运营内容。

## 本部分文档索引

| 文件名 | 说明 | 状态 |
|--------|------|------|
| [01-测试策略与方法论.md](./01-测试策略与方法论.md) | 测试金字塔落地、AI 非确定性验证、Vitest 规范、测试数据管理、质量门禁与 Flaky 治理 | ✅ 已创建 |
| [02-CLI测试实践.md](./02-CLI测试实践.md) | 执行器 + Evidence + 报告三件套架构、run-suite 标准骨架、八大 CLI 套件索引、真实材料与补跑策略 | ✅ 已创建 |
| [03-E2E与集成测试.md](./03-E2E与集成测试.md) | 自主进化四套 E2E、Agent 能力 A-H 八大套件、六段式用例模板、Schema 迁移验证、IPC 联合断言 | ✅ 已创建 |

## 现有源文档交叉引用

- 测试文档根目录：[`../test/README.md`](../../test/README.md) — 测试体系总览
- Lumii CLI 测试用例：[`../test/lumii-cli/lumii-cli-test-cases.md`](../../test/lumii-cli/general/lumii-cli-test-cases.md)
- Wiki 功能测试报告：[`../test/lumii-cli/wiki-cli-test-report.md`](../../test/lumii-cli/wiki/wiki-cli-test-report.md)
- 自主进化 Agent 测试用例：[`../test/lumii-cli/autonomous-life-test-cases.md`](../../test/lumii-cli/autonomous/autonomous-life-test-cases.md)
- Agent 能力测试报告：[`../test/2026-08-27-agent-capability-test-report.md`](../../test/lumii-cli/agent-capability/agent-capability-report.md)
- 上下文压缩测试指南：[`../CONTEXT_COMPRESSION_TEST_GUIDE.md`](../../test/历史归档/上下文压缩/2026-08-19-上下文压缩测试指南.md)
- 代码风格规范（含测试规范）：[`../standards/code-style-guide.md`](../../standards/code-style-guide.md)
