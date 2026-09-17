# Lumii Agent / 子 Agent 优化方案

> 日期：2026-08-26  
> 状态：设计草案（可评审后拆 implementation plan）  
> 前置分析：[2026-08-26-hermes-moa-对比分析.md](./2026-08-26-hermes-moa-对比分析.md)  
> 原则：保留 Lumii 角色化委派与 UI 同会话时间线；只吸收 Hermes 中与桌面产品匹配的约束与闭环。

---

## 0. 目标与非目标

### 0.1 目标

1. **异步委派闭环**：`spawn_agent(mode=async)` 完成后，结果以**新回合**安全回灌父会话，父 Agent 可汇总。
2. **护栏可配置且生效**：并发帽、摘要上限、深度语义与 `AgentDefinition` 字段接线，消灭「字段存在但未执行」。
3. **可观测子 Agent 生命周期**：统一状态机 + IPC/活动快照，UI 与调试可依赖。
4. **长任务不误杀**：进度优先的停滞检测，与现有 stuck-guard（内容/工具循环）互补。
5. （可选）编码并行时的 **worktree 隔离**；显式开启的 **顾问扇出**（轻量 MOA，非默认 provider）。

### 0.2 非目标

- 不把 MOA 做成默认模型 provider。
- 不引入 Kanban / 跨 profile 认领板。
- 不承诺「进程崩溃后复活子 Agent 执行树」（仅恢复**投递状态**或标记 unknown）。
- 不削弱 explore/plan/verify 只读与 VERDICT 闭环。
- 不把子 Agent 改成「父只见摘要、无时间线」——同 conversation 展示策略保留。

---

## 1. 架构定调（推荐方案）

在现有三件套上做**增量层**，不重写 orchestrator：

```text
                    ┌─────────────────────────────┐
                    │   AgentDefinition + 装配     │  （已有，补配置接线）
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │   AgentOrchestrator         │  （已有）
                    │   sync / async spawn        │
                    └──────┬───────────┬──────────┘
                           │           │
              ┌────────────▼──┐   ┌────▼────────────────────┐
              │ sync 摘要门禁  │   │ SubAgentDelivery (新)   │
              │ 截断/spill    │   │ 完成 → 新回合投递       │
              └───────────────┘   │ SQLite 投递状态(可选)   │
                                  └────┬────────────────────┘
                                       │
                    ┌──────────────────▼──────────────────┐
                    │ SubAgentLifecycle (新，轻量)         │
                    │ 状态机 + 父树校验 + activity 事件    │
                    └──────────────────┬──────────────────┘
                                       │
                    P2: WorktreeIsolation / AdvisorFanout（可选）
```

**推荐理由**：改动面集中在 `agent-runtime` + bridge，不碰模型选择主路径；与现有 MessageBus / Registry / VERDICT 正交。

### 备选方案（未采纳）

| 方案 | 优点 | 缺点 | 结论 |
|------|------|------|------|
| A. 完整移植 Hermes delegate/async/moa | 能力全 | 与 pi-agent-core / Electron / 同会话 UI 冲突大 | 否 |
| B. 仅文档规范、不改代码 | 成本低 | 异步半成品与并发字段仍失效 | 否 |
| **C. 增量闭环（本方案）** | 对齐产品；可分阶段 | 需谨慎处理「新回合」与 UI | **采纳** |

---

## 2. P0 — 必须先做（闭环与护栏）

### 2.1 异步完成：新回合投递协议

**问题**：async spawn 返回后父会话丢失结果，且若误把完成结果塞进当前 tool 间隙，会破坏角色交替 / prompt cache。

**设计**：

```text
父调用 spawn_agent(async)
  → 立即工具结果：{ instanceId, mode: async, status: accepted }
  → 子 Agent 在后台跑完
  → SubAgentDelivery.enqueue(completion)
  → 父实例空闲时：注入**新的 user/system 内部回合**（或 followUp 队列头部带明确标记）
     载荷：goal 摘要 + 截断后的 output + instanceId + status + resultHash
  → 父模型自然继续，向用户汇报
```

约束（对齐 Hermes §8）：

- **禁止**在「未结束的 assistant tool_calls」中间插入完成消息。
- 投递通道与 cron / 通道入站消息同一套「空闲后新回合」语义，避免三套注入逻辑。
- UI：时间线上标记 `origin: subagent_completion`，与用户输入区分。

**落地模块建议**：

- `packages/agent-runtime/src/agent/subagent-delivery.ts`（纯逻辑 + 测试）
- bridge：子 `waitForIdle` / `agent_end` 时调用 delivery；父 `prompt` 前后 drain

### 2.2 摘要上限与 spill

| 参数 | 建议默认 | 说明 |
|------|----------|------|
| `maxSummaryChars` | 24000 或按父上下文动态 headroom | sync 工具结果与 async 投递共用 |
| 超额策略 | 头尾保留 + 中间省略；全文写入会话附件或临时 cache，提示父用 `file_read` | 对齐 Hermes spill |

