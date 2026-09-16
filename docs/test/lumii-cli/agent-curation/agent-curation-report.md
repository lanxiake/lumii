# 灵栖情报 / 灵栖维护专项 测试报告

- **生成时间**: 2026-09-16T03:29:21.081Z（开始 2026-09-16T03:28:01.657Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\75791\.lumii\data\agent-runtime.db
- **套件**: CK · 情报与维护专项
- **跳过LLM**: false

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
| CK-08 | ✅ | 体检报告已落库：scope=memory，发现 5 项 | - |

## 失败与跳过明细

无。

## 未纳入自动化的项

| 项 | 原因 |
|---|---|
| 概览页「立即抓取」走同一个会话与执行者 | 该 IPC（`dashboard-feed:refresh`）不在命令总线白名单里，CLI 触发不到；改由 `news-feed-job.test.ts` 的定位单测守（会话 id / 标题 / 执行者三个取值与调度器同口径） |
| 资讯卡跨天分隔的视觉呈现 | 渲染断言由 `NewsFeed.test.tsx` 覆盖（分隔行、天内编号、日期格式），截图回归成本高于收益 |


## 证据

逐条原始证据见 [agent-curation-evidence.jsonl](./agent-curation-evidence.jsonl)。
