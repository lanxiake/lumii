# 自主进化有效性验证用例（EVO）——加速实验

> 规范：[CLI-TEST-SPEC.md](../CLI-TEST-SPEC.md)
> 定位：**验证「这套功能是否真的有用、真的能让 Agent 自主进化」**，与既有套件（autonomous/ 下 4 个）的「链路通」验证互补——那些证明「数据能写入/流转」，本套证明「**进化数据反过来改变后续行为且方向是变好**」。
> 执行器：`run-autonomous-effectiveness-e2e.mjs`（产物 `autonomous-effectiveness-evidence.jsonl` + `-report.md`）
> 前置：客户端运行中（`pnpm dev`）、chat 模型已配置、`~/.lumii/logs/app/mtbot-<日期>.log` 可读；**建议执行期间用户暂停真实聊天**（避免 LLM 竞争与 user-turn 干扰 tick）。
> 共享库：`lib/cli-harness.mjs`（EVO 套件为其第二个使用者，见 CLI-TEST-SPEC §5 边界更新）。

## 设计背景（2026-09-12 现状调研，作为基线）

- 9/6–9/8 开着期间：17 反思 / 8 日记 / 13 主动消息 / 45 条 `evolution:main` 消息，但 8 篇日记全是「今天没有特别的事」类空洞独白；18 个目标全部卡 pending 无人审批；**变体试验 114 次全部劣于基线，且最差变体 k2yezex 仍是 UCB argmax**（being exploited 99 次）。
- 机制事实（已核实）：`prompt_variants.ucb_score` 是死列（从未写入）→ 本套件**本地重算 UCB**（`avgSatisfaction + 2·√(ln(N)/n)`，c=2.0）；`conversation create` 同步写 `runtime_state['prompt-variant:{sk}']`（创建即可读选择结果，不发消息亦可观察分布）；`autonomous reflect` 只同步落建议目标、不触发 planner；tick 开关读 `runtime_state['autonomous.enabled']`；日记唯一触发路径 = quietHours 覆盖当前小时 + 回拨 `autonomous.last_diary_date` + `cron run autonomous-tick`（manual 绕过 cron enabled、不绕静默时段）。

约定：
- 全部探针会话标题带 `[evo-e2e]` 前缀；探针目标描述带 `[evo-e2e]` 前缀。
- 硬断言 = 落库/字段/排序确定性；软断言 = LLM 语义（宽松匹配 + 重试/降级）。
- 快照恢复：`autonomous.settings` / `autonomous.enabled` / `autonomous.mood` / `autonomous.concerns` / `autonomous.last_diary_date` / cron jobs enabled / feedback 计数，finally 恢复。
- 失败三级：产品缺陷（机制断）/ 用例设计（flaky 降级）/ 环境（LLM/网络）——见 CLI-TEST-SPEC §8。

---

## 一、实验 A：变体淘汰学习（劣质 Prompt 变体真的会被淘汰吗）

> 回答「越用越懂我」的核心机制：会话结束的满意度反馈是否真的改变后续的变体选择。
> 预计：<15 分钟、~6 次 LLM 回合。

#### EVO-A1 UCB 基线快照（现状判定）
- **优先级**: P0 ｜ **预计回合**: 0
- **步骤**: 读 `prompt_variants` 全表 → 本地重算三变体 UCB（T=Σtrial_count）
- **预期**: 断言当前 argmax 为**表现最差**的变体（k2yezex）——这是「学习尚未起效」的现状证据；若 argmax 已是 baseline → SKIP（已被前序数据纠正，无需制造）
- **断言**: 硬（本地重算排名）

#### EVO-A2 制造劣质变体的负反馈
- **优先级**: P0 ｜ **预计回合**: 6（2 会话 × (2 abort + 1 完成)）
- **步骤**: 循环 `conversation create`（上限 8 次），读 `prompt-variant:{sk}` 囤积选中 k2yezex 的会话（exploit 下命中率≈90%）→ 对囤到的每个会话执行低分配方：2×「长文+abort」（`abortTwice` 校验计数器 ≥2）+ `file_read` 不存在文件完成回合
- **预期**: 每会话 `overall_score < 0.6` 落库；该变体 `trial_count` +1、`avg_satisfaction` 下降
- **断言**: 硬（评分 <0.6 + 变体统计变化）；无法囤到目标变体会话（8 次未中）→ SKIP
- **降级**: 低分未达成（模型改用成功工具）→ 换会话重试 ≤6，仍失败 SKIP

#### EVO-A3 UCB 排序翻转
- **优先级**: P0 ｜ **预计回合**: 0
- **步骤**: A2 后重算 UCB
- **预期**: baseline 反超成 argmax，k2yezex 跌出第一
- **断言**: 硬（margin ≥0.003）；软（margin ≥0.001，或「k2yezex 不再是 argmax」）

