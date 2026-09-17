# P3 实施计划：协同闭环落地与多 Agent 自组织

> **日期**：2026-09-04
> **依赖**：P0（满意度评分、目标生成、Prompt 进化、人格追踪）已完成；P1（能力边界、自我反思）已完成；P2 代码已落地但**未接线**（见第一节）
> **状态**：设计阶段
> **实施周期**：第 15-24 周（10 周，约 148 小时）

---

## 一、开工前必读：P3 的实际起点不是设计文档所设想的那个

原始路线图（`6-实施计划.md:729`）把 P3 定义为"多层协同优化 + 多 Agent 自组织"。**但按当前代码，"多层协同优化"的算法部分已经在 P2 写完了，真正缺的是把它接进运行时。** 这个偏差决定了 P3 的任务构成，必须先讲清楚。

### 1.1 代码基线核查结果（2026-09-04 实测）

| 核查项 | 结论 | 证据 |
|-------|------|------|
| 协同层四个模块是否存在 | **存在且有测试** | `coordinated-scheduler.ts`、`conflict-detector.ts`、`pareto-frontier.ts`、`shapley-attribution.ts` |
| 是否被业务代码消费 | **否，仅 index.ts 导出** | `grep` 全仓库：除 `index.ts` 与自身测试外无引用；`coordinated-scheduler.ts:19` 只引用 `shapley-attribution` |
| 是否有持久化 | **否，纯内存态** | 四个文件对 `db.`／`DatabaseClient` 的引用数均为 **0** |
| 协同数据表是否已建 | **建了，但没有任何代码读写** | `schema.ts:1109` `coordinated_evolution_history`、`:1138` `pareto_frontier`；全仓库无 SQL 引用这两张表 |
| `AutonomousCoordinator` 是否调用协同层 | **否** | `autonomous-coordinator.ts:9-20` 的 import 里没有任何 P2 协同模块 |
| Electron 主进程是否实例化协调器 | **否，完全未接线** | `grep AutonomousCoordinator apps/windows/src` → 0 结果 |
| 多 Agent 编排基础设施 | **已有成熟实现** | `agent/orchestrator.ts:128` `AgentOrchestrator`（`spawnAgent:385`、`sendMessage:575`、`listChildren:217`、`interruptChild:244`、`steerChild:276`、`startStaleMonitor:177`）+ `subagent-broker.ts` + 3 个测试文件 |
| 审批链路 | **不存在** | 无 `autonomous_approvals` 表；`intrinsic-goal-generator.ts:238` `approveGoal()` 仍是裸 SQL |

**一句话概括**：P2 交付的是**四个能通过单元测试的算法零件**，不是一个在跑的协同系统。P3 的第一要务是让这些零件真正连上电，而不是再造新零件。

### 1.2 P2 遗留问题（编写本计划期间已被并行修复）

编写本计划时实测 `npx vitest run src/autonomous` 曾有 **4 个失败**（人格更新 2 例、E2E 场景 3 与场景 5），根因是 P2 给人格更新加了开关、`MAX_GOALS_PER_DAY` 从 5 提到 7（`config.ts:70`）而测试预期未同步。

**这些失败已在本计划编写期间被并行修复**，复测结果：**19 个测试文件、333 个测试全部通过**。同时新增了 `memory-evolution.test.ts`、`skill-evolution.test.ts`、`tool-evolution.test.ts` 三个测试文件。因此原定的 Task 0（修复红色基线）**已无需执行**，P3 可以直接在绿色基线上开工。

仍需在 P3 处理的两处遗留：

