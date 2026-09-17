# 自主进化 · 主动规划架构设计

> 日期：2026-09-06
> 状态：设计阶段（待确认后进入实施）
> 关联：[[2026-09-06-autonomous-proactive-planning-implementation]]

## 一、设计目标与四条硬约束

用户的愿景是「一个独立自主、有生命意识的智能体，自我进化的评估是它的基础，为了很好地反思和改进」。

本轮明确了四条硬约束，其中第 2-4 条是对当前架构的**方向性修正**：

| # | 约束 | 含义 | 现状 |
|---|---|---|---|
| 1 | 日记一天写一次 | 不是每次心跳都写 | ✅ 已实现（见 §2.1） |
| 2 | 主动规划自己的事情 | Agent 能自建定时任务、自定目标、自定要做的事 | 🔴 未实现，本轮核心 |
| 3 | 心跳是防意外死掉 | 心跳是「保活看门狗」，不是主调度器 | 🟡 当前心跳是主调度器 |
| 4 | 每日预算是自己规划和使用 | 预算内可主动做任何事，是自管理约束而非被动闸门 | 🟡 预算已接线但为被动闸门 |

## 二、现状盘点（基于 2026-09-06 真实 E2E）

三套 CLI 套件 56 例全绿（`cli-suite` 22 + `life-e2e` 23 + `full-e2e` 11），73 次 LLM 调用已捕获。

### 2.1 日记一天一次 —— 已实现

`packages/agent-runtime/src/autonomous/diary.ts`：
- `hasWrittenDiaryToday` 读 `runtime_state` 键 `autonomous.last_diary_date`，等于今日日期键即视为已写。
- `computeDiaryDue = 静默时段 && !hasWrittenDiaryToday`（`tick-signals.ts`）。
- `markDiaryWritten` 写日期键。
- 已由 `run-autonomous-life-e2e.mjs` I1/I2 实测：静默时段首写 → 同日第二次 tick `idle` 不重写。

**本条无需改动**，仅在计划文档中列为「已确认」。

### 2.2 心跳现状 —— 是主调度器，不是保活

`apps/windows/src/main/agent-runtime/evolution-tick.ts`：
- `autonomous-tick` cron 每 `tickIntervalMinutes`（默认 10 分钟）触发一次 `handleEvolutionTick`。
- 每次 tick 走「感知（`collectTickSignals`）→ 决策（`decideAction`）→ 执行一个动作（execute-goal / outreach / reflect / diary / idle）」。
- 即：**心跳在替 Agent 决定「现在该做什么」**。Agent 自己没有「计划」，只有一个被动反应式决策器。

这与约束 3 冲突：心跳应当是「确认 Agent 还活着、没有卡死、没有漏掉已计划的事」，而不是行为的唯一来源。

### 2.3 主动规划现状 —— 缺失

目标（`autonomous_goals`）目前只由**触发**产生：低满意、能力缺口、技能缺口、低效记忆、定时主动消息。没有「Agent 主动规划未来要做的事」这一步，也没有 Agent 自建 cron 任务的能力。

### 2.4 预算现状 —— 是被动闸门

- token 预算（`maxTokensPerDay`）、主动消息预算（`maxOutreachPerDay`）、目标上限（`maxGoalsPerDay`）都已接线。
- 但它们在**执行点**做「超限 → 降级 idle」的被动拦截（`decideAction` 里的 `tokenAllowed`），Agent 并不会「看着剩余预算规划今天怎么花」。

## 三、目标架构：三根柱子

```
            ┌─────────────────────────────────────────┐
            │  心跳 autonomous-tick（保活看门狗）        │
            │  · 健康检查：进程/调度/卡死/漏任务          │
            │  · 派发：到期的自建任务 & 到期目标          │
            │  · 兜底：长时间无规划 → 拉起规划器          │
            └──────────────┬──────────────────────────┘
                           │ 派发「该做的」
                           ▼
        ┌─────────────────────────────────────┐
        │  规划器 Planner（LLM，低频）           │
        │  输入：反思/目标/牵挂/Mood/预算/时间    │
        │  输出：新目标(带时间) + 自建 cron + todo│
        └──────────────┬──────────────────────┘
                       │ 落地
            ┌──────────┴───────────┐
            ▼                      ▼
   autonomous_goals         local_cron_jobs
   (scheduled_for)          (agent-self:*)
```

- **心跳**：从「决策器」降为「保活 + 派发 + 兜底」。
- **规划器**：低频（如每日、或每次反思后），Agent 基于自身状态产出计划并落地为自建任务。
- **预算**：规划器读剩余预算，在执行点继续做硬闸门（双保险），但主视角是「Agent 自己规划预算怎么花」。

## 四、核心设计

### 4.1 心跳重定义（保活看门狗）

`handleEvolutionTick` 的职责改为：

