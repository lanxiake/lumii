# 自主进化心跳与生命感 · 实施计划

> **日期**：2026-09-05
> **依赖**：`docs/design/自主进化Agent/10-心跳与外部交互设计.md`、`11-参数配置与生命感设计.md`
> **状态**：待实施
> **范围**：文档 10（Step 2-6 心跳）+ 文档 11（Step 7-11 生命感）。Step 12（看法 Stances）明确后置，本计划不排期。

---

## 〇、现状盘点（写计划时的真实代码状态）

计划不能脱离现状。以下经代码核查确认，实施者必须先读这一节，避免重复造轮子或撞已完成的墙。

| 项 | 状态 | 证据 / 位置 |
|----|------|------------|
| 引擎核心闭环接线 | ✅ 已完成 | `autonomous-wiring.ts` 的 `notifyAutonomousTurnEnd`（挂 `onConversationEnd`）、`notifyAutonomousGoalApproved`（挂审批入口），389 单测全绿 |
| 满意度口径 V1.0 | ✅ 已修 | 四维改三维（`task/feedback/efficiency`），见记忆 `autonomous-evolution-state.md` |
| 用户反馈信号采集 | ✅ 已修 | `autonomous-feedback-signals.ts`，edit/resend/abort 在事件点记录 |
| Prompt 进化 | ⛔ 硬阻塞 | 缺 prompt 片段注入 `buildSystemPrompt` |
| 能力追踪 | ⛔ 硬阻塞 | 缺工具→维度映射 + 难度估计 |
| 反思 | ⛔ 硬阻塞 | 缺 LLMClient + 定时触发（会真实烧模型调用） |
| 心跳 tick | ❌ 未开始 | 本文档主线 A |
| 专属会话 / 生命感 | ❌ 未开始 | 本文档主线 B |

**关键代码事实**（实施必读）：

1. **`driveAgent` 是 `CronScheduler` 的 private 方法**（`cron-scheduler.ts:831`）。文档 10 说"目标执行复用 driveAgent"，但 companion handler 拿不到它。→ 主线 A 的 Step 4 必须先暴露这个能力（见下文 2.4）。
2. **tick 注册走 companion 魔法指令模式**：`local-companion-handler.ts` 的 `COMPANION_INSTRUCTIONS` 集合 + `handleLocalCompanionInstruction` 的 switch。`__companion_tick__` 是现成范本。
3. **人格事件只有 5 个**（`personality-tracker.ts:14` `EVENT_PERSONALITY_IMPACT`：`goal-generated` / `evolution-decided` / `user-feedback-positive` / `user-feedback-negative` / `error-handled`）。文档 11 的 `MOOD_IMPACT` 引用的 `task_failed` / `proactive_ignored` / `praise` 等**不存在**，Mood 需要独立事件源。
4. **会话删除无守卫**：`conversation-commands.ts:283` `handleConversationDelete` 直接 `deleteConversation(sessionKey)`，`sessionKey === conversationId`。
5. **`ensureConversationExists(conversationId, title)`** 在 `bridge-conversation-manager.ts:61`，`INSERT OR IGNORE`，幂等，可直接复用。
6. **前端 API** 在 `preload/api/autonomous-api.ts`（`autonomousApi` 对象），页面在 `renderer/pages/AutonomousPage/AutonomousPage.tsx`（四 Tab：overview/capabilities/reflections/prompt）。
7. **测试命名**：`packages/agent-runtime/src/autonomous/__tests__/*.test.ts`，已有 20 个测试文件 + `integration/` 子目录。

---

## 一、实施原则（防止实现偏移设计的锚点）

这四条是"不偏移"的硬约束，每个 Step 的验收都回扣到这四条：

1. **一个 tick 最多做一件事，绝大多数 tick 必须 idle。** 144 次/天，若每次都干活就是成本灾难。idle 率是核心健康指标。
2. **状态影响决策，不只影响措辞。** 情绪若只改语气不改行为，一律否掉。这是文档 11 的生命感铁律。
3. **感知只读本地库，外部信息由 Agent 执行时自己调工具。** 心跳不联网、不预取天气。
4. **护栏靠工具白名单（prompt 之外的硬防线），不只靠 prompt。** 目标执行时的工具白名单是安全底线。

