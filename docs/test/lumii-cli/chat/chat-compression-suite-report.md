# 聊天上下文压缩套件 测试报告

- **生成时间**: 2026-09-12T13:45:50.560Z（开始 2026-09-12T13:39:39.870Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\Administrator\.lumii\data\agent-runtime.db
- **回合超时**: 180000ms
- **用例过滤**: （全部）

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 6 |
| 通过 | 6 |
| 失败 | 0 |
| 跳过 | 0 |
| 通过率 | 100.0% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| CHAT-CMP-01 | ✅ | compact 成功；返回字段 [success,previousMessageCount,newMessageCount,messagesRemoved,hadSummary,conversationTokensBefore,conversationTokensAfter,reason]；消息 4 条（含疑似摘要 0 条）；DB 4→4 保留；usage 字段 [usedTokens,contextWindow,triggerThreshold,breakdown] | 37.7s |
| CHAT-CMP-02 | ✅ | 压缩后仍记得 47：「你的幸运数字是 47。…」 | 63.5s |
| CHAT-CMP-03 | ✅ | usedTokens=25819 contextWindow=256000（字段: usedTokens,contextWindow,triggerThreshold,breakdown） | 0.2s |
| CHAT-CMP-04 | ✅ | 压缩后新回合正常（8.2s），DB 累计 6 条 | 107.2s |
| CHAT-CMP-05 | ✅ | 原文保留：DB 4 → 4（roles: user,assistant） | 51.0s |
| CHAT-CMP-06 | ✅ | abort 明确响应（code=0，接受）；会话仍可读（6 条） | 0.3s |

## 失败与跳过明细

无。

## 覆盖范围

- 手动 compact（CMP-01）、压缩后回忆（CMP-02）、usage 字段（CMP-03）、压缩后可用（CMP-04）、原文保留（CMP-05）、中止（CMP-06）
- 对应用例文档：chat-test-cases.md §三
- 说明：自动压缩触发需接近上下文窗口极限（成本高），由人工观察与 autonomous 套件覆盖（见用例文档「已知限制」）


## 证据

逐条原始证据见 [chat-compression-suite-evidence.jsonl](./chat-compression-suite-evidence.jsonl)。
