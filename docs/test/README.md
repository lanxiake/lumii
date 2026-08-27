# docs/test 索引

本目录存放 **CLI / 真实环境** 测试用例与报告（非单元测试源码）。

## Wiki CLI（P0/P1/P2，2026-08-27）

见子目录 [lumii-cli/](./lumii-cli/README.md)：用例、执行器 `run-wiki-cli-suite.mjs`、报告与 evidence。

## Agent 能力（2026-08-27）

| 文件 | 说明 |
|---|---|
| [2026-08-27-agent-capability-test-cases.md](./2026-08-27-agent-capability-test-cases.md) | 全面测试用例（A–H 套件） |
| [2026-08-27-agent-capability-test-report.md](./2026-08-27-agent-capability-test-report.md) | 本轮执行报告与结论 |
| [2026-08-27-agent-capability-evidence.jsonl](./2026-08-27-agent-capability-evidence.jsonl) | 逐条 PASS/FAIL 证据 |
| [run-agent-capability-suite.mjs](./run-agent-capability-suite.mjs) | E2E 执行器（主套件） |
| [run-agent-capability-suite-continue.mjs](./run-agent-capability-suite-continue.mjs) | 中断后续跑 |
| [run-agent-capability-skipped.mjs](./run-agent-capability-skipped.mjs) | SKIP 项 + abort CLI 补跑 |

## 上下文压缩（既有）

| 文件 | 说明 |
|---|---|
| `2026-08-21-context-compression-test-cases.md` | 压缩引擎用例 |
| `2026-08-24-context-compression-*.md` | 压缩验证/边界/报告 |
| `2026-08-24-real-user-scenario-validation.md` | 真实用户场景 |