| 遗留项 | 现状 | 处置 |
|-------|------|------|
| `evolutionEnabled` 是死配置 | `types.ts:239` 声明了该字段，但**全仓库没有任何逻辑读取它**（仅测试传值 + 一行注释提及）。人格更新实际由 `trackingEnabled` 门控（`personality-tracker.ts:169`） | 注释（`:168`）称该开关"保留给 P3 的人格主动进化"。P3 若不做人格主动进化（见第十节，已列为 P3 之后方向），应**删除该字段**而非留着误导；若要保留，需在本计划中明确其消费点 |
| 两个模块无单元测试 | `autonomous-coordinator.ts`、`metrics-collector.ts` 无对应 `__tests__` 文件 | 协调器是 P3 主线 A 的主要改造对象（Task 4），补测试并入 Task 4；`metrics-collector` 由 E2E 间接覆盖，优先级低 |

### 1.3 P3 范围的重新划定

基于上述基线，P3 拆成三条主线，按依赖顺序：

```
主线 A：协同闭环落地（必做，P3 的核心价值）
  把 P2 的四个算法零件接进 AutonomousCoordinator，加持久化，接进 Electron 主进程
  → 让"多层协同"从代码变成可观测的运行时行为

主线 B：审批链路实施（必做，阻塞一切自主执行）
  实施《前端可视化实施方案》第十节的离线审批架构 A1-A8
  → 让目标能在用户不在电脑前时被处置，解开进化死锁

主线 C：多 Agent 自组织（选做，视 A/B 成效决定是否启动）
  复用已有 AgentOrchestrator，让进化任务能派生子 Agent 并行验证
  → 原路线图的 P3 目标，但成本远低于预期（编排层已存在）
```

**主线 C 降级为选做的理由**：多 Agent 自组织的价值取决于协同闭环是否真的产生了可并行的探索任务。若主线 A 上线后观察到探索请求排队（单层探索串行、一天只能验证一个配置），多 Agent 才有意义；若探索本身就稀疏，派生子 Agent 只是增加复杂度和 token 消耗。**先测量，再决定。**

---

## 二、主线 A：协同闭环落地（60h）

### 2.1 当前断点分析

P2 的协同层是一组**无状态纯算法**，这个设计本身是对的（好测试、无副作用），但要接进运行时缺三样东西：

1. **状态持久化**：`CoordinatedScheduler` 的 `SchedulerState`（层优先级、探索历史）在内存里，进程重启即丢失。EMA 优先级需要长期累积才有意义，重启归零等于永远学不到东西。
2. **调用时机**：`decide()` 该在什么时候调？`ParetoFrontier.add()` 的数据从哪来？P2 没有定义。
3. **配置下发**：`decide()` 返回 `SchedulingDecision`（探索哪一层），但没有任何代码把这个决策变成实际的 Prompt/Memory/Tool 配置变更。

### 2.2 设计：协同进化控制器

新增 `coordination-controller.ts` 作为协同层的**有状态门面**，承接持久化与接线职责，四个纯算法模块保持无状态不变：

```typescript
// packages/agent-runtime/src/autonomous/coordination-controller.ts

export interface CoordinationControllerDeps {
  db: DatabaseClient
  scheduler: CoordinatedScheduler
  frontier: ParetoFrontier
  detector: ConflictDetector
  promptEvolution: PromptEvolutionEngine
  memoryEvolution: MemoryEvolution
  toolEvolution: ToolEvolution
  skillEvolution: SkillEvolution
}

export class CoordinationController {
  /** 启动时从库恢复调度器状态与帕累托前沿 */
  async initialize(agentId: string): Promise<void>

  /** 会话开始前：决定本轮探索模式，返回冲突消解后的层配置 */
  async beforeSession(agentId: string, ctx: SessionContext): Promise<LayerConfigs>

  /** 会话结束后：归因贡献、更新优先级、维护前沿、落库 */
  async afterSession(agentId: string, outcome: SessionOutcome): Promise<void>

  /** 持久化调度器状态（每次 afterSession 后写，或定时批量写） */
  private async persistSchedulerState(agentId: string): Promise<void>
}
```

**关键设计约束**：

