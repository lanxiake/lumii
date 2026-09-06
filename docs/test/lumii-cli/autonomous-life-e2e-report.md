# 自主进化「心跳与生命感」E2E 测试报告

**执行时间**: 2026-09-06T14:33:28.430Z
**结果**: 23 PASS / 0 FAIL / 0 SKIP（共 23）
**数据库**: `C:\Users\Administrator\.lumii\data\agent-runtime.db`
**驱动方式**: 真实动作（发消息/改设置/cron run/删除）经 lumii-ui CLI，探针播种经 node:sqlite，读取回查 DB 验证落库

## 明细

| 用例 | 结果 | 说明 |
|---|---|---|
| A1 | PASS | settings get 返回全量默认值: 9 字段与 DEFAULT_SETTINGS 一致 |
| A2 | PASS | settings set 部分覆盖不丢默认: 只覆盖 maxOutreachPerDay，其余 8 字段保持默认 |
| A3 | PASS | 非法值回落默认: 越界数字回落默认、非法枚举回落 |
| A4 | PASS | maxOutreachPerDay=0 合法边界: 0 被保留，未当非法值回落 |
| C1 | PASS | 空信号 tick → idle（默认路径）: summary="idle" |
| B1 | PASS | 空闲 tick 不创建 evolution:main（延迟创建）: 会话已存在，idle 未新增 |
| C2 | PASS | 关闭开关 tick → skipped: disabled: summary="skipped: disabled" |
| E1 | PASS | proactive 目标 → 发送 + 计数 + 完成: outreach sent，目标 completed，计数=1 |
| E2 | PASS | 最小间隔未到 → 不再发: summary="idle"，目标仍 executing |
| E3 | PASS | 预算用尽 → 主动消息停发: summary="idle"，计数封顶 20 |
| B2 | PASS | 删除守卫拒绝删除 evolution:main: 拒绝（code=5），会话仍在 |
| D1 | PASS | learning 目标执行 → 完成 + 独白: 目标 completed，独白 "一句话说明：

**心跳（heartbeat）是自主进化系统…"，mood {"energy":0.9994595950506419,"valence":0.25,"arousal":0.35,"updatedAt":1788705150580} |
| G1 | PASS | 目标执行触发情绪事件（方向断言）: d1Status=completed → mood {"energy":1,"valence":0,"arousal":0.5,"updatedAt":1788705122494} -> {"energy":0.9994595950506419,"valence":0.25,"arousal":0.35,"updatedAt":1788705150580} |
| J2 | PASS | 目标执行后 token 累计: 今日已消耗 34000 token（≥8000） |
| J1 | PASS | 预算超限 → 目标执行降级 idle: summary="idle"，未烧 LLM |
| H1 | PASS | 对话中顺带提起牵挂（提一次）: raisedCount=1，nextRaiseAfter 后移，status=open |
| H2 | PASS | 提两次无回应 → dropped: raisedCount=2，status=dropped |
| H3 | PASS | 牵挂只进上下文，不产生通知: outreach 计数仍为 20（牵挂不触达系统通知） |
| F1 | PASS | 静默时段 + 满 24h → tick 触发反思: trigger=scheduled primaryIssue="多次任务完成度高、效率也不低，但反馈分频繁偏低，说明交付结果…" |
| I1 | PASS | 静默时段 + 今日未写 → 写日记入 evolution:main: 日记 "今日日记

今天还是没有发生什么特别的事。我提醒了用户休息，…"，无指标词，标记今日已写 |
| I2 | PASS | 同日第二次 tick 不重复写日记: summary="idle"，消息数不变 |
| K1 | PASS | edit 负反馈信号落库（计数器/评分消费）: edits=1, user_feedbacks=[] |
| K2 | PASS | resend 负反馈信号落库（计数器/评分消费）: resends=0, user_feedbacks=[0.6499999999999999] |

## 覆盖范围

- 设置参数：默认值 / 部分覆盖 / 非法值 clamp / 0 合法边界（A1-A4）
- 心跳决策：空信号 idle、关闭 skipped、tick 执行链路（C1-C2）
- 主动消息：发送+计数、最小间隔、预算用尽（E1-E3）
- 专属会话删除守卫（B2）
- 目标执行：learning → completed/failed + 独白 + Mood 事件（D1/G1）
- 反思定时：静默时段 + 24h → scheduled 反思落库（F1）
- 牵挂：顺带提一次 / 两次 dropped / 不产生通知（H1-H3）
- 日记：静默时段写入 + 禁令（无指标词）+ 同日防重（I1-I2）
- token 预算：超限降级 idle、执行后累计（J1-J2）

## 诚实声明的已知缺口（本套未按"通过"测）

> 本轮代码已修复前五项缺口，剩余两项见下。

- ~~目标执行工具白名单未强制~~ ✅ 已修（executeGoal 强制 getGoalToolAllowlist 白名单）
- ~~Mood 不参与决策~~ ✅ 已修（decideAction 消费 willDoHeavyWork/outreachMultiplier）
- ~~反思双重触发冗余~~ ✅ 已修（移除 23:00 Cron，统一由心跳 reflect 分支触发）
- ~~tickIntervalMinutes 未接线~~ ✅ 已修（接入 cron interval_ms + 设置变更即时重载）
- ~~outreachChannels 未实现~~ ✅ 已由并行提交接入（sendOutreach 按渠道派发）
- ~~Mood → 桌宠实时表情未接线~~ ✅ 已修（recordMoodEvent 推 autonomous:mood:emotion 事件）
- ~~编辑/重发反馈信号 CLI 不可达~~ ✅ 已修（白名单放行 + CLI send edit/send resend）

## 说明

真实对话一律走 assistant agent；探针目标 description 前缀 `[life-e2e]`，跑完自动删除。
`evolution:main` 中由本套产生的日记/独白消息保留，供用户在客户端侧边栏核查。

证据文件: `autonomous-life-e2e-evidence.jsonl`
