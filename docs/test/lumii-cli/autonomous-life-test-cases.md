# 自主进化「心跳与生命感」CLI 测试用例

> **测试范围**：心跳 tick、专属会话、目标执行、主动消息预算、反思定时、Mood、牵挂、日记、设置参数、token 预算
> **设计文档**：`docs/design/自主进化Agent/10-心跳与外部交互设计.md`、`11-参数配置与生命感设计.md`
> **实施计划**：`docs/plans/AGENT自我进化/2026-09-05-autonomous-evolution-heartbeat-implementation.md`
> **实现提交**：`003b0b8` 心跳执行链路与内在状态模块 及后续 `e019a25 / 1f320fb / c6aeb76 / b367295 / 5f4b686`
> **日期**：2026-09-06

---

## 0. 与既有测试的分工

本目录已存在三套测试，本套补齐**心跳与生命感**这一层（Step 2-11），是唯一覆盖 tick 执行链路的：

| 套件 | 覆盖 | 驱动方式 |
|------|------|---------|
| `run-autonomous-cli-suite.mjs` | CLI 命令面、算法一致性、异常路径（TC1-22） | SQL 播种 + CLI 回读 |
| `run-autonomous-full-e2e.mjs` | 满意度/能力/Prompt/反馈/目标/反思 全链路（A-D） | CLI 真实对话 |
| **`run-autonomous-life-e2e.mjs`（本套）** | **心跳 tick、目标执行、主动消息、Mood、牵挂、日记、设置、token 预算** | CLI 真实对话 + `cron run` 手动触发 tick + DB 回读 |

---

## 1. 测试环境

- **数据库**：`~/.lumii/data/agent-runtime.db`
- **CLI**：`apps/windows/resources/app-ui-cli/lumii-ui.mjs`
- **tick 触发**：`cron run autonomous-tick`（经 `runCronJobManually` → `__evolution_tick__` → `handleEvolutionTick`，`manual: true`）
- **前置**：`pnpm dev` 已启动、chat provider 已配置（`~/.lumii/config/provider.json`）
- **真实对话一律走 assistant agent**（CLI 无法指定 agent）——这正是"与用户实际使用一致"的验证目标

---

## 2. 测试用例

> 环境变量：`LIFEE2E_SKIP_LLM=1` 跳过三类真实烧 LLM 的用例（目标执行 / 反思 / 日记），用于快速重跑其余确定性用例。

### 场景 A：设置参数（Step 7）

#### A1. settings get 返回全量默认值
- **步骤**：`autonomous settings get`
- **预期**：返回 9 字段，与 `DEFAULT_SETTINGS` 一致：`enabled=true`、`tickIntervalMinutes=10`、`quietHours=[23,8]`、`maxOutreachPerDay=20`、`minOutreachIntervalMinutes=60`、`outreachChannels=['system']`、`maxTokensPerDay=100000`、`maxGoalsPerDay=7`、`approvalMode='always'`
- **回读**：`runtime_state` 键 `autonomous.settings`（若从未写过则返回默认，不落库）

#### A2. settings set 部分覆盖不丢默认
- **步骤**：`autonomous settings set --data '{"maxOutreachPerDay":10}'`
- **预期**：`maxOutreachPerDay=10`，其余 8 字段保持默认；再次 `settings get` 回读一致
- **回读**：`autonomous.settings` JSON 含 `maxOutreachPerDay:10` 且含默认 `quietHours:[23,8]`

#### A3. 非法值回落默认（越界数字 / 非法枚举）
- **步骤**：`settings set --data '{"tickIntervalMinutes":999,"maxOutreachPerDay":999,"maxGoalsPerDay":0,"approvalMode":"bogus","quietHours":[99,-1]}'`
- **预期**：越界数字**回落默认值**（`readSettings` 的 `clampInt` 越界返回 fallback，非 clamp 到边界）：`tickIntervalMinutes=10`、`maxOutreachPerDay=20`、`maxGoalsPerDay=7`（0 非法回落）、`approvalMode='always'`（非 always/risky-only/never 回落）、`quietHours=[23,8]`（越界回落默认）
- **优先级**：P0（防用户调坏配置）

#### A4. maxOutreachPerDay=0 合法边界
- **步骤**：`settings set --data '{"maxOutreachPerDay":0}'`，再 `settings get`
- **预期**：`maxOutreachPerDay=0`（0 是合法值，不被当非法回落）