- **`beforeSession` 必须是快路径**。它挂在每次对话前，超时或抛错绝不能阻塞用户对话。实现上包一层 try/catch + 超时保护，任何异常降级为"返回当前最优配置"（等价于 EXPLOIT 模式），并记录 telemetry。设计文档给的算法预算是 < 50ms（`5-多层进化协同.md:725`），实测需守住这条线。
- **归因只在单层探索时可信**。`shapley-attribution.ts` 同时提供了 `computeShapleyContribution`（完整，O(2^N)）和 `computeMarginalContribution`（增量近似）。协同调度本身保证每轮只变一层，因此**默认走增量近似**，完整 Shapley 仅用于离线分析。这与设计文档 §3.3 的意图一致（`5-多层进化协同.md:170`：适用场景为每次只改变一层）。
- **前沿写入需去重**。`computeConfigHash`（`pareto-frontier.ts:59`）已提供配置哈希，`pareto_frontier` 表的 `config_hash` 应建唯一索引，重复配置更新 `usage_count` 而非插入新行。

### 2.3 状态持久化设计

新增一张表存调度器状态。**不复用 `coordinated_evolution_history`**——那张表是逐次事件流水，而调度器状态是需要单行读写的当前快照，混在一起会导致每次启动都要扫全表重放。

```sql
-- V31: 协同调度器状态快照
CREATE TABLE IF NOT EXISTS coordination_scheduler_state (
  agent_id            TEXT PRIMARY KEY,
  current_mode        TEXT NOT NULL,
  layer_priorities    TEXT NOT NULL,   -- JSON: {prompt,memory,skill,tool}
  mode_history        TEXT NOT NULL,   -- JSON 数组，仅保留最近 N 条
  global_satisfaction REAL NOT NULL DEFAULT 0.5,
  disabled_layers     TEXT,            -- JSON 数组，对应 setLayerEnabled
  updated_at          TEXT NOT NULL
);
```

`mode_history` 只用于"避免连续探索同一层"的轮询判断（`5-多层进化协同.md:218` 只看最近 3 条），因此**截断保留最近 10 条即可**，不做无界增长。

`ParetoFrontier` 已有 `load(entries)` / `getAll()`（`pareto-frontier.ts:225`、`:215`），恢复与落盘直接复用，无需新接口。

### 2.4 Task 拆解

#### Task 0：基线清理（2h）

原定的"修复 4 个测试失败"已由并行工作完成（见 §1.2），本任务缩减为：

- 处置 `evolutionEnabled` 死配置：确认 P3 不做人格主动进化后删除该字段及其测试传参；若保留则补上消费点
- 测试中的目标上限断言改为引用 `MAX_GOALS_PER_DAY` 常量而非硬编码数字，避免阈值再次调整时重复失败
- **验收**：`npx vitest run src/autonomous` 保持全绿（当前 333 passed）；无死配置残留

#### Task 1：协同状态持久化（V31 迁移 + 恢复逻辑）（8h）

- 新增 V31 迁移：`coordination_scheduler_state` 表 + `pareto_frontier.config_hash` 唯一索引
- 提供 Down 迁移（与 P2 §4.6 保持一致的风格）
- `CoordinationController.initialize()`：读状态 → `scheduler.restoreState()`；读前沿 → `frontier.load()`
- `persistSchedulerState()`：`getState()` → UPSERT
- **验收**：进程重启后层优先级与前沿完整恢复；空库首启走默认值不报错
- **必测边界**：`mode_history` 截断生效，长期运行不无界增长

#### Task 2：CoordinationController 主循环（12h）

- 实现 `beforeSession` / `afterSession`
- `beforeSession`：`scheduler.decide()` → 按模式生成候选配置 → `detector.detectAndResolve()` → 返回
- `afterSession`：`computeMarginalContribution()` → `scheduler.updatePrioritiesFromContribution()` → `scheduler.recordExploration()` → `frontier.add()` → 落库
- 快路径保护：`beforeSession` 包超时 + try/catch，异常降级 EXPLOIT
- **验收**：单元测试覆盖降级路径（db 抛错、算法抛错、超时）均不影响返回值可用性
- **性能门槛**：`beforeSession` p99 < 50ms（不含 db I/O 则 < 5ms）