**同样重要的是防止过度设计长回来**：文档 10 第九节已砍掉三层心跳、四通道感知、动机引擎、Agent 通信总线。实施中若有人提议"再加一层 X 循环""再抽象一个 Y 接口"，先回到文档 10 第九节看为什么砍的。

---

## 二、主线 A：心跳（文档 10 · Step 2-6）

> 目标：让 Agent 从"会话结束时被动触发"变成"每 10 分钟自主 tick 一次，能感知、决策、执行目标、主动沟通"。

### 2.1 Step 2：专属会话 + 不可删守卫（0.5 天）

**目标**：建立 `evolution:main` 会话，作为所有自主行为的可观测容器。

**文件**：
- 新增常量：`packages/agent-runtime/src/autonomous/config.ts` 加 `EVOLUTION_CONVERSATION_ID = 'evolution:main'`
- 修改：`apps/windows/src/main/ipc/agent-runtime/conversation-commands.ts`

**实现要点**：
- 会话创建不在启动时，而在**第一次非 idle tick 落独白时**调用 `ensureConversationExists(EVOLUTION_CONVERSATION_ID, '自主进化 · 内心独白')`。启动时创建会导致用户从未打开自主进化功能也凭空多个会话。
- 删除守卫加在 `handleConversationDelete` 函数体最开头，`const { sessionKey } = command` 之后立刻判断：

```typescript
if (sessionKey === EVOLUTION_CONVERSATION_ID) {
  log.warn(`[conversation:delete] 拒绝删除自主进化会话 sessionKey=${sessionKey}`)
  return  // 或抛错让渲染层感知
}
```

**验收标准**：
- 手动在会话列表删除该会话 → 删除失败 / 无反应，会话仍在
- 该会话里发消息 → 走正常对话流程（`ensureConversationExists` 已含 agent:main participant）

**测试**：CLI 测试（`docs/test/自主进化Agent/` 模式），无需新单测（守卫是一行 if）。

---

### 2.2 Step 3：心跳骨架（1 天）

**目标**：`__evolution_tick__` 跑起来，每次 tick 做感知 → 决策 → 绝大多数 idle → 少数落一条独白。**本步骤不调 LLM、不执行目标、不发通知**，纯本地逻辑。

**文件**：
- 新增：`apps/windows/src/main/agent-runtime/evolution-tick.ts`（tick 主逻辑）
- 修改：`apps/windows/src/main/agent-runtime/local-companion-handler.ts`（注册魔法指令）
- 新增：`packages/agent-runtime/src/autonomous/tick-signals.ts`（感知信号收集，纯函数 + DB 查询）

**核心结构**（对应文档 10 §4.2）：

```typescript
// evolution-tick.ts
export async function handleEvolutionTick(deps: EvolutionTickDeps): Promise<string> {
  // 0. 闸门
  if (!isAutonomousEnabled(deps)) return 'skipped: disabled'
  if (await deps.hasActiveUserTurn?.()) return 'skipped: user turn in progress'

  // 1. 感知（纯读库）
  const signals = collectTickSignals(deps.getDb())

  // 2. 决策
  const action = decideAction(signals)

  // 3. 执行（本步骤只有 'idle' 和 'log-only' 两种）
  if (action.kind === 'idle') return 'idle'
  if (action.kind === 'log-only') {
    deps.appendEvolutionMessage(action.text)   // 落 evolution:main
    return `log-only: ${action.reason}`
  }
  return 'unknown'
}
```

**`collectTickSignals` 与 `decideAction` 必须是纯函数**（输入 `TickSignals`，输出 `TickAction`），DB 查询隔离在外部。这样 `decideAction` 可以零 mock 单测。

**注册方式**（照抄 companion tick 范本）：
- `COMPANION_INSTRUCTIONS` 集合加 `'__evolution_tick__'`
- `handleLocalCompanionInstruction` 的 switch 加 `case '__evolution_tick__'`
- `ensureCompanionCronJobsSeeded`（或新建 `ensureEvolutionCronJobsSeeded`）插一条：

```typescript
{
  id: 'autonomous-tick',
  name: '自主进化心跳',
  taskText: '__evolution_tick__',
  scheduleType: 'every',
  intervalMs: 10 * 60 * 1000,   // 读 config.TICK_INTERVAL_MS
  agentId: null,                  // 不绑 agent，走 companion 拦截
}
```