同步路径在 `AgentOrchestrator.spawnAgent` 返回前截断；verify 的 VERDICT banner **始终保留在截断窗口内**。

### 2.3 并发帽接线

`AgentDefinition.subagentMaxConcurrent`（及全局默认，建议 3–5，桌面低于 Hermes 的 10）：

- 在 `spawnAgent` 入口按**父实例**统计 `registry.getChildrenOf(parent)` 中 `state===running` 数量。
- 超限返回明确 error，引导主 Agent 等待或改 sync 串行。

### 2.4 深度语义澄清（配置化）

现状：子一律禁 spawn → 实际深度 1；代码却写 `MAX_SPAWN_DEPTH=3` 且 `spawnDepth` 未贯通。

**P0 决策**：

1. 文档与常量统一：**默认最大深度 = 1**（与当前 bridge 行为一致）。
2. 删除或降级 orchestrator 内误导性「深度 3」硬编码；深度改读 `definition.toolPermissions.delegation.maxDepth ?? 1`。
3. 若未来需要 orchestrator：仅当定义显式 `canSpawnSubAgents: true` **且** 父允许该子类型再委派时，才在子定义上放开 `spawn_agent`，并贯通 `spawnDepth`。**P0 不实现嵌套**，只把接口留干净。

### 2.5 硬约束清单（写入 runtime 注释 + 本设计）

在 `orchestrator.ts` / delivery 模块头部固化：

1. 异步结果 → 仅新回合。  
2. 子工具集 ⊆ 父（allowedTools ∪ definition 过滤后仍 ⊆）。  
3. 叶节点默认不可 `spawn_agent` / `send_message`。  
4. 压缩是唯一允许大规模改写历史的路径（已有 compact 引擎）。

### 2.6 P0 验收

- [ ] async spawn 后，子完成 → 父在空闲时收到可汇总的完成载荷；集成测试覆盖。  
- [ ] 超长 sync output 被截断且含省略提示；verify VERDICT 仍可见。  
- [ ] 并发超限返回可理解错误。  
- [ ] 深度默认语义与代码一致（文档 + 单测）。  
- [ ] 相关 vitest：`orchestrator`、新 `subagent-delivery`、bridge 级冒烟（若有）。

---

## 3. P1 — 生命周期与可控性

### 3.1 轻量状态机

对齐 Hermes 子集，避免 UNKNOWN/HMAC 全套：

```text
PENDING → STARTING → RUNNING → SUCCEEDED | FAILED | INTERRUPTED | CANCELLED
```

- 存放：`AgentRegistry` 旁路 `SubAgentRecord` Map，或扩展 instance 元数据。  
- IPC：扩展 `agent:activity:snapshot`，带 `status`、`parentInstanceId`、`startedAt`、`lastProgressAt`。  
- 进程退出：RUNNING 记录标记为 INTERRUPTED（同会话）；可选 SQLite 仅记 delivery 未送达项。

### 3.2 父树守卫的控制 API

| API | 行为 |
|-----|------|
| `interruptSubAgent(parentId, childId)` | 校验 descendant 后 abort |
| `steerSubAgent(parentId, childId, text)` | 校验后 `child.steer`（下一迭代边界生效，沿用 pi-agent-core） |
| `listSubAgents(parentId \| rootSessionKey)` | 树快照 |

暴露：agent-runtime 方法 + 可选 IPC / CLI（与现有 activity 快照统一）。

### 3.3 进度优先停滞检测

与 `stuck-guard` 并列，针对**长时间无事件**：

| 条件 | 建议阈值（可配） |
|------|------------------|
| 无 tool 执行且无 delta | idle 450s → 请求 interrupt |
| 正在执行工具 | in-tool 1200s → 请求 interrupt |
| 中断后仍未退出 | grace 120s → destroy + FAILED |

**不要**默认用「总运行时长」杀合法长任务（对齐 Hermes 哲学）。

### 3.4 可选：投递表持久化

表名建议：`subagent_deliveries`（挂现有 `agent-runtime.db`）

最小字段：`id, parent_instance_id, child_instance_id, state, delivery_state, payload_json, created_at, updated_at, result_hash`

- 崩溃：owner 进程不在 → `state=unknown`，投递「结果未知」提示。  
- 重放年龄：≤ 48h（防旧会话烧上下文）。

P1 可先做内存队列 + 状态机；SQLite 作为 P1.1。

### 3.5 P1 验收

- [ ] UI/IPC 能区分 RUNNING / SUCCEEDED / FAILED。  
- [ ] 非父实例无法 steer/interrupt 子实例（单测）。  
- [ ] 无进度超时触发优雅中断，有持续 delta 的长任务不被杀。

---

## 4. P2 — 增强（按需）

### 4.1 Git Worktree 隔离（opt-in）

适用：用户显式开启「并行子 Agent 写代码」。