#### Task 3：配置下发到四个进化层（12h）

这是**最容易被低估的任务**。`LayerConfigs` 目前是一个类型定义，没有任何代码消费它。要让探索决策真正生效，需要：

- 定义每层的"配置如何应用"契约。四层现有接口并不统一（`PromptEvolutionEngine.selectPrompt(baselinePromptId)`、`ToolEvolution.selectTool(...)`、`MemoryEvolution.rankMemories(...)`、`SkillEvolution` 无选择方法只有 `identifySkillGaps()`）
- **Skill 层特殊处理**：它没有"每轮可切换的配置"，只有离线的缺口识别与改进建议。因此 `ExplorationMode.EXPLORE_SKILL` 不能像其他三层一样即时生效，应映射为"生成一个 `skill-enhancement` 目标进审批队列"，而非直接改配置。这一点设计文档没有区分，但代码结构决定了必须区分。
- 三个即时层（prompt/memory/tool）实现 `applyConfig()`
- **验收**：探索 prompt 层时，本轮对话确实使用了变体 prompt；探索 skill 层时，产生一个待审批目标而非静默无操作

#### Task 4：接入 AutonomousCoordinator（10h）

- `AutonomousCoordinator` 注入 `CoordinationController`
- `onSessionEnd`（`autonomous-coordinator.ts:79`）末尾调 `afterSession`
- 新增 `onSessionStart` 事件与 `beforeSession` 挂载点
- **顺带修掉三处 P0 遗留死代码**（读代码时发现，不修会一直误导后续开发者）：
  - `:106` 注释掉的 `promptEvolution.recordFeedback(variantId, ...)`——变体奖励从未回流，Prompt 进化的 UCB 实际上一直在用空数据。Task 3 拿到 variantId 后应接通。
  - `:26-29` `initialized`、`reflectionTimer` 声明后从未实际使用；`REFLECTION_SCHEDULE`（`:20`）导入但未用——P1 的定时反思**根本没有被调度**。需确认是有意留待接线还是遗漏，并补上或删除。
  - `:100` `this.metaCognitionEngine['config']` 用下标访问私有成员，绕过了类型检查。应改为公开只读 getter。
- **补齐 `autonomous-coordinator.test.ts`**：该模块目前无单元测试（见 §1.2），而 Task 4 正在改造它，必须同步补测试
- **验收**：E2E 测试跑通"会话结束 → 归因 → 优先级更新 → 落库"完整链路

#### Task 5：Electron 主进程接线与可观测性（16h）

这是**用户第一次能看到协同进化在跑**的任务。当前 `apps/windows/src` 对整个 autonomous 模块的引用数是 **0**——P0/P1/P2 全部代码在产品里从未被实例化过。

- 主进程创建 `AutonomousCoordinator` 单例，绑定 db，随应用生命周期启停
- 复用仓库既有 IPC 模式（`setXIpcDeps` + `registerXIpcHandlers`，注册进 `ipc-handlers-registry.ts`，参照 `channel-ipc.ts`）新增 `autonomous:*` handler：
  - `autonomous:getCoordinationState`（当前模式、层优先级、前沿大小）
  - `autonomous:getContributionHistory`（贡献度趋势）
  - `autonomous:getConflicts`（近期冲突）
- 结构化 telemetry：探索模式切换、冲突消解、前沿增删各打一条
- **验收**：应用启动后，能通过 IPC 读到非空的协同状态；连续 20 轮模拟会话后，层优先级发生了可解释的变化
- **验收（负向）**：`AUTONOMOUS_ENABLED = false` 时协调器完全不启动，无任何 db 写入与性能开销