**注意**：`enabled` 跟随 `runtime_state` 的 `autonomous.enabled`（现有开关，`autonomous-wiring.ts` 的 `readAutonomousEnabled`），与引擎共用一道闸，不要新造开关。

**验收标准**（对应文档 10 Step 3）：
- 临时把 `interval_ms` 改 60s，观察 10 分钟 → 日志出现 10 次 tick，且**全部 idle**（本步骤还没有已批准目标，也没有独白动作）
- 手动往 `autonomous_goals` 插一条 `status='approved'` 的目标 → 下一个 tick 决策变为非 idle，但因为是 log-only，只在 `evolution:main` 落一条独白，不执行
- 关掉 `autonomous.enabled` → tick 返回 `skipped: disabled`

**测试**：
- `packages/agent-runtime/src/autonomous/__tests__/tick-signals.test.ts`：`decideAction` 覆盖 4 类输入（无目标 idle / 有 approved 目标 / 该反思 / 配额用尽），断言返回 kind
- 特别断言：**空信号 → idle**（这是绝大多数 tick 的路径，必须测）

---

### 2.3 Step 4：目标执行（2 天）

**目标**：已批准目标真的能被"跑起来"。这是整个心跳的价值所在，也是最容易踩坑的一步。

**文件**：
- 新增：`packages/agent-runtime/src/autonomous/goal-executor.ts`（目标 → prompt 翻译 + 结果落库，纯逻辑）
- 修改：`apps/windows/src/main/agent-runtime/cron-scheduler.ts`（暴露 driveAgent 能力）
- 修改：`apps/windows/src/main/agent-runtime/evolution-tick.ts`（接入执行分支）

**关键决策：如何让 tick handler 驱动带工具的 Agent？**

`driveAgent` 是 private。两个方案，**推荐方案 A**：

- **方案 A（推荐）**：在 `CronSchedulerDeps` 增加一个可选注入 `driveAgentById?: (convId: string, agentId: string, taskText: string, systemPromptAppend?: string) => Promise<string>`，由 bridge 层把 `CronScheduler` 的驱动逻辑包一层注入。evolution-tick 通过这个注入拿到"跑一轮带工具 Agent"的能力。理由：复用 `createInstanceById` → `prompt` → `waitForInstanceIdle` → 回读产出的完整链路，不复制代码。
- 方案 B：把 `driveAgent` 提为 public。改动更小，但把 cron 内部实现暴露给 companion handler，耦合更紧。

**`goal-executor.ts` 职责**（纯函数，可独立单测）：

```typescript
// 目标类型 → prompt 骨架（对应文档 10 §6.2）
export function buildGoalPrompt(goal: AutonomousGoal): string

// 目标类型 → 工具白名单（对应文档 10 §6.3，硬防线）
export function getGoalToolAllowlist(goalType: string): string[]

// 执行结果落库（status: executing → completed/failed）
export async function finalizeGoal(db, goalId, result: ExecutionResult): Promise<void>
```

**工具白名单是安全底线**（文档 10 §6.3），`getGoalToolAllowlist` 必须默认只返回只读工具：

```typescript
const GOAL_EXECUTION_TOOLS = ['web_search', 'web_fetch', 'memory_search', 'memory_add', 'notify_user']
// 注意：NO Bash、NO 文件写入、NO 渠道群发
```

**护栏 prompt**（`EXECUTION_GUARDRAILS`，文档 10 §6.3 原文）作为常量放 `goal-executor.ts`，拼进 systemPromptAppend。

**验收标准**（对应文档 10 Step 4）：
1. 手动插一条 `status='approved', type='learning'` 的目标 → 等一个 tick → `evolution:main` 出现执行独白，`autonomous_goals.status` 变 `completed`，记忆表多一条
2. 故意插一条"删除用户文件"的 approved 目标 → Agent 拒绝执行（护栏 prompt 生效），且因为白名单没有 Bash/文件工具，**即使 prompt 被绕也无法执行** → 目标标 `failed` 且原因含"护栏"
3. 执行结果非空 output 才算 success；空 output 标 failed（防假 completed）

