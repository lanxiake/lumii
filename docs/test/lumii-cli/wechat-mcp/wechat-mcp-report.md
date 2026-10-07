# 微信 MCP 集成 · CLI E2E 测试报告

- **生成时间**: 2026-10-07T15:15:32.539Z（开始 2026-10-07T15:15:31.775Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\Administrator\.lumii\data\agent-runtime.db
- **微信数据**: 微信 4.x 本机库（只读断言走 devcli.py）
- **探针标记**: WM-DRY-1007151531 / WM-REAL-1007151531 / WM-FAIL-1007151531

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 1 |
| 通过 | 1 |
| 失败 | 0 |
| 跳过 | 0 |
| 通过率 | 100.0% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| WM-20 | ✅ | 一键清除：单 scope 清画像+水位、无 scope 被拒、everything 清空全部（临时目录） | 0.3s |

## 失败与跳过明细

无。


## 证据

逐条原始证据见 [wechat-mcp-evidence.jsonl](./wechat-mcp-evidence.jsonl)。
