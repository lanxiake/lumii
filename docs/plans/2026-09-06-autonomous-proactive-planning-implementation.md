# 自主进化 · 主动规划实施计划

> 日期：2026-09-06
> 前置设计：[[2026-09-06-autonomous-proactive-planning-design]]
> 原则：小步快跑，每阶段可独立测试、独立提交。

## 总览

五条需求 → 五个阶段，按依赖顺序推进。阶段 0 无需改动；阶段 1（工具扩展）是阶段 2/4 的地基。

| 阶段 | 需求 | 交付物 | 状态 |
|---|---|---|---|
| 0 | 1 日记一天一次 | 确认已实现 | ✅ 已完成 |
| 1 | 5 更多系统工具 | 分层扩展 `GOAL_EXECUTION_TOOLS` | ✅ 已完成 |
| 2 | 3 心跳 = 保活 | `handleEvolutionTick` 重定义 | 待实施 |
| 3 | 2 目标带时间 | migration V34 + goal 字段 | 待实施 |
| 4 | 2+4 主动规划 + 预算自管 | 规划器 + `cron_create` 放行 | 待实施 |

## 阶段 0：日记一天一次（已确认，不改）

- `hasWrittenDiaryToday` 读 `autonomous.last_diary_date`，`computeDiaryDue` = 静默时段 && 未写。
- 已由 `run-autonomous-life-e2e.mjs` I1/I2 实测通过。
- **验收**：无需改动；回归测试保持 I1/I2 绿。

## 阶段 1：分层扩展工具白名单（✅ 已完成）

**目标**：让 Agent 能「主动做任何事」——读、学、记忆、排期、记待办。

**已改动**：`packages/agent-runtime/src/autonomous/goal-executor.ts` 的 `GOAL_EXECUTION_TOOLS` 从 6 个扩到 T1+T2：

- T1 新增：`bing_search / file_read / list_dir / glob / grep / wiki_overview / wiki_search / wiki_read / skill_list / skill_search / todo_write / cron_list / cron_create`。
- T2 新增（用户已确认开放）：`file_write / file_edit / file_mkdir / file_move / file_copy / dashboard_feed_write`。
- **死名修复**：原 `memory_add`/`notify_user` 在工具注册表中不存在（历史死名），改为真实工具 `memory_manage` / `message`。
- T3（`bash / spawn_agent / channel_send / send_message / image_generate / speech_generate / browser_* / app_* / mcp__*`）**保持排除**；`cron_delete` 暂缓（需 id 守卫，留规划器阶段）。

**验证**：
- 单测：`goal-executor.test.ts` 12 例绿；`agent-runtime` 全量 1725 例绿。
- E2E：`run-autonomous-life-e2e.mjs` 23/23 绿（D1 目标执行在扩展白名单下仍完成）。

**遗留（阶段 4 处理）**：`cron_delete` 的 id 前缀守卫（只允许删 `agent_id='assistant'` 的任务）。

## 阶段 2：心跳重定义为保活看门狗

**目标**：心跳不再凭空决定「该做什么」，只做健康检查 + 派发已计划的事 + 兜底拉起规划。

**改动**：`apps/windows/src/main/agent-runtime/evolution-tick.ts` 的 `handleEvolutionTick`：

1. 保留前置：`isAutonomousEnabled()` / `hasActiveUserTurn()` 跳过。
2. 健康检查：检测「`executing` 目标长期未完成（卡死）」「规划器超期未运行」——记日志，不阻断。
3. 派发：执行 `scheduled_for <= now` 且 `status='executing'` 的目标（阶段 3 落地字段后接入）；到期 `agent-self:*` cron 由 cron 调度器自行驱动（无需心跳代跑）。
4. 兜底：若「无任何已计划的事」且距上次规划超阈值，拉起规划器（阶段 4）。
5. 日记/反思保留现状判定（静默时段 + 未写/满 24h），作为「已计划」之外的兜底，不新增决策分支。

**验收**：
- 单测：`handleEvolutionTick` 各分支——健康+无计划 → `idle: liveness-ok`；有计划到期 → 派发。
- 回归：`run-autonomous-life-e2e.mjs` tick 决策用例（C1/C2/B1）仍绿，语义不变。

## 阶段 3：目标带时间字段（migration V34）

**目标**：区分「被动触发」与「主动排期」的目标，支撑心跳按时间派发。