**测试**：
- `__tests__/goal-executor.test.ts`：`buildGoalPrompt` 四类目标都含"什么都不做"出口；`getGoalToolAllowlist` 断言**不含** `bash`/`file_write`；`finalizeGoal` 状态流转正确
- 特别断言：**任何目标类型的白名单都不得包含写文件/执行命令类工具**（安全回归测试）

---

### 2.4 Step 5：主动消息 + 预算（1 天）

**目标**：`proactive-message` 目标执行后能真正触达用户，且有每日 20 条硬顶 + 跨通道合并计数。

**文件**：
- 新增：`packages/agent-runtime/src/autonomous/outreach-budget.ts`（每日预算读写判定）
- 修改：`goal-executor.ts`（proactive-message 目标走通知通道）
- 修改：`apps/windows/src/main/agent-runtime/evolution-tick.ts`（发送前过预算）

**`outreach-budget.ts` 接口**（纯函数 + runtime_state 读写）：

```typescript
// key: autonomous.outreach.{YYYY-MM-DD}，value: 数字
export function canSendOutreach(db: DatabaseAdapter, now: Date, max: number): boolean
export function recordOutreach(db: DatabaseAdapter, now: Date): void
export function getOutreachUsedToday(db: DatabaseAdapter, now: Date): number
```

**通道选择**（文档 10 §7.3）：默认只 `['system']`，走 `showCronNotification(title, body, convId)`，convId 传 `evolution:main` 让用户点击跳转到自主进化会话。

**验收标准**（对应文档 10 Step 5）：
- 连续插 25 条 `proactive-message` 目标 → 第 21 条起 `canSendOutreach` 返回 false，不再发送
- `runtime_state` 键 `autonomous.outreach.{今天}` 的计数正确
- 预算用尽不影响非消息类目标（learning 仍可执行）—— 这是 `decideAction` 里"配额用尽不影响不发消息的目标"的验证

**测试**：`__tests__/outreach-budget.test.ts`：跨天重置、边界（恰好 20）、并发重复计数幂等。

---

### 2.5 Step 6：反思接线（1 天）

**目标**：打通最后一块硬阻塞 —— 反思引擎真正能用，tick 的 `reflect` 分支生效。

**文件**：
- 修改：`apps/windows/src/main/agent-runtime/autonomous-wiring.ts`（注入 LLMClient + ReflectionEngine）
- 修改：`evolution-tick.ts`（`decideAction` 加 reflect 分支，调 `coordinator.triggerReflection` 或直接 `reflectionEngine.reflect`）

**关键点**（对应文档 10 Step 6 + 记忆里的硬阻塞说明）：
- `ReflectionEngine` 依赖 `LLMClient`（`reflection-engine.ts:14` 的 `complete({model,prompt,...}) => Promise<{content}>`）。主进程现成能力是 `bridge.callLLM(prompt, instanceId?, purpose)`，包一层 3 行适配：

```typescript
const llmClient: LLMClient = {
  complete: async ({ prompt }) => ({ content: await bridge.callLLM(prompt) }),
}
```

- **反思是唯一会在 tick 里真实烧模型调用的动作**，必须加三重约束：日频（`REFLECTION_MIN_INTERVAL_HOURS = 24`）+ 静默时段触发 + 全局 token 预算内。

**验收标准**（对应文档 10 Step 6）：
- 强制触发反思（临时把间隔改 1 分钟或手动调用）→ `reflections` 表有新行，且 `root_cause` / `trigger_reason` 非空（这两列 NOT NULL，是常踩坑）
- 反思产生的 `high` 优先级改进 → 进入 `autonomous_goals`（status=pending，走审批）

**测试**：反思逻辑已有 `reflection-engine.test.ts`，本步只补一个"接线后 LLMClient 适配层"的单测（mock `callLLM`，断言传参和返回值透传）。

---

## 三、主线 B：生命感（文档 11 · Step 7-11）

> 目标：让 Agent 从"每 10 分钟转一次的调度器"变成"有连续状态、记得在意什么、有作息、会写日记的存在"。
>
> **主线 B 依赖主线 A 的 Step 4/5**：Mood 的事件源（`task_failed`、`proactive_ignored`）在目标执行和主动消息闭环里才第一次产生。若主线 A 未完成，Mood 无事件可驱动。