---

## 三、主线 B：审批链路实施（40h）

### 3.1 为什么这条线是硬阻塞

`intrinsic-goal-generator.ts:238` 的 `approveGoal()` 至今只是一条等人调用的 UPDATE SQL，没有通知、没有超时。目标生成后写库为 `PENDING` 就永久躺在那里，还会占满每日配额（`MAX_GOALS_PER_DAY = 7`），导致**不再生成新目标**——进化链路是死锁的。

主线 A 让协同调度跑起来后，这个死锁会更严重：Task 3 把 `EXPLORE_SKILL` 映射成待审批目标，等于协同调度会**主动生产**审批请求。审批不通，协同的四分之一直接哑火。

设计已在《前端可视化实施方案》第十节完成（风险分级、`autonomous_approvals` 表、渠道送达、超时兜底），P3 负责实施。

### 3.2 Task 拆解（对应前端方案 A1-A8）

| Task | 内容 | 工时 | 关键约束 |
|------|------|------|---------|
| A1 | `autonomous_approvals` 表 + V32 迁移 | 4h | `goal_id` 唯一索引；含 `risk_level`/`delivery_status`/`decided_by`/`expires_at` |
| A2 | `classifyGoalRisk()` 风险分级 | 4h | 未知类型**保守降级为 L2**；`skill-enhancement` 判为 L2 |
| A3 | L0 自动审批 + 每日上限 | 6h | 写审计 `decided_by='auto-policy'`；`AUTO_APPROVE_DAILY_CAP=5`；L2 永不自动批准 |
| A4 | 渠道送达（复用 `ChannelOutboundRouter`） | 8h | 送达失败标记 `unreachable` 而非抛错；文案含超时预告 |
| A5 | 回复回填（复用 Hub 的文案与 1/2/3 解析） | 6h | 无法解析为 1/2/3 时**不消费**该回复，避免吃掉正常对话 |
| A6 | 超时兜底扫描器 | 6h | 按类型分别处置；`deliveryStatus !== 'sent'` 时收紧为 expire |
| A7 | `ApprovalSettings` + 免打扰顺延 | 3h | 静默时段内不推送，顺延至时段结束 |
| A8 | 端到端场景测试 | 3h | 8 个场景，含离线 8h、渠道未连接、静默时段跨天 |

**不能复用 `ChannelInteractionHub` 的原因**（已核实，`channel-interaction-hub.ts`）：它依赖用户有活跃入站会话才有 `replyContext`（`:43` `trackSession`、`:96` `onInteraction` 中 `routes.get(sessionKey)`），后台 cron 触发时 `routes` 为空直接 `return false`；且状态存内存 `Map` 并同步阻塞一轮 agent turn，而目标审批是长时异步、重启不能丢。**只复用它的文案格式化与 1/2/3 解析逻辑。**

### 3.3 安全底线（不可协商）

- **未送达绝不视为默示同意**。渠道推送失败时，非 L0 目标一律归档，不执行。
- **L2 永不自动批准**。`skill-enhancement`、文件/命令/权限类操作，超时后归档等人工处理。
- **主动消息超时应拒绝而非批准**。过期的主动消息发出去是骚扰，安全侧是不发。
- **自动批准必须可审计可回滚**。每条自动决策写审计链，`decided_by` 标明来源。

---

## 四、主线 C：多 Agent 自组织（48h，选做）

### 4.1 门控条件：先测量，再动工

**启动前置**：主线 A 上线并稳定运行 ≥ 2 周，且满足以下**任一**观测条件：

- 探索请求排队：单层串行探索导致平均验证延迟 > 24h
- 配置空间增长：帕累托前沿稳定 > 30 个非支配配置，串行 A/B 无法覆盖
- 技能改进积压：`skill-enhancement` 目标待验证数 > 10