**改动**：`packages/agent-runtime/src/storage/schema.ts` 追加 V34 并把 `SCHEMA_VERSION` 33→34：

```sql
ALTER TABLE autonomous_goals ADD COLUMN scheduled_for TEXT;   -- ISO 时间，计划何时做
ALTER TABLE autonomous_goals ADD COLUMN planned_by TEXT;      -- 'trigger' | 'planner'
```

- `intrinsic-goal-generator.ts`：既有被动目标 `planned_by='trigger'`、`scheduled_for=NULL`。
- `autonomous-repo.ts` / `autonomous-ipc.ts`：`GoalRow` + `listGoals` 透出两列（可选，供 UI 显示「计划时间」）。
- 心跳派发（阶段 2）查询条件：`status='executing' AND scheduled_for IS NOT NULL AND scheduled_for <= now`。

**验收**：
- 单测：迁移后 `PRAGMA table_info(autonomous_goals)` 含两列；`SCHEMA_VERSION === 34`。
- 回归：三套 CLI 套件仍绿（新增列不影响既有 SELECT）。

## 阶段 4：主动规划 + 预算自管理

**目标**：Agent 低频产出计划，直接落地为自建 cron 任务 + 目标 + 待办；预算读进规划上下文。

**改动**：

1. **规划器 `Planner`**（`packages/agent-runtime/src/autonomous/planner.ts`，纯逻辑可测）：
   - 输入：反思（`primaryIssue/rootCause/recommendations/suggestedGoals`）、当前目标、牵挂、Mood、剩余预算、时间 + 静默时段。
   - 输出：结构化计划（复用 `parseReflectionOutput` 逐级降级解析）：
     ```jsonc
     { "goals": [{"description":"...","type":"learning","scheduled_for":"...","priority":0.6}],
       "cronJobs": [{"task":"...","schedule":"at 09:00"}],
       "todos": ["..."] }
     ```
   - **提示词喂真实原料**：不再只喂满意度数字，而是把「哪次失败、哪个工具、用户怎么打断」的摘要拼进去（一并解决反思「只喂数字」的问题）。
2. **规划落地**（wiring 层）：
   - `goals` → `autonomous_goals`（`scheduled_for` + `planned_by='planner'`），走既有审批模式。
   - `cronJobs` → 复用 `cron_create` 工具（或 wiring 直写 `local_cron_jobs`，`id='agent-self:<uuid>'`、`agent_id='assistant'`、`notify_targets=NULL` 静默）。
   - `todos` → `todo_write` / 工作记忆。
3. **预算自管理**：
   - 规划器 prompt 注入「今日 token 剩余 X / 主动消息剩余 Y / 目标配额剩余 Z，只能在此范围内规划」。
   - 执行点保留 `tokenAllowed` 硬闸门（双保险）。
   - 自建 cron 上限 N（如 20），超限拒绝新增。

**触发**：每次反思后 + 距上次规划满 24h 兜底（静默时段跳过）。

**验收**：
- 单测：`planner` 纯函数——输入含预算，输出目标数不超配额；`parseReflectionOutput` 对脏 JSON 降级不抛。
- E2E（新增 `run-autonomous-planning-e2e.mjs` 或扩展 life-e2e）：规划器跑一次 → `agent-self:*` cron 落库、`planned_by='planner'` 目标落库、todo 落库；预算超限时目标数受限；`cron_delete` 删非 `agent-self:*` 被拒。

## 回归与发布门槛

- 每个阶段：`pnpm --filter @mtbot/agent-runtime typecheck` + 相关单测 + 对应 E2E 绿。
- 阶段 3 起每次改主进程/migration 后**重启应用**（`stop-dev.ps1 -KillAllElectron` → `start-dev.ps1`），单实例锁需清干净。
- 全部落地后重跑三套 CLI 套件 + 新增 planning E2E，全绿方可收尾。

## 风险与开放问题（实施前需确认）

1. 规划器频率：建议「反思后 + 24h 兜底」，静默时段跳过——需确认。
2. 自建 cron 是否真跑 `agent_id='assistant'`（自己叫醒自己）——需确认。
3. T2 写类工具本期是否放开，还是先只放 T1——需确认（倾向先 T1，写类后置）。
4. todo 落工作记忆 vs 新表——倾向先 `todo_write` 工具 + 工作记忆。