---

### 场景 B：专属会话 + 删除守卫（Step 2）

#### B1. 首次非 idle tick 落独白时才创建会话
- **步骤**：检查 `conversations` 表中是否已存在 `evolution:main`；若无，说明"启动即建会话"的过度设计已避免
- **预期**：会话只在心跳落独白/日记/目标执行痕迹时由 `ensureConversationExists` 创建，标题 `自主进化 · 内心独白`

#### B1. 空闲 tick 不创建会话（延迟创建）
- **步骤**：记录 `evolution:main` 是否存在 → 跑一次空信号 tick（C1 idle）
- **预期**：idle tick 不调用 `ensureConversationExists`，`evolution:main` 存在性不变（若原本不存在则仍不存在）——避免"用户从未打开自主进化也凭空多个会话"
- **回读**：`SELECT COUNT(*) FROM conversations WHERE id='evolution:main'` 前后一致

#### B2. 删除守卫拒绝删除 evolution:main
- **步骤**：`command conversation:delete --data '{"sessionKey":"evolution:main"}'`
- **预期**：控制口报错（`拒绝删除自主进化会话`），退出码非 0 或 `ok:false`；`conversations` 表中 `evolution:main` 仍在
- **回读**：`SELECT COUNT(*) FROM conversations WHERE id='evolution:main'` ≥ 1
- **优先级**：P0（防用户误删自主进化容器）

---

### 场景 C：心跳决策（Step 3）

#### C1. 空信号 tick → idle（绝大多数 tick 的路径）
- **步骤**：清理 executing 目标、日记已写、反思未到期 → `cron run autonomous-tick`
- **预期**：命令返回 ok；`local_cron_runs` 最新一条 `status='ok'` 且 `summary` 含 `idle`；不落任何独白
- **回读**：`SELECT summary FROM local_cron_runs WHERE job_id='autonomous-tick' ORDER BY started_at DESC LIMIT 1`

#### C2. 关闭开关 tick → skipped: disabled
- **步骤**：`autonomous disable` → `cron run autonomous-tick`
- **预期**：`local_cron_runs` summary 含 `skipped: disabled`
- **步骤**：`autonomous enable` 恢复

#### C3. 决策优先级：有 executing 目标时优先执行而非日记/反思
- **步骤**：播种一条 `status='executing'` 学习目标 + 制造日记到期条件 → `cron run`
- **预期**：tick 先走 `execute-goal`（summary 含 `execute-goal`），不写日记
- **回读**：目标 status 流转，`autonomous.last_diary_date` 未变

---

### 场景 D：目标执行（Step 4）

#### D1. learning 目标执行 → completed + 独白 + Mood 事件
- **步骤**：向 `autonomous_goals` 播种 `agent_id='assistant'`、`type='learning'`、`status='executing'`、简单描述 → `cron run autonomous-tick`
- **预期**：目标 `status` 变 `completed` 或 `failed`；`evolution:main` 会话出现一条 assistant 独白；`runtime_state` 键 `autonomous.mood` 发生变化（`goal_completed` → valence↑ 或 `task_failed` → valence↓ arousal↑）
- **回读**：
  - `SELECT status, completed_at FROM autonomous_goals WHERE id=?`
  - `SELECT content_json FROM messages WHERE conversation_id='evolution:main' ORDER BY timestamp DESC LIMIT 1`
  - `SELECT value FROM runtime_state WHERE key='autonomous.mood'`
- **护栏**：白名单为只读工具（`web_search/web_fetch/memory_search/memory_read/memory_add/notify_user`），无 `bash`/文件写入（此点由单测 `goal-executor.test.ts` 断言，CLI 层验证执行不崩）
- **优先级**：P0（心跳的核心价值）

#### D2. 空 output 判 failed（防假 completed）
- **预期**：执行产出为空时 `finalizeGoal` 判 `failed`（纯函数单测覆盖；CLI 层验证 completed 目标必有非空独白）

---

### 场景 E：主动消息 + 预算（Step 5）

#### E1. proactive-message 目标 → 发送 + 预算计数 + 目标完成
- **步骤**：播种 `type='proactive-message'`、`status='executing'` 目标 → `cron run autonomous-tick`
- **预期**：走系统通知（不烧 LLM）；目标 `status=completed`；`runtime_state` 键 `autonomous.outreach.{今天}` 计数 +1；`autonomous.outreach.last_sent_at` 更新
- **回读**：上述三处

