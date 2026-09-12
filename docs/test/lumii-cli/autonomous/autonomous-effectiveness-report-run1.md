# 自主进化有效性验证（EVO 加速实验） 测试报告

- **生成时间**: 2026-09-12T14:47:13.438Z（开始 2026-09-12T14:42:54.702Z）
- **驱动方式**: 全部经 lumii-ui CLI 真实调用（conversation/send/context 等），真实客户端 + 真实 LLM，无 SQL 播种
- **数据库**: C:\Users\Administrator\.lumii\data\agent-runtime.db
- **实验范围**: B
- **真实数据操作**: 见副作用声明
- **环境**: 真实 LLM

## 概要

| 指标 | 值 |
|---|---|
| 总数 | 8 |
| 通过 | 5 |
| 失败 | 3 |
| 跳过 | 0 |
| 通过率 | 62.5% |

## 逐条结果

| ID | 状态 | 说明 | 耗时 |
|---|---|---|---|
| EVO-B0 | ✅ | 临时参数（approvalMode=always / maxGoalsPerDay=20 / maxOutreach=0）生效；积压 executing 0 个，0 次 tick 消化至 0 个 | 0.3s |
| EVO-B1 | ✅ | 低分 overall=0.488 → 新目标 41_zhhfklc [learning]「改善用户反馈质量：学习更好的交互模式」 | 16.8s |
| EVO-B2 | ✅ | 反思落库（user-request）「我在任务形式上常常能完成，但缺少对资料依据和用户真正关注点的稳定抓取，尤其当任务…」；建议 3 条，新 pending 3 条（选用 21-f5ydan9） | 32.0s |
| EVO-B3 | ✅ | 目标 21-f5ydan9 批准 → executing「未来一段时间内把 document_analysis 从0.11提升到0.60以」 | 0.2s |
| EVO-B4 | ❌ | tick 未成功执行目标：summary="skipped: user turn in progress" | 61.1s |
| EVO-B5 | ❌ | 目标执行后未沉淀工作记忆（agent_memories） | 32.2s |
| EVO-B6 | ❌ | memory search「未来一段时间内把」未命中（返回 0 条） | 0.2s |
| EVO-B7 | ✅ | 自建任务 agent-self:1789222884334-0「把先问一句、再查一句的感觉写成一个很短的小提示，只写三到五行。…」（原定 2026-09-12T15:10:00Z）手动执行成功：先问一句，是把问题的边界摸清楚——
对方真正卡住的，往往不在他开口的那句话里。
再查一句，是让事实说话，别用猜测填满空白 | 4.8s |

## 失败与跳过明细

- **EVO-B4** FAIL: tick 未成功执行目标：summary="skipped: user turn in progress"
  ```
  Error: tick 未成功执行目标：summary="skipped: user turn in progress"
    at Module.assert (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at h.runCase.fails.fails (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/autonomous/run-autonomous-effectiveness-e2e.mjs:456:7)
    at Module.runCase (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:513:18)
    at runExperimentB (file:///E:/my-project/open-source/lumii/docs/test/
  ```
- **EVO-B5** FAIL: 目标执行后未沉淀工作记忆（agent_memories）
  ```
  Error: 目标执行后未沉淀工作记忆（agent_memories）
    at Module.assert (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at h.runCase.fails.fails (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/autonomous/run-autonomous-effectiveness-e2e.mjs:486:7)
    at Module.runCase (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:513:18)
    at runExperimentB (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/autonomous/run-
  ```
- **EVO-B6** FAIL: memory search「未来一段时间内把」未命中（返回 0 条）
  ```
  Error: memory search「未来一段时间内把」未命中（返回 0 条）
    at Module.assert (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:110:20)
    at h.runCase.fails.fails (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/autonomous/run-autonomous-effectiveness-e2e.mjs:497:7)
    at Module.runCase (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/lib/cli-harness.mjs:513:18)
    at runExperimentB (file:///E:/my-project/open-source/lumii/docs/test/lumii-cli/autonomou
  ```

## 客观事实（供结论引用）

- 实验 A：未执行
- 实验 B：低分 0.488 触发目标「改善用户反馈质量：学习更好的交互模式」；执行闭环目标 21-f5ydan9；产出「…」
- 实验 C：日记未验证
- 基线对照（9/6-9/8 运行痕迹）：8 篇日记均为空洞独白（「今天没有特别的事」类）；18 个目标卡 pending；13 次主动消息为标题「Lumii」的系统通知。

## 副作用声明

- 不可恢复写入：prompt_variants 统计与 history、测试目标（[evo-e2e]）、reflections、agent_memories/wiki_sources 沉淀、autonomous_diaries、evolution:main、探针会话（[evo-e2e-*]，CLI 无删除能力，保留待人工处理）。
- 已恢复：enabled/settings/mood/concerns/last_diary_date/tokens/outreach/cron enabled/feedback。
- 未触碰：历史 18 个 pending 目标、用户既有会话。


## 证据

逐条原始证据见 [autonomous-effectiveness-evidence.jsonl](./autonomous-effectiveness-evidence.jsonl)。