**若均不满足，不启动主线 C。** 派生子 Agent 会带来 token 成本、并发状态一致性和调试复杂度；在探索本身稀疏的情况下，这些成本换不到收益。这不是保守，是把 48h 留给更有价值的事。

### 4.2 成本远低于原路线图预期

原路线图把"多 Agent 自组织"当成 10 周的大工程，但**编排层已经存在且成熟**（`agent/orchestrator.ts:128`）：

| 已有能力 | 位置 | P3 用途 |
|---------|------|--------|
| `spawnAgent()` | `orchestrator.ts:385` | 派生进化验证子 Agent |
| `sendMessage()` | `orchestrator.ts:575` | 下发验证任务与配置 |
| `listChildren()` / `getActiveAgents()` | `:217` / `:638` | 并发度控制 |
| `interruptChild()` / `steerChild()` | `:244` / `:276` | 验证超时中断、方向纠偏 |
| `startStaleMonitor()` | `:177` | 僵死子 Agent 回收 |
| `subagent-broker.ts` + 3 个测试 | `agent/__tests__/` | 消息代理已验证 |

**P3 不需要造编排能力，只需要定义"进化验证 Agent"这一角色并接上协同层。**

### 4.3 设计：并行探索验证

```
CoordinationController.decide() 产出多个候选配置
        ↓
EvolutionVerifier（新增）
        ↓ spawnAgent × N（N ≤ MAX_PARALLEL_VERIFIERS）
子 Agent 1（配置 A）  子 Agent 2（配置 B）  子 Agent 3（配置 C）
        ↓ 各自在隔离上下文中跑基准任务集
        ↓ 汇总 OptimizationObjectives
ParetoFrontier.add() × N —— 一轮拿到多个数据点
```

**关键约束**：

- **子 Agent 只读、不改全局状态**。验证子 Agent 不得写 `personality_state`、不得触发新目标生成、不得发主动消息。否则并行验证会互相污染人格与配额。需要一个"验证模式"标志位贯穿下去。
- **并发上限硬编码保护**。`MAX_PARALLEL_VERIFIERS` 默认 2，上限 4。每个子 Agent 都是完整 LLM 会话，token 成本线性增长。
- **基准任务集必须固定**。不同配置跑不同任务，比出来的结果无意义。需要一个稳定的评测任务集，这本身是 Task C3 的主要工作量。
- **失败隔离**。子 Agent 崩溃/超时不影响主 Agent，复用 `startStaleMonitor` + `interruptChild`。

### 4.4 Task 拆解（选做）

| Task | 内容 | 工时 |
|------|------|------|
| C1 | `EvolutionVerifier` 角色定义与 orchestrator 接入 | 10h |
| C2 | 验证模式标志位（禁写全局状态）贯穿改造 | 10h |
| C3 | 固定基准任务集与评测协议 | 12h |
| C4 | 并行结果汇总与前沿批量更新 | 8h |
| C5 | 并发控制、失败隔离、成本上限 | 8h |

---

## 五、实施顺序与里程碑

```
第 15 周   Task 0 + Task 1              测试转绿，状态可持久化
第 16-17 周 Task 2 + Task 3             协同主循环跑通，配置真正下发
第 18 周   Task 4                       接入协调器，修 P0 遗留死代码
第 19-20 周 Task 5                      Electron 接线，用户首次可见
第 21-22 周 主线 B（A1-A8）              审批链路打通，解开进化死锁
第 23 周   观测与门控评估                 决定主线 C 是否启动
第 24 周   主线 C（若启动）或 P3 收尾      —
```

**主线 A 与主线 B 的顺序权衡**：审批链路（B）是解开死锁的关键，理论上应更早。但主线 A 的 Task 3 会**新增**审批请求来源（EXPLORE_SKILL），若 B 先做完而 A 未动，审批系统会长期空转无请求可处理，反而测不出问题。因此 A 先行、B 紧随，Task 3 完成时 A2（风险分级）需已就绪——**Task 3 与 A2 之间存在硬依赖，排期时不可倒置**。