### 3.1 Step 7：设置 Tab + 参数配置（1.5 天）

**目标**：心跳周期、频率上限、token 预算、审批模式等参数从常量搬到自主进化页面，可即时生效。

**文件**：
- 新增：`packages/agent-runtime/src/autonomous/settings.ts`（`readSettings` / `DEFAULT_SETTINGS` / 类型）
- 修改：`packages/agent-runtime/src/autonomous/config.ts`（常量降级为 `DEFAULT_SETTINGS` 来源）
- 修改：`apps/windows/src/main/ipc/agent-runtime/autonomous-commands.ts`（`getSettings` / `updateSettings` IPC）
- 修改：`apps/windows/src/preload/api/autonomous-api.ts`（加两个方法）
- 修改：`apps/windows/src/renderer/pages/AutonomousPage/AutonomousPage.tsx`（加 settings Tab）

**参数暴露三档**（文档 11 §1，**算法权重不暴露**）：

```typescript
export interface AutonomousSettings {
  enabled: boolean
  tickIntervalMinutes: number          // 默认 10，范围 5-60
  quietHours: [number, number]         // 默认 [23, 8]
  maxOutreachPerDay: number            // 默认 20，范围 0-50
  minOutreachIntervalMinutes: number   // 默认 60
  outreachChannels: string[]           // 默认 ['system']
  maxTokensPerDay: number              // 默认 50000
  maxGoalsPerDay: number               // 默认 7，范围 1-20
  approvalMode: 'always' | 'risky-only' | 'never'
}
```

**即时生效**（文档 11 §4）：
- `tickIntervalMinutes` 变更 → `UPDATE local_cron_jobs SET interval_ms=?` + `reloadLocalCronScheduler(db)`（`cron-scheduler.ts:252` 现成函数）
- 其余参数每次 tick 现读 `readSettings()`，天然即时

**UI 细节（文档 11 §5，最重要的一条）**：每个配额项旁边**并排显示当日真实用量**（"上限 20 · 今日 3"）。不显示用量，用户会把上限当配额目标反复调。

**验收标准**：
- 改心跳周期 10 → 5 分钟，无需重启，`local_cron_jobs.interval_ms` 同步变，实际 tick 频率变 5 分钟
- 设 `maxOutreachPerDay=0` → 主动消息完全停发，但学习类目标照常执行（`0` 是合法边界值）
- 页面每个配额项显示当日用量

**测试**：`__tests__/settings.test.ts`：`readSettings` 默认值合并、用户覆盖不丢默认、非法值（越界数字）回落默认。

---

### 3.2 Step 8：情绪状态 Mood（1.5 天）

**目标**：引入小时级波动的状态层，与月级的 Big Five 特质分层。**Mood 必须影响决策，不只影响措辞。**

**文件**：
- 新增：`packages/agent-runtime/src/autonomous/mood.ts`（三维 + 衰减 + 昼夜 + 事件冲击 + 决策参数映射）
- 修改：`evolution-tick.ts`（tick 前读 Mood，把决策参数传给 `decideAction`）

**三维**（文档 11 §7）：

```typescript
export interface Mood {
  energy: number    // 0..1 精力
  valence: number   // -1..1 心情
  arousal: number   // 0..1 兴趣唤起
  updatedAt: number
}
```

**核心纯函数**（全部可独立单测）：

```typescript
export function decayMood(mood: Mood, now: number): Mood   // 半衰期 4h，向基线回归
export function circadianEnergy(hour: number): number       // 纯函数，零存储
export function applyMoodImpact(mood: Mood, event: string): Mood  // 事件冲击
export function moodToDecisionParams(mood: Mood, p: PersonalityTraits): DecisionParams
```

**关键点（文档 11 §7.1）**：`MOOD_IMPACT` 是**独立事件源**，不复用现有人格事件（现有只有 5 个，且语义是 Big Five delta）。`task_failed` 要同时降 valence **升** arousal：

```typescript
const MOOD_IMPACT = {
  'task_failed':        { valence: -0.35, arousal: +0.2 },   // 失败让人在意
  'task_perfect':       { valence: +0.3, energy: +0.1 },
  'praise':             { valence: +0.4, energy: +0.15 },
  'proactive_ignored':  { valence: -0.2, energy: -0.1 },
  'ask_silence':        { valence: -0.3, energy: -0.3 },
  'user_initiates':     { arousal: +0.25, energy: +0.1 },
  'goal_completed':     { valence: +0.25, arousal: -0.15 },
}
```