1. **健康检查（liveness）**：无副作用地确认——上次 tick 是否异常退出、是否有 `status='executing'` 却长期未完成的目标（卡死）、规划器是否超期未运行。
2. **派发（dispatch）**：执行「已经计划好、且已到期」的事——`scheduled_for <= now` 的 executing 目标、`next_run_at <= now` 的 `agent-self:*` cron 任务。
3. **兜底（fallback）**：若健康但「没有任何已计划的事」且距上次规划超阈值，拉起规划器补一次规划。

关键：**心跳不再凭空决定做反思/写日记/发消息**。日记由「日期未写 + 静默时段」判定（保留现状即可，本质也是一种「已计划」）；反思/主动消息改为由规划器写入的「计划」驱动，或保留为「静默时段兜底」但不再是唯一入口。

### 4.2 规划器 Planner

**触发**：低频。首选「每次反思之后」（反思产出了「建议」与「建议目标」，正好需要落成计划）；再配「距上次规划满 N 小时」的兜底。静默时段不触发（省钱）。

**输入（喂真实原料，不是只喂数字）**——这里同时解决反思「只喂数字」的问题：
- 最近反思：`primaryIssue` + `rootCause` + `recommendations` + `suggestedGoals`（结构化，不是空泛打分）。
- 当前目标：pending/executing，含 `scheduled_for`。
- 牵挂：`concerns`（open 状态）。
- Mood：energy/valence/arousal（已接线）。
- 预算剩余：今日 token 剩余、主动消息剩余、目标配额剩余。
- 当前时间 + 静默时段。

**输出（结构化 JSON，`parseReflectionOutput` 同款逐级降级解析）**：
```jsonc
{
  "goals": [ { "description": "...", "type": "learning|capability-improvement|...",
               "priority": 0.6, "scheduled_for": "2026-09-07T09:00:00Z" } ],
  "cronJobs": [ { "task": "早上 9 点检索并整理 X 主题的进展",
                  "schedule": "at 09:00" } ],
  "todos": [ "..." ]
}
```

**落地**：
- `goals` → `autonomous_goals`（新增 `scheduled_for`、`planned_by='planner'`），初始状态走既有审批模式（learning/capability 默认 pending 或按 `approvalMode`）。
- `cronJobs` → `local_cron_jobs`（`id='agent-self:<uuid>'`，`agent_id='assistant'`，`task_text`=任务描述，`schedule_type='at'|'every'`，`notify_targets=NULL` 静默）。
- `todos` → 工作记忆（`MemoryManager.addMemory`，category='reference'）或复用 `agent_memories`。

### 4.3 目标带时间（数据模型）

`autonomous_goals` 新增两列（migration V34）：

```sql
ALTER TABLE autonomous_goals ADD COLUMN scheduled_for TEXT;   -- ISO 时间，Agent 计划何时做
ALTER TABLE autonomous_goals ADD COLUMN planned_by TEXT;      -- 'trigger' | 'planner'
```

- `planned_by='trigger'`：保留现有「低满意/能力缺口」等被动触发。
- `planned_by='planner'`：规划器主动排期。
- 心跳的「派发」只挑 `scheduled_for <= now` 且 `status='executing'` 的目标。

### 4.4 预算自管理

- 规划器输入带「剩余预算」，prompt 明确约束：`token 剩余 X / 主动消息剩余 Y / 目标配额剩余 Z，你只能在这个范围内规划`。
- 执行点保留 `tokenAllowed`/`outreach 预算` 硬闸门（**双保险**：即便规划器输出超预算，执行点仍会拦）。
- 主动消息预算仍是跨通道 20/天硬顶，不因「自规划」放开。

### 4.5 安全护栏（自建任务必须防失控）

Agent 自建 cron 任务本质是「自我调度」，必须硬性约束：

1. **任务白名单**：自建任务的 `task_text` 会被 cron 驱动 assistant 执行——必须走既有 `getGoalToolAllowlist` 的**工具白名单**（本轮已确认目标执行已接入 `createInstance(restrictedDef)` + `canSpawnSubAgents:false`）。
2. **数量上限**：`agent-self:*` cron 任务同一时刻最多 N 条（如 20），超限规划器拒绝新增。
3. **禁止自引用**：不允许规划器创建「再规划」的任务（防止规划-规划死循环）。
4. **预算闸门**：自建任务的每次执行同样扣 `recordTokenUsage`。
5. **可一键关停**：`autonomous.enabled=false` 时，自建任务随心跳一并停用（`ensureEvolutionCronJobSeeded` 已按 enabled 控制，自建任务复用同一逻辑）。

### 4.6 工具扩展：给 Agent 更多「系统工具」（约束 5）

当前目标执行的白名单（`goal-executor.ts` 的 `GOAL_EXECUTION_TOOLS`）只有 6 个：`web_search / web_fetch / memory_search / memory_read / memory_add / notify_user`。要「主动做任何事情」，这个工具面太窄。系统实际已暴露 100+ 工具（`tools list`），其中 `cron_create / cron_list / cron_delete` 与 `todo_write` 正好就是「自建定时任务 + 自管待办」所需的现成工具——**主动规划无需新建底层能力，只需放行这些工具**。

按风险分层扩展白名单：