若资源允许并行，A 与 B 可由两人分线推进，交汇点是 Task 3 ↔ A2。

---

## 六、工程化保障

### 6.1 性能门槛

| 路径 | 门槛 | 理由 |
|------|------|------|
| `beforeSession` | p99 < 50ms | 挂在对话前，直接影响用户感知延迟 |
| `afterSession` | p99 < 200ms | 异步不阻塞，但不能堆积 |
| 协同层纯计算 | < 5ms | 设计文档预算（`5-多层进化协同.md:725`） |
| 每次会话新增存储 | < 2KB | 同上，长期运行不撑爆库 |
| 新增 LLM 调用 | **0** | 协同层是纯计算，不得引入 LLM 成本 |

### 6.2 可靠性

- 协同层任何异常均降级为 EXPLOIT 模式，不影响正常对话
- `AUTONOMOUS_ENABLED = false` 时零开销、零写入（需负向测试守住）
- 所有迁移提供 Down 脚本，可回滚
- 调度器状态损坏（JSON 解析失败）时重置为默认值并告警，不崩溃

### 6.3 隐私

延续 P2 约定：`memory_usage_feedback` 只存查询长度与特征快照，不存原文（`schema.ts:1055` 附近注释已明确）。协同层新增的配置快照同样**不得包含用户内容**，只存配置标识与哈希。

---

## 七、测试策略

### 7.1 单元测试

- `CoordinationController`：降级路径（db 抛错、算法抛错、超时）、状态恢复、空库首启
- 配置下发：三个即时层各自 `applyConfig()` 生效；skill 层映射为待审批目标
- 持久化：`mode_history` 截断、`config_hash` 去重

### 7.2 集成测试

- 20 轮模拟会话后层优先级发生可解释变化，且轮流探索覆盖 ≥ 3 层（对齐 `5-多层进化协同.md:839` 的集成测试意图）
- 进程重启后状态完整恢复，优先级不归零
- 冲突注入：critical 冲突被自动消解，warning 仅记录

### 7.3 端到端场景

1. 会话结束 → 归因 → 优先级更新 → 落库 全链路
2. 协同调度产生 `skill-enhancement` 目标 → 走审批链路 → L2 不自动批准
3. 用户离线 8h → L0 目标自动批准并执行，L2 目标归档
4. 渠道未连接 → 非 L0 目标全部归档，无一执行
5. `AUTONOMOUS_ENABLED = false` → 无任何 db 写入
6. 协同层抛错 → 对话正常完成，telemetry 记录降级

---

## 八、成功指标与发布门槛

### 8.1 功能门槛（必须全部达成）

- [ ] `npx vitest run src/autonomous` 全绿
- [ ] Electron 应用中能通过 IPC 读到非空协同状态
- [ ] 层优先级在连续会话中发生可解释变化并跨重启保持
- [ ] 帕累托前沿有 ≥ 5 个非支配配置且去重正确
- [ ] 用户离线场景下审批链路完整走通（L0 自动、L2 归档）
- [ ] `AUTONOMOUS_ENABLED = false` 时零开销

### 8.2 质量门槛

- [ ] 协同层单测覆盖率 ≥ 85%
- [ ] `beforeSession` p99 < 50ms
- [ ] 无新增 LLM 调用
- [ ] 所有迁移可回滚

### 8.3 效果指标（观察 4 周）

| 指标 | 目标 | 说明 |
|------|------|------|
| 满意度趋势 | 相比 P2 基线不下降 | 协同不应劣化体验，这是底线 |
| 探索有效率 | 探索轮次中带来正向 delta 的比例 > 30% | 低于此说明调度策略需调整 |
| 审批处置率 | PENDING 目标 24h 内被处置 > 95% | 验证死锁已解开 |
| 冲突拦截 | critical 冲突自动消解率 100% | 无遗漏进入执行 |