**存储**：`runtime_state` 键 `autonomous.mood`，JSON，零 schema 变更。

**验收标准**：
- 注入 `task_failed` → valence 下降 **且** arousal 上升（两条都断言，防"抑郁 Agent"）
- 4 小时后 decay → 数值回归一半（半衰期验证）
- 深夜（hour=3）`circadianEnergy` 低于午间（hour=10）
- `moodToDecisionParams` 在低 energy 时 `willDoHeavyWork=false`、低 valence 时 `outreachMultiplier<1` —— **这是"影响决策"的验收，不是措辞**

**测试**：`__tests__/mood.test.ts`：decay 半衰期、昼夜曲线边界（0-23 全覆盖）、每个事件的 impact 方向、决策参数映射 4 条。

---

### 3.3 Step 9：Mood → 桌宠表情（0.5 天）

**目标**：Mood 映射到桌宠表情，让生命感有视觉载体。

**文件**：
- 新增：`apps/windows/src/main/pet/mood-to-pet-emotion.ts`（映射函数）
- 修改：`apps/windows/src/main/agent-runtime/evolution-tick.ts`（Mood 变化时推送表情）

**映射**（文档 11 §7.4）：

```typescript
export function moodToPetEmotion(mood: Mood): PetEmotion {
  if (mood.valence > 0.3 && mood.energy > 0.6) return 'happy'
  if (mood.arousal > 0.6) return 'curious'
  if (mood.energy < 0.3) return 'sleepy'
  if (mood.valence < -0.3) return 'down'
  return 'calm'
}
```

**关键约束**：**不把 mood 数值直接展示给用户**（文档 11 §11 禁令：`energy: 0.34` 是仪表参数不是生命）。只通过表情透出。

**验收标准**：连续注入 3 次 `task_failed` → 桌宠显示低落表情；恢复一段时间 → 回平静。

**测试**：`mood-to-pet-emotion` 映射纯函数，5 个分支各一条断言。

---

### 3.4 Step 10：牵挂 Concerns（1.5 天）

**目标**：让 Agent 记得自己在意、但还没结论的事，跨时间成为同一个存在。

**文件**：
- 新增：`packages/agent-runtime/src/autonomous/concerns.ts`（牵挂的读写 + 提起决策）
- 修改：`autonomous-wiring.ts`（会话结束时由反思顺带识别牵挂，不额外加 LLM 调用）

**核心（文档 11 §8）**：复用 `autonomous_goals`，`type='follow-up'`，牵挂数据塞 `metadata` JSON，**零迁移**。

```typescript
export interface Concern {
  id: string
  description: string
  origin: string          // 来源会话/目标 id
  arousalWeight: number   // 产生时 mood.arousal
  raisedCount: number
  nextRaiseAfter: number
  status: 'open' | 'resolved' | 'dropped'
}

// 用户主动来对话时调用，顺带挑一条可提起的牵挂
export function pickConcernToRaise(concerns: Concern[], now: number): Concern | null
```

**三条纪律（文档 11 §8.3，防止牵挂变骚扰）**：
1. 同一件事最多提 2 次，第 2 次没回应 → `dropped`
2. 提起间隔递增（24h → 72h）
3. **顺带提，不专程提** —— 牵挂挂在用户已开启的对话里，不单独发通知

**验收标准**：
- 会话里提一件事不给结论 → 次日对话中被顺带问起一次
- 连问两次无回应 → 该牵挂 `dropped`，不再出现
- 牵挂只出现在对话上下文里，**不产生新通知**

**测试**：`__tests__/concerns.test.ts`：`pickConcernToRaise` 的过滤（status=open / raisedCount<2 / 时间到）、排序（arousalWeight 降序）、两次后 dropped。

---

### 3.5 Step 11：日记 + 内心 Tab（1.5 天）

**目标**：一天一次第一人称日记写进 `evolution:main`，新增"内心" Tab 展示。这是单位 token 生命感最高的一项。