#### EVO-A4 后续选择分布翻转
- **优先级**: P0 ｜ **预计回合**: 0（12 次 create，不发消息）
- **步骤**: 新建 12 个探针会话，读各自 `prompt-variant:{sk}` 统计选择分布
- **预期**: baseline 占比显著上升、k2yezex 占比下降（ε≥0.15 探索噪声在，阈值按实时 ε 调整：baseline ≥7、k2yezex ≤3）
- **断言**: 硬（分布计数）
- **判读**: A2→A3→A4 构成完整因果链——「反馈 → UCB 重排 → 选择行为改变」= 系统会学习

---

## 二、实验 B：短板闭环（失败→反思→目标→执行→改善）

> 回答「越用越懂我」的行动链：发现问题后，建议能不能变成行动、行动能不能沉淀、沉淀能不能用上。
> 预计：~30 分钟、~12-15 次 LLM 回合。

#### EVO-B0 准备与快照
- **优先级**: P0 ｜ **预计回合**: 0
- **步骤**: 快照全部受控键 → `autonomous enable`（兜底）→ 临时 `approvalMode=always`（使新目标走 pending→审批链）、`maxGoalsPerDay↑`（当日配额已满会拦截生成）、`maxOutreachPerDay=0`（防主动消息打扰）→ **消化积压**：逐个 tick 执行 due executing 目标（≤8 次，避免 B4 派发被既有积压抢占）
- **断言**: 硬（snapshot 记录 + 设置生效回读）；积压消化在 note 中如实记录

#### EVO-B1 低满意 → 目标生成
- **优先级**: P0 ｜ **预计回合**: 3-9（低分配方重试）
- **步骤**: 低分配方（同 A2）→ 轮询 `autonomous_goals` 新增 pending 目标（id 不在测试前集合）
- **预期**: 生成新 pending 目标
- **断言**: 硬（新目标落库，created_at > 测试开始时间）
- **降级**: 同描述目标被去重拦截（历史 18 个 pending 在前）→ 记录证据，降级至 B2 的反思建议目标；两者均无 → SKIP B3-B6

#### EVO-B2 反思 → 建议目标
- **优先级**: P0 ｜ **预计回合**: 1（reflect LLM）
- **步骤**: `autonomous reflect --agent assistant`（timeout 180s）→ 轮询 `reflections` 新增；检查 `suggestedGoals` 是否同步落为新目标
- **预期**: 新反思落库（trigger_reason=user-request）；建议目标同步落库
- **断言**: 硬（反思新增）；软（建议目标落库，为空时用 B1 目标继续）

#### EVO-B3 批准目标
- **优先级**: P0 ｜ **预计回合**: 0
- **步骤**: `autonomous goals approve <id> --note` → 轮询状态
- **预期**: pending → executing
- **断言**: 硬（状态流转 + 目标列表可见）

#### EVO-B4 tick 执行目标
- **优先级**: P0 ｜ **预计回合**: 1（executeGoal LLM）
- **步骤**: mood 播种（保 `willDoHeavyWork`：energy 高）→ `cron run autonomous-tick`（≤180s）→ 读 `local_cron_runs.summary` + 目标状态 + `evolution:main` 新消息
- **预期**: summary 含 `execute-goal: completed`；目标 completed；`evolution:main` 新增「完成目标：…」user + 结果 assistant 成对消息
- **断言**: 硬（summary + 状态 + 消息对）
- **降级**: tick 返回 `skipped: user turn in progress` → 等待 10s 重试 ≤3，仍失败 SKIP（用户真实使用优先）

#### EVO-B5 学习沉淀
- **优先级**: P1 ｜ **预计回合**: 0
- **步骤**: 轮询 `agent_memories`（category='reference'，content 含目标输出片段）与 `wiki_sources`（title 含「学习成果」）新增
- **预期**: 两类产物落库
- **断言**: 硬（表计数增长 + 内容关联）；异步等待 ≤10s

#### EVO-B6 召回与复测（学过的东西能用上吗）
- **优先级**: P0 ｜ **预计回合**: 1-2
- **步骤**: 从 B4 输出抽关键词 → `memory search <关键词>` 断言命中 → 新会话复测同类任务（低分配方的同类提示词），观察不再失败/改为澄清（soft）
- **预期**: 记忆可检索；复测行为改善（拒绝盲从 / 先澄清 / 答得更准）
- **断言**: 硬（`memory search` 命中学习产出）；软（复测改善，LLM 非确定允许降级记录）

#### EVO-B7 自建任务可执行性（主动规划落地）
- **优先级**: P1 ｜ **预计回合**: 1（任务执行 LLM）
- **背景**: 2026-09-12 实库发现 9/7 planner 自建的两个周期性 cron **从未执行过**（无 local_cron_runs 记录），「主动规划→自建任务→执行」链路存疑
- **步骤**: 取一个 planner 自建、未执行过的 `agent-self:*` at 任务 → `cron run <jobId>`（manual 绕过 enabled）→ 断言运行记录出现且 status=ok
- **预期**: 任务真实执行（受限实例），产出可查
- **断言**: 硬（运行记录 + status）；产出落点记录在 note（不硬断言，避免落点判断错误）
- **降级**: 无可用任务 → SKIP

