# Wiki CLI 真实环境测试（P0 / P1 / P2）

本目录存放 Wiki 知识库经 `lumii-ui` 的 **完整可测路径** 用例、执行器与报告。

| 文件 | 说明 |
|---|---|
| [wiki-p0-test-cases.md](./wiki-p0-test-cases.md) | P0：收件箱闭环、金标检索、页面、索引、GAP |
| [wiki-p1-test-cases.md](./wiki-p1-test-cases.md) | P1：双链、修订回滚、清理导出、GAP |
| [wiki-p2-test-cases.md](./wiki-p2-test-cases.md) | P2：综述 accept/reject、图谱、hybrid、状态 GAP |
| [run-wiki-cli-suite.mjs](./run-wiki-cli-suite.mjs) | 执行器（全部 wiki CLI + `command` GAP） |
| [wiki-cli-test-report.md](./wiki-cli-test-report.md) | 最新报告 |
| [wiki-cli-evidence.jsonl](./wiki-cli-evidence.jsonl) | 逐条证据 |

## 前置

1. `pnpm dev` 已启动，控制口可读
2. 可选：`WIKI_CLI_SKIP_AGENT=1` 跳过模型调用
3. 可选：`WIKI_CLI_ALLOW_DELETE=1`（仍默认不删业务 source）

## 执行

```powershell
node docs/test/lumii-cli/run-wiki-cli-suite.mjs
# 跳过 Agent：
$env:WIKI_CLI_SKIP_AGENT='1'; node docs/test/lumii-cli/run-wiki-cli-suite.mjs
```

套件会：

- 播种 `wiki_inbox` 探针测 organize/discard/retry/路径逃逸
- 真跑 synthesis accept（并删除新建综述页，保留审计）
- 用 `command` 覆盖 CLI 未暴露的 IPC（unresolved / concept / attach / status / ero 等）
- 校验 `wiki inbox count` 与 `wiki inbox list` 计数一致

## 本轮代码修复（2026-08-27 续）

- 白名单补 `wiki:inbox:count`
- CLI 新增 `wiki inbox count`、`wiki synthesis get`