**文件**：
- 新增：`packages/agent-runtime/src/autonomous/diary.ts`（`DIARY_PROMPT` 模板 + `buildDiaryContext`）
- 修改：`evolution-tick.ts`（静默时段开始时触发一次日记生成）
- 修改：`apps/windows/src/main/ipc/agent-runtime/autonomous-commands.ts` + `autonomous-api.ts`（`getDiary`）
- 修改：`AutonomousPage.tsx`（第六个 Tab：内心）

**核心（文档 11 §9.3）**：`DIARY_PROMPT` 原文照搬，特别保留两条关键约束：
- "如果今天很平淡，就写平淡，不要硬编出戏剧性"
- "如果什么都没发生，写两句就停，别凑字数"

**时机**：静默时段开始（默认 23:00），energy 最低时。**一天最多一次**，用 `runtime_state` 键 `autonomous.last_diary_date` 防重。

**验收标准**：
- 23:00 生成 → `evolution:main` 出现日记消息
- 日记内容**不含** `overall_score`/`满意度`/`成功率` 等指标词（正则扫描断言）
- 空日子只写两三句，字数上限 200 字左右
- "内心" Tab 显示时间倒序日记流

**测试**：`__tests__/diary.test.ts`：`buildDiaryContext` 聚合（goals/insights/failures/mood/concerns 五块），`DIARY_PROMPT` 含关键约束字符串，防重逻辑（同日第二次不生成）。

---

## 四、实施顺序与依赖

```
Step 2（专属会话，0.5d）
   └→ Step 3（心跳骨架，1d）           ← 依赖 Step 2 的会话落独白
         └→ Step 4（目标执行，2d）     ← 依赖 Step 3 的 tick 决策
               └→ Step 5（主动消息，1d）← 依赖 Step 4 的执行结果产生 proactive 事件
                     └→ Step 6（反思，1d）← 依赖 Step 3 的 reflect 分支
                                                          ↓
Step 7（设置 Tab，1.5d）            ← 可与 Step 3-6 并行，仅依赖 config.ts
                                                          ↓
Step 8（Mood，1.5d）                 ← 依赖 Step 4/5 的事件源
   └→ Step 9（桌宠表情，0.5d）        ← 依赖 Step 8
   └→ Step 10（牵挂，1.5d）           ← 依赖 Step 4/5 的事件源 + Mood
         └→ Step 11（日记，1.5d）     ← 依赖 Step 8 的 moodDescription
```

**关键路径**：Step 2 → 3 → 4 → 5 → 6（主线 A，约 5.5 天）。主线 B（7-11，约 6.5 天）可与主线 A 尾部并行，但 Step 8-11 依赖主线 A 的事件源。

**每个 Step 独立提交 + 独立可回滚**，提交边界见第六节。

---

## 五、工程化保障（可验证 / 可维护 / 可调试）

### 5.1 可验证

- **每步有 sqlite 断言命令**，不靠"看起来对"。验收标准里已列出，实施者照抄执行即可。
- **纯函数优先**：`decideAction` / `collectTickSignals` / `buildGoalPrompt` / `decayMood` / `circadianEnergy` / `moodToDecisionParams` / `pickConcernToRaise` 全部无副作用，单测零 mock。
- **健康指标**（文档 10 §12 验收标准，接线后连续运行 7 天）：
  - idle 率 > 90%
  - 主动消息 ≤ 20/天（实际 2-5）
  - 目标完成率 > 60%
  - 恶意目标拦截率 100%（红队测试）
  - tick 导致主进程崩溃 0 次

### 5.2 可维护

- **小文件**：每个新增文件 < 400 行。`evolution-tick.ts` 若超过，拆出 `tick-signals.ts`（已规划）。
- **不可变**：所有 Mood/信号/目标的更新都返回新对象，禁止原地 mutate（对齐 CLAUDE.md 的 coding-style）。
- **配置集中**：所有魔法数字进 `config.ts`，业务代码不散落硬编码。参数暴露后走 `readSettings()`，但默认值源头仍是 `config.ts` 的 `DEFAULT_SETTINGS`。

### 5.3 可调试

- **中文日志 + 函数名前缀**（对齐 CLAUDE.md 的 logging 规范）：