| 层 | 工具 | 说明 |
|---|---|---|
| **T1 无条件（读 + 知识 + 自组织）** | `file_read / list_dir / glob / grep`、`web_search / web_fetch / bing_search`、`memory_search / memory_read / memory_add`、`wiki_overview / wiki_search / wiki_read`、`skill_list / skill_search`、`todo_write`、`cron_list / cron_create / cron_delete`、`notify_user` | 这是「能主动做任何事」的主体：读、学、记忆、排期、记待办 |
| **T2 预算内可写（低风险副作用）** | `file_write / file_edit / file_mkdir / file_move / file_copy`、`dashboard_feed_write` | 允许在受控工作区内产出/整理，仍受 token 预算约束 |
| **T3 高危（默认关，需用户批准或单独授权）** | `bash`、`spawn_agent`、`channel_send / send_message`、`image_generate / speech_generate`、`browser_*`、`app_*`、`mcp__*` | 系统命令、外部触达、子 Agent、UI/浏览器自动化、第三方 MCP，**不放白名单** |

**关键点**：
- `cron_create` 放行后，Agent 规划时可直接 `cron_create` 写 `agent_id='assistant'` 的定时任务（复用 news-pipeline 同款 cron→agent 驱动路径），而非另建一条「规划 JSON → 系统落库」管线。规划器因此可简化：`cron_create` 本身就是规划动作。
- `cron_delete` 同样放行，让 Agent 能撤掉自己已过期的任务；但需约束「只能删 `agent-self:*` 或自己创建的任务」（实现上加 id 前缀守卫）。
- T2/T3 的边界是**安全红线**，扩展只做 T1 + T2，T3 保持关闭（与既有「护栏靠工具白名单」铁律一致）。
- 放行多少工具由**预算**兜底：工具多了，`maxTokensPerDay` / `maxGoalsPerDay` / 主动消息预算仍是硬闸门。

### 4.7 任务错过与恢复（用户不是每天开程序）

用户明确：**程序不是每天都会开启，规划的任务也不是每次都能完成**。这要求调度对「错过 / 逾期 / 失败」必须优雅降级，绝不因错过而卡死或重复轰炸：

- **逾期目标**（`scheduled_for < now` 且仍未执行）：心跳派发时区分「刚逾期（可补做）」与「长期逾期（已失去时效，标记失败或降优先级）」。阈值建议 24h。
- **错过 cron**：app 关闭期间 `next_run_at` 已过，重启后调度器应「过期跳过 + 只补一次」，而非堆积补跑。`interval_ms` 型（every）任务按「距上次运行」续跑，`at` 型任务逾期即弃。
- **目标执行失败**：已由 `finalizeGoal` 落 `failed` + `recordMoodEvent('task_failed')`；规划器下次读「最近 failed 目标」时决定「重试 / 放弃 / 换成更容易的第一步」，而不是无限重试同一件事。
- **规划器兜底触发**：距上次规划超阈值即拉起，即使 app 关闭了几天，重启后第一次 tick 就会补一次规划，把过期计划重新校准到「现在」。

**核心原则**：计划是「意图」不是「承诺」——错过是常态，系统要能自我校准，而不是把逾期任务当成错误硬塞回去。

## 五、与生命感的打通

本轮反射的核心结论之一：**Mood/牵挂/日记不回灌进化**。规划器是打通二者的天然节点：

- 规划器**读 Mood**：energy 低 → 少排重活；valence 低 → 少排主动消息（复用 `moodToDecisionParams`）。
- 规划器**读牵挂**：open 的牵挂若需要「过阵子再看看」，产出 `scheduled_for` 的跟进任务（顺带解决「牵挂只进上下文、不产生行动」的空转）。
- 规划器**读反思的 suggestedConcerns**：反思已顺带识别牵挂，规划器把它们落成可排期的行动。
- **日记保持一天一次**（约束 1），规划器不写日记，日记仍由静默时段 + 未写判定。

## 六、开放问题（需用户拍板）

1. **规划器频率**：建议「每次反思后 + 距上次规划满 24h 兜底」，静默时段跳过。是否接受？
2. **自建 cron 是否真跑 `agent_id='assistant'`**：现有 cron→agent 驱动路径可复用（news-pipeline 同款），但会让 assistant 在规划时间被「唤醒」执行任务。是否接受这种「自己叫醒自己」？
3. **反思是否仍保留「静默时段每日兜底」**：规划器接反思后，反思可改为「由规划器排期」，或保留现状的静默时段兜底 + 规划器排期双入口。倾向后者（渐进，不激进重构）。
4. **todo 落哪**：工作记忆 vs 新表。倾向先复用工作记忆，避免新表。

## 七、不做什么（防过度设计）

- 不做多 Agent 通信总线、动机引擎（已在既有决策中否掉）。
- 不做「Agent 修改自己的系统提示词」（提示词进化仍走 UCB 变体池，不由规划器直写）。
- 不做任意代码生成/技能自动安装（P2 才考虑，且必须用户批准）。