```text
delegation.worktreeIsolation = true（设置项或 spawn 参数）
  → 仅在 Git 仓库内创建 .worktrees/lumii-subagent-<id>
  → 子 Agent cwd / 项目根指向 worktree
  → 结束报告：分支、相对 base 的 commit 数、dirty；探针失败则 inspection_failed=true，禁止假「干净」
  → 无新提交且干净 → 可删；否则保留待父/用户合并
```

非 Git 工作区：静默降级共享目录（不报错）。

### 4.2 轻量顾问扇出（Advisor Fan-out，非完整 MOA）

**形态**：会话级开关或单次工具 `consult_models`，而不是虚拟 provider。

```text
用户开启「多模型参谋」
  → 仅在用户回合开始并行调用 1–2 个参考模型（无工具）
  → 建议块注入本轮主模型提示
  → 主模型仍是唯一工具执行者
```

成本控制：

- 默认 `fanout: user_turn`；并发 ≤ 2（桌面）  
- 参考输出字符上限；失败策略 silent/loud  
- Trace opt-in，不进会话历史  

**明确不做**：per_iteration 默认、把 MOA 写进模型选择器主路径（除非产品后续单独立项）。

### 4.3 插件安全生命周期（若插件监督子 Agent）

仅当出现「第三方插件可 launch/wait 子 Agent」时，再引入：

- 不可变 LaunchRequest 合约  
- HMAC 句柄或至少 signed token  
- toolsets ⊆ 父  

当前同进程 bridge 不必提前做。

---

## 5. 与现有能力的整合矩阵

| 现有能力 | 与优化关系 |
|----------|------------|
| builtin explore/plan/verify | 保持；摘要截断不得丢掉 VERDICT |
| verification-gate-hook | 继续；async verify 完成投递后父仍应看到 banner |
| MessageBus / send_message | 保留团队协作；叶节点继续禁 send |
| stuck-guard | 保留；P1 叠加进度停滞 |
| compact / context 引擎 | 唯一历史改写路径；delivery 不得绕过 |
| CapabilityRegistry origin | subagent origin 可继续与 local_ui 同权或略收窄 shell（产品决定） |
| Cron | 跨重启耐久继续用 cron，不与 async spawn 混为一谈 |

---

## 6. 实施顺序与包边界

| 阶段 | 主要改动包 | 风险 |
|------|------------|------|
| P0 | `packages/agent-runtime` + `apps/windows` bridge / IPC 事件类型 | 中：注入时序与 UI |
| P1 | 同上 + 可选 schema 迁移 | 中：状态与 abort 竞态 |
| P2 worktree | windows bridge + git 工具链 | 中：清理策略 |
| P2 advisor | agent-runtime + 设置 UI | 高：成本与隐私，需显式开关 |

建议每个阶段先写 `docs/plans/YYYY-MM-DD-...-implementation.md`，再按任务拆 PR。

---

## 7. 配置面草案（概念）

落在设置或 `AgentDefinition` / 全局 runtime config（名称可调整）：

```yaml
delegation:
  maxConcurrentChildren: 4          # 覆盖 definition 缺省
  maxSpawnDepth: 1
  maxSummaryChars: 24000
  childTimeoutMs: 0                 # 0=关闭墙钟；与 stale 正交
  staleIdleMs: 450000
  staleInToolMs: 1200000
  staleGraceMs: 120000
  worktreeIsolation: false          # P2
advisor:
  enabled: false                    # P2
  fanout: user_turn
  maxReferenceModels: 2
  saveTraces: false
```

写入路径校验严格；读取路径 normalize 降级（Hermes 模式 3）。

---

## 8. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 新回合投递被用户当成用户消息 | UI 标签 + 内部 origin；文案「子任务完成」 |
| 截断导致父丢关键结论 | VERDICT/首尾保留；spill 路径 |
| 并发帽过低影响体验 | 默认可配；错误信息指导改 sync |
| worktree 残留磁盘 | 保守清理 + 设置页「清理隔离工作树」 |
| 顾问扇出隐私 | 默认关；可选脱敏（邮箱/电话）后再考虑 full |

---

## 9. 成功标准（产品视角）

1. 用户要求「后台调研」时，主对话在子任务结束后能自动收到可理解的汇总，而无需用户再问「好了吗」。  
2. 并行多个子 Agent 时，不会无限制拖垮本机；超限有明确反馈。  
3. 活动面板能看到子 Agent 状态，并可安全停止自己的子任务。  
4. 长命令运行中的子 Agent 不会仅因「时间久」被杀；真正卡死仍能打断。  
5. 默认路径成本不因「对齐 Hermes」而翻倍（无默认 MOA）。

---

## 10. 下一步

评审本方案后建议：

1. 确认 P0 投递载体：`followUp` vs 显式 internal user turn（需对照 pi-agent-core 行为）。  
2. 确认 async 完成是否仍写入同一 conversation（推荐：是，带 origin 标记）。  
3. 拆 `docs/plans/2026-08-XX-subagent-delivery-implementation.md` 并开 PR。
