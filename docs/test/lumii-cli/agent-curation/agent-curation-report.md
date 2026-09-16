# 灵栖情报 / 灵栖维护专项 测试报告

- **生成时间**: 2026-09-16T03:59:57.215Z（开始 2026-09-16T03:56:07.861Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\75791\.lumii\data\agent-runtime.db
- **套件**: CK · 情报与维护专项
- **跳过LLM**: false

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 9 |
| 通过 | 9 |
| 失败 | 0 |
| 跳过 | 0 |
| 通过率 | 100.0% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| CK-01 | ✅ | 1 条资讯任务全部由 info-curator 执行 | - |
| CK-02 | ✅ | 工作区文件整理的执行者是 system-keeper | - |
| CK-03 | ✅ | 资讯任务会话的参与者是 info-curator（侧栏据此归入「情报」分组） | - |
| CK-03b | ✅ | 工作区整理会话归属 system-keeper | - |
| CK-04 | ✅ | wiki 保洁类任务仍是 agent_id=null 的确定性通道（不因归属迁移被改成 LLM 任务） | - |
| CK-05 | ✅ | 维护看到了其他 Agent 的记忆：assistant、code-dev、info-curator | - |
| CK-06 | ✅ | 情报回读了资讯卡：调用 dashboard_feed_read，报出最新条目标题 | - |
| CK-07 | ✅ | 资讯任务落成新的一期：13 条，综述 127 字 | - |
| CK-08 | ✅ | 体检报告已落库：scope=memory，发现 6 项 | - |

## 失败与跳过明细

无。

## 未纳入自动化的项

| 项 | 原因 |
|---|---|
| 概览页「立即抓取」走同一个会话与执行者 | 该 IPC（`dashboard-feed:refresh`）不在命令总线白名单里，CLI 触发不到；改由 `news-feed-job.test.ts` 的定位单测守（会话 id / 标题 / 执行者三个取值与调度器同口径） |
| 资讯卡跨天分隔的视觉呈现 | 渲染断言由 `NewsFeed.test.tsx` 覆盖（分隔行、天内编号、日期格式），截图回归成本高于收益 |


## 证据

逐条原始证据见 [agent-curation-evidence.jsonl](./agent-curation-evidence.jsonl)。