---

## 三、实验 C：生命感（内在状态由真实事件驱动）

> 回答「有生命感」：设计铁律「状态必须影响决策/反映真实经历，不只影响措辞」。对照基线：历史 8 篇日记全为空洞独白。
> 预计：~10 分钟。

#### EVO-C1 Mood 事件驱动
- **优先级**: P1 ｜ **预计回合**: 0
- **步骤**: 读 B4 前快照的 mood → B4 完成后再读 → 对比方向
- **预期**: 「目标完成」事件按设计改变 valence/arousal（方向与 `mood.ts` 规则一致：completed → valence↑ / arousal↓；failed → valence↓ / arousal↑）
- **断言**: 硬（数值方向 + 容差 0.01；事件唯一来源为 B4 的 tick）

#### EVO-C2 日记内容质量（真实经历 vs 空洞独白）
- **优先级**: P0 ｜ **预计回合**: 1（日记 LLM）+ 1（防重 tick，无 LLM）
- **步骤**: 前置检查无 due executing 目标（有则 SKIP，不擅改用户目标）→ `quietHours=[当前,当前+1]` + `last_diary_date=昨日` → `cron run autonomous-tick`（≤150s）→ 断言 `autonomous_diaries` 今日行 + `evolution:main` 文本
- **预期**: 日记落库；内容 ≥120 字；含 **≥1 个当日真实事件 token**（B4 目标描述/反思 primaryIssue 片段——「反映真实经历」的结构化判据）；无指标词（overall_score/满意度/成功率）；同日二次 tick 不重写
- **断言**: 硬（落库 + 字数 + 无指标词 + 防重）；软（真实事件 token 命中，未命中记录证据人工评审）
- **备注**: 与历史 8 篇空洞日记形成直接对照

#### EVO-C3 牵挂跨时间连续性
- **优先级**: P2 ｜ **预计回合**: 1
- **步骤**: 播种 concern（`nextRaiseAfter` 过去、raisedCount=0）→ 新会话发一条普通消息 → 轮询 concerns 状态
- **预期**: raisedCount +1；nextRaiseAfter 后移；不触发系统通知（不占 outreach 计数）
- **断言**: 硬（计数 + 后移）

#### EVO-C4 token 预算计数
- **优先级**: P2 ｜ **预计回合**: 0
- **步骤**: 读 `autonomous.tokens.<今天>`（tick 执行目标后）
- **预期**: 数值 >0（预算闸门真实计费）
- **断言**: 硬（计数增长）

---

## 四、执行开关

| 开关 | 作用 |
|---|---|
| `EVO_SKIP_LLM=1` | 跳过真实 LLM 用例（B1-B4/B6/B7、C2 等记 SKIP） |
| `EVO_PROBE_COUNT=<n>` | A4 探针会话数（默认 12） |
| `EVO_DIGEST_ONLY=1` | 仅消化 due executing 积压后退出（供 B 前置独立运行，防单次超时） |
| `EVO_NO_RESTORE=1` | 不恢复快照（保留现场供人工检查） |
| `EVO_VERBOSE=1` | 打印失败堆栈 |
| `EVO_TURN_TIMEOUT_MS` | 回合等待超时（默认 180000） |

## 五、副作用与恢复（真实数据操作声明）

- **快照恢复**（finally）：`autonomous.enabled`、`autonomous.settings`、`autonomous.mood`、`autonomous.concerns`、`autonomous.last_diary_date`、cron jobs enabled、feedback 计数。
- **不可恢复**（即验证证据本身，保留）：`prompt_variants` 统计与 `prompt_evolution_history`、`autonomous_satisfaction_scores`、测试目标（`[evo-e2e]` 描述）、`reflections`、`personality_events`、`agent_memories`/`wiki_sources` 沉淀、`autonomous_diaries`、`evolution:main` 消息、`local_cron_runs`、**`[evo-e2e-*]` 探针会话**（CLI 无会话删除能力，保留待人工处理）。
- **不动用户数据**：历史 18 个 pending 目标原样保留（不批量 approve/reject/清理）；不删任何用户会话。

## 六、已知限制

- **加速验证 ≠ 长期感知**：本套用 CLI 加速证明「机制有效性」；设计预期 2-4 周稳态，多日「用户可感知度」不在此列（用户已定：只做加速实验）。
- **UCB margin 薄**（翻转后 0.003-0.01）：已设计软降级；期间禁止其他会话产生反馈（禁后台 cron、探针会话不发消息）。
- **探索率随 mood 波动**（ε≤0.5）：A4 阈值按实时 ε 计算。
- **LLM 非确定**：低分配方/复测改善均为软断言 + 重试兜底，失败降级为 SKIP + 证据记录。
- **`prompt_evolution_history` 标签噪声**：`recordSelectionEvent` 用第二次独立 `shouldExplore()` 打标签（~15% 与真实决策不符），不作为主证据，仅辅助。