**发布策略**：feature flag 灰度。先离线回放历史会话验证归因合理性，再 5% 灰度观察 ≥ 7 天；满意度趋势下降则回退至 P2 策略（关闭协同调度，各层独立进化）。

---

## 九、风险与缓解

| 风险 | 影响 | 缓解 | 验证方式 |
|------|------|------|---------|
| 归因不可信导致优先级学歪 | 高 | 只在单层探索时归因；EMA 慢速更新（alpha=0.1）；离线回放验证 | 历史会话回放，人工核对归因合理性 |
| `beforeSession` 拖慢对话 | 高 | 超时保护 + 异常降级 EXPLOIT；纯计算无 I/O 快路径 | p99 延迟监控 + 压测 |
| 配置下发引入行为回归 | 高 | 每层 `applyConfig()` 独立开关，可单层关闭；A/B 对比 | 灰度 + 满意度趋势看板 |
| Skill 层无即时配置被静默跳过 | 中 | 显式映射为待审批目标，不允许静默无操作 | 单测断言产生目标 |
| 审批未接通导致协同哑火 | 高 | Task 3 与 A2 硬依赖排期；A2 未就绪则 EXPLORE_SKILL 暂时禁用 | 集成测试场景 2 |
| 多 Agent 并行污染全局状态 | 高 | 验证模式标志位禁写；并发上限 2 | 场景测试 + 状态快照对比 |
| 多 Agent token 成本失控 | 中 | 硬编码并发上限；成本预算熔断 | 成本监控 |
| P2 协同表建了却长期空表被误判为 bug | 低 | 本计划已记录成因；Task 1 后即有数据 | — |

---

## 十、P3 之后

P3 完成后，四层进化在协同调度下闭环运行，审批可在用户离线时安全处置，多 Agent 并行验证按需启用。届时可考虑的方向：

- **人格主动进化**：当前人格仍是被动累积（`evolutionEnabled` 控制是否应用 EMA）。主动进化指 Agent 根据长期目标有意识地调整人格倾向，需要更强的价值对齐保障。
- **Pareto 动态权重**：现在偏好选择是 `ParetoPreference = 'satisfaction' | 'speed' | 'cost' | 'balanced'`（`types.ts:726`）的静态映射，可学习用户在不同场景下的隐含偏好。
- **跨 Agent 经验共享**：多个 Agent 实例间共享进化成果，需先解决隐私边界。

**P3 明确不做**：跨层自动代码生成、无批准的外部操作、不可回滚的自我修改。这三条与 P2 保持一致（`p2.md:1492`），是安全底线而非能力限制。

---

## 附录：本计划与设计文档的偏差记录

| 设计文档说法 | 实际调整 | 原因 |
|------------|---------|------|
| P3 = 多层协同优化 + 多 Agent 自组织（`6-实施计划.md:729`） | P3 = 协同**接线** + 审批链路 + 多 Agent（选做） | 协同算法已在 P2 写完，缺的是接线；审批链路是新发现的硬阻塞 |
| 多 Agent 自组织为 P3 核心（`1-核心设计理念.md:373`） | 降为选做，加门控条件 | 编排层已存在，成本大降；但价值取决于探索是否真的排队，需先测量 |
| Shapley Value 完整计算（`5-多层进化协同.md:80`） | 默认走增量近似 | 协同调度保证每轮只变一层，与文档 §3.3 意图一致；完整版留给离线分析 |
| `evolution_coordination_history` 存协同历史（`5-多层进化协同.md:658`） | 另建 `coordination_scheduler_state` 存状态快照 | 事件流水与当前状态读写模式不同，混表会导致启动全表重放 |
| 四层配置统一切换 | Skill 层特殊处理为待审批目标 | `SkillEvolution` 无"每轮可切换配置"，只有离线缺口识别 |