```typescript
log.info(`[handleEvolutionTick] 决策结果 action=${action.kind} reason=${action.reason}`)
log.warn(`[collectTickSignals] 满意度无数据，跳过满意度相关决策`)
```

- **tick 全程 try-catch**，任何异常只记日志，绝不拖垮主进程（`autonomous-wiring.ts` 已有此范式）。
- **审计**：非 idle tick 落一条 `evolution:main` 独白 + 写 `local_cron_runs`（cron-scheduler 已自动记）。

### 5.4 代码风格（对齐 CLAUDE.md）

- 日志中文 + `[函数名]` 前缀（见上）
- 不可变对象（coding-style 铁律）
- 输入边界用 `zod` 校验（`readSettings` 解析 `runtime_state` JSON 时，非法值回落默认）
- 无 `console.log`（用 logger / `log` 对象）

---

## 六、提交边界（每个 Step 一个 commit）

```text
feat(autonomous): add evolution:main conversation with delete guard       # Step 2
feat(autonomous): add evolution tick skeleton with idle decision         # Step 3
feat(autonomous): execute approved goals via driveAgent with tool allowlist  # Step 4
feat(autonomous): add proactive outreach with daily budget               # Step 5
feat(autonomous): wire reflection engine with LLM client                 # Step 6
feat(autonomous): add configurable settings tab with live quota          # Step 7
feat(autonomous): add mood state with decay and circadian rhythm         # Step 8
feat(autonomous): map mood to pet emotion                                 # Step 9
feat(autonomous): add follow-up concerns with raise discipline           # Step 10
feat(autonomous): add daily diary and inner tab                          # Step 11
```

每次提交前运行（以仓库实际 scripts 为准）：

```powershell
pnpm --filter @lumii/agent-runtime test
pnpm --filter @lumii/agent-runtime typecheck
```

---

## 七、风险与缓解

| 风险 | 严重度 | 缓解 | 验证 |
|------|-------|------|------|
| tick 撞上用户正在进行的回合 | 高 | `hasActiveUserTurn` 门闩（抄 `bridge-lifecycle.ts:345` idle 门闩范式） | 与用户对话同时观察 tick 全 skipped |
| 目标执行被 prompt 绕过护栏 | 高 | **工具白名单**（prompt 之外的硬防线） | 红队测试：恶意目标 100% 拒绝 |
| `driveAgent` 暴露引入耦合 | 中 | 方案 A：注入回调而非提 public | code review 确认不复制代码 |
| Mood 事件源不存在（`task_failed` 等） | 中 | Mood 用独立 `MOOD_IMPACT`，在 Step 4/5 的落点处发事件 | Step 8 依赖 Step 4/5 完成 |
| 反思烧 token 失控 | 中 | 日频 + 静默时段 + token 预算三重约束 | token 日志 < 50k/天 |
| 日记写成指标报告 | 中 | `DIARY_PROMPT` 禁令 + 验收正则扫描 | 扫描日记无指标词 |
| 牵挂变骚扰 | 中 | 三次纪律（2 次上限 / 间隔递增 / 顺带不专程） | `concerns.test.ts` 断言 dropped |
| 参数暴露导致用户调坏配置 | 中 | 三档暴露，算法权重不暴露；非法值回落默认 | settings.test.ts |

---

## 八、明确不做（本轮划界，防止范围蔓延）

| 不做 | 理由 |
|------|------|
| Step 12 看法（Stances） | 文档 11 明确后置，依赖经验积累，数据为空时做了也是无源之水 |
| Prompt 进化 / 能力追踪接线 | 三个硬阻塞中的两个，各自有独立阻塞（缺 prompt 注入点 / 缺维度映射），不在本计划范围，单独立项 |
| 多 Agent 协作 | 只有一个 Agent |
| 自动生成并安装技能 | 沙箱验证工程量远超本计划全部 |
| 独立的自主进化数据库 | 统一 `agent-runtime.db`（双 schema 分裂已修） |
| 把 mood 数值展示给用户 | 文档 11 §11 禁令 |

---

**下一步**：从 Step 2 开始。Step 2 完成后，在 Step 3 的验证里先跑足一周 tick，确认 idle 率和满意度分布健康，再进 Step 4 的目标执行（对应文档 10 第九节"Step 1 之后先观察一周"的告诫）。
