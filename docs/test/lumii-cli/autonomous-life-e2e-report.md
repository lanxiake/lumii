# 自主进化「心跳与生命感」E2E 测试报告

**执行时间**: 2026-09-06T06:17:00.312Z
**结果**: 11 PASS / 3 FAIL / 6 SKIP（共 20）
**数据库**: `C:\Users\Administrator\.lumii\data\agent-runtime.db`
**驱动方式**: 真实动作（发消息/改设置/cron run/删除）经 lumii-ui CLI，探针播种经 node:sqlite，读取回查 DB 验证落库

## 明细

| 用例 | 结果 | 说明 |
|---|---|---|
| A1 | PASS | settings get 返回全量默认值: 9 字段与 DEFAULT_SETTINGS 一致 |
| A2 | PASS | settings set 部分覆盖不丢默认: 只覆盖 maxOutreachPerDay，其余 8 字段保持默认 |
| A3 | FAIL | 非法值回落默认: 999 应 clamp 到 60: 10 |
| A4 | PASS | maxOutreachPerDay=0 合法边界: 0 被保留，未当非法值回落 |
| C1 | PASS | 空信号 tick → idle（默认路径）: summary="idle" |
| C2 | PASS | 关闭开关 tick → skipped: disabled: summary="skipped: disabled" |
| E1 | FAIL | proactive 目标 → 发送 + 计数 + 完成: last_sent_at 应写入 |
| E2 | FAIL | 最小间隔未到 → 不再发: 间隔未到不应 outreach，实际 "outreach: sent" |
| E3 | PASS | 预算用尽 → 主动消息停发: summary="idle"，计数封顶 20 |
| B2 | PASS | 删除守卫拒绝删除 evolution:main: 拒绝（code=5），会话仍在 |
| D1 | SKIP | 目标执行: LIFEE2E_SKIP_LLM=1 |
| G1 | SKIP | Mood 事件: 依赖 D1（已跳过） |
| J2 | SKIP | token 累计: 依赖 D1（已跳过） |
| J1 | PASS | 预算超限 → 目标执行降级 idle: summary="idle"，未烧 LLM |
| H1 | PASS | 对话中顺带提起牵挂（提一次）: raisedCount=1，nextRaiseAfter 后移，status=open |
| H2 | PASS | 提两次无回应 → dropped: raisedCount=2，status=dropped |
| H3 | PASS | 牵挂只进上下文，不产生通知: outreach 计数仍为 20（牵挂不触达系统通知） |
| F1 | SKIP | 反思定时触发: LIFEE2E_SKIP_LLM=1 |
| I1 | SKIP | 日记生成: LIFEE2E_SKIP_LLM=1 |
| I2 | SKIP | 日记防重: 依赖 I1（已跳过） |

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

- `tickIntervalMinutes` 暴露但未接 cron 实际间隔（仍用常量 10min，见 evolution-tick.ts）
- `outreachChannels` 只走 system 通道，数组设置未分流
- Mood → 桌宠实时表情未接线（moodToPetEmotion 仅纯函数 + AutonomousPage emoji 映射）
- 编辑/重发反馈信号只在前端 UI 触发，CLI 无 edit/resend 子命令

## 说明

真实对话一律走 assistant agent；探针目标 description 前缀 `[life-e2e]`，跑完自动删除。
`evolution:main` 中由本套产生的日记/独白消息保留，供用户在客户端侧边栏核查。

证据文件: `autonomous-life-e2e-evidence.jsonl`