#### E2. 最小间隔：刚发过不再发
- **步骤**：设 `autonomous.outreach.last_sent_at = now`（间隔 60min 未到）+ 播种 proactive 目标 → `cron run`
- **预期**：tick 返回 idle（summary 无 `outreach`），目标保持 executing，计数不变

#### E3. 预算用尽：主动消息停发，但不影响学习目标
- **步骤**：设 `autonomous.outreach.{今天} = maxOutreachPerDay`（用尽）+ 播种 proactive 目标 → `cron run`
- **预期**：proactive 目标不被发送（计数不再涨）；若同时有 learning 目标，learning 照常执行

---

### 场景 F：反思定时（Step 6）

#### F1. 静默时段 + 距上次反思 >24h → tick 触发反思
- **步骤**：`settings set` 把 `quietHours` 设为含当前小时的区间 → 临时把最新反思 `created_at` 回拨 >24h（保存原值）→ `cron run autonomous-tick`
- **预期**：`reflections` 表新增一行 `trigger_reason='scheduled'`，`root_cause`/`primary_issue` 非空（两列 NOT NULL）；tick summary 含 `reflect`
- **回读**：`SELECT trigger_reason, primary_issue, root_cause FROM reflections ORDER BY created_at DESC LIMIT 1`
- **收尾**：恢复被回拨的 `created_at`
- **优先级**：P0（唯一真实烧模型的动作，三重约束）

#### F2. 未到间隔不触发（纯函数单测覆盖）
- **预期**：`tick-signals.test.ts` 断言未满 24h 不返回 reflect；CLI 层验证 reflect 只在 F1 条件下发生

---

### 场景 G：Mood（Step 8）

#### G1. 目标执行触发情绪事件（状态变化；决策参数未接线）
- **步骤**：读取 `autonomous.mood` 基线 → 执行一次目标（复用 D1）→ 再读
- **预期**：`valence` 或 `arousal` 相较基线发生变化；`task_failed` 应使 valence↓ 且 arousal↑（两条都断言，防"抑郁 Agent"）
- **回读**：`runtime_state` 键 `autonomous.mood` JSON 三字段
- **⚠ 注意**：`moodToDecisionParams`（`willDoHeavyWork`/`outreachMultiplier`）**无任何调用点**，Mood 只改状态、供牵挂/日记，不实际影响 tick 的 `decideAction`——这违反计划铁律 2"状态影响决策"，已在缺口表标中风险

#### G2. 情绪衰减半衰期 4h（纯函数单测覆盖）
- **预期**：`decayMood` 4h 后数值回归一半（`mood.test.ts` 断言；CLI 层不重复，因需控制时间）

---

### 场景 H：牵挂 Concerns（Step 10）

#### H1. 对话中顺带提起牵挂（不提则无感）
- **步骤**：向 `runtime_state` 键 `autonomous.concerns` 播种一条 `{status:'open', raisedCount:0, nextRaiseAfter:过去, arousalWeight:0.8}` → 新建会话发消息并等回合结束
- **预期**：`raisedCount` 变 1、`nextRaiseAfter` 后移 72h、`status` 仍 `open`
- **回读**：`autonomous.concerns` JSON

#### H2. 提两次无回应 → dropped
- **步骤**：播种 `{status:'open', raisedCount:1, nextRaiseAfter:过去}` → 发消息等回合结束
- **预期**：`raisedCount` 变 2、`status='dropped'`，之后不再被 `pickConcernToRaise` 选中
- **回读**：`autonomous.concerns` JSON

#### H3. 牵挂只进对话上下文，不产生新通知
- **预期**：H1/H2 全程无系统通知副作用（`autonomous.outreach.*` 计数不变）；牵挂注入位置为 `bridge-prompt-composer` 的 `buildConcernSection`

---

### 场景 I：日记（Step 11）

#### I1. 静默时段 + 今日未写 → 写日记入 evolution:main
- **步骤**：`settings set` 把 `quietHours` 含当前小时 → 设 `autonomous.last_diary_date` 为昨日 → `cron run autonomous-tick`
- **预期**：`evolution:main` 出现一篇第一人称日记消息；`autonomous.last_diary_date` 更新为今天；tick summary 含 `diary`
- **回读**：`SELECT content_json FROM messages WHERE conversation_id='evolution:main' ORDER BY timestamp DESC LIMIT 1` + `runtime_state` 键 `autonomous.last_diary_date`
- **禁令**：日记正文**不含** `overall_score` / `满意度` / `成功率` 等指标词（正则扫描断言）

#### I2. 同日第二次 tick 不重复写
- **步骤**：保持 I1 条件再 `cron run` 一次
- **预期**：`evolution:main` 消息数不再增长（`markDiaryWritten` 防重），tick 返回 idle 或 reflect（非 diary）
- **回读**：`evolution:main` 消息计数不变

---

### 场景 J：token 预算（Step 5/6/7 横切）

#### J1. 预算超限 → 目标执行降级 idle，不烧 LLM
- **步骤**：`settings set --data '{"maxTokensPerDay":0}'` → 播种 executing 学习目标 → `cron run`
- **预期**：tick summary 含 `token-budget-exhausted`，目标保持 executing（不执行），不新增 LLM 调用
- **回读**：目标 status 仍 executing

#### J2. 目标执行后 token 累计
- **步骤**：恢复正常 `maxTokensPerDay` → 执行一次目标（复用 D1）→ 读 `runtime_state` 键 `autonomous.tokens.{今天}`
- **预期**：值 ≥ `TOKEN_COST.executeGoal`（8000）

---

## 3. 诚实声明的已知缺口（非遗漏即失真）

> 本轮测试前逐行核查发现 5 处接线缺口，**已全部修复**（4 处本会话修复 + 1 处并行提交接入）。下表记录的是修复后的最终状态：

| 缺口 | 修复状态 | 修复方式 |
|------|---------|---------|
| 目标执行工具白名单未强制 | ✅ 已修（本会话） | `executeGoal` 改为 `createInstance(restrictedDef)`，`tools: getGoalToolAllowlist(...)` + `canSpawnSubAgents:false`，硬隔离 bash/文件/群发 |
| Mood 不参与决策 | ✅ 已修（本会话） | `collectTickSignals` 读 `moodToDecisionParams`，`decideAction` 低 energy→跳过目标执行、低 valence→主动消息有效上限减半 |
| 反思双重触发冗余 | ✅ 已修（本会话） | 删除 `startReflectionScheduler`（23:00 Cron），统一由心跳 reflect 分支触发 |
| `tickIntervalMinutes` 不生效 | ✅ 已修（本会话） | `ensureEvolutionCronJobSeeded` 读 `readSettings().tickIntervalMinutes`，新增 `syncEvolutionTickSettings()` 设置变更即时重载 |
| `outreachChannels` 未实现 | ✅ 已修（并行提交 `68ad470`） | `sendOutreach` 已按 `settings.outreachChannels` 派发（system/feishu/weixin/wecom） |
| Mood → 桌宠实时表情未接线 | ✅ 已修（本会话 `8aca7d3`） | `recordMoodEvent` 用 `moodToPetEmotion` 算情绪键，经 `autonomous:mood:emotion` 事件推宠物窗 `setExpression` |

**仍存在的缺口**（本套不当通过测）：

| 缺口 | 现状 |
|------|------|
| 编辑/重发反馈信号 | 采集点只在前端 UI 触发，CLI 无 `edit`/`resend` 子命令 |

---

## 4. 成功标准

- A/B/C/D/E/F/G/H/I/J 全部场景通过（`LIFEE2E_SKIP_LLM=1` 时 D1/F1/I1 标记跳过）
- idle 是默认路径（C1 通过）
- 目标执行真实流转 completed/failed（D1）
- 主动消息受预算 + 最小间隔双重约束（E1/E2/E3）
- 牵挂两条纪律成立：最多提 2 次、顺带不专程（H1/H2/H3）
- 日记一天一次、无指标词（I1/I2）
- 删除守卫拦下 evolution:main（B2）
- 设置非法值回落默认（A3）

---

## 5. 测试数据清理

脚本对以下 `runtime_state` 键做**快照/恢复**，不污染用户真实状态：
`autonomous.settings`、`autonomous.concerns`、`autonomous.mood`、`autonomous.outreach.*`、`autonomous.tokens.*`、`autonomous.last_diary_date`、`autonomous.outreach.last_sent_at`

探针目标（description 前缀 `[life-e2e]`）跑完删除；`evolution:main` 中由本套产生的日记/独白消息保留，供用户在客户端侧边栏核查。
