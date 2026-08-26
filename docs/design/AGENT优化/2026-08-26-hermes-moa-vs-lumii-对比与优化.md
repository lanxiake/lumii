# Hermes MOA ↔ Lumii Agent 协作体系：对比与优化方案

> **文档版本**: v1.0  
> **日期**: 2026-08-26  
> **对照源**: Hermes-Agent `docs/MOA-Agent-Architecture-Guide.md`（v1.1）  
> **目标读者**: 架构 / agent-runtime / Electron bridge 维护者  
> **产出性质**: 设计分析与优化路线（非实现计划）；落地时另开 `docs/plans/` 实施文档。

---

## 1. 结论摘要

Lumii 与 Hermes 解决的是**相邻但不同**的协作问题：

| 项目 | 重心 | 已成熟能力 |
|------|------|-----------|
| **Hermes** | 模型级混合（MOA）+ 通用委派树 + 异步投递耐久 + worktree 隔离 | 虚拟 provider、生命周期 HMAC、SQLite 委派恢复、进度式停滞检测 |
| **Lumii** | 角色化子 Agent（explore/plan/verify）+ 定义驱动权限 + 桌面宿主集成 | `AgentDefinition`、Router、VERDICT、StuckGuard、多层压缩、MessageBus、IPC 活动快照 |

**不宜整包移植 MOA。** 桌面端成本敏感，且 Lumii 已用「专家子 Agent」替代了部分「多模型投票」需求。优先补齐 **异步委派闭环、并发/深度语义一致、生命周期可观测与可控、可选工作树隔离**；MOA 仅作为高风险决策的**可选顾问扇出**评估项（P3）。

当前最大产品缺口：提示词要求主 Agent「`spawn_agent mode=async` 后等待依赖」，但运行时 async **不向父回合投递完成结果**——委派语义与实现脱节。

---

## 2. Hermes 四层协作 vs Lumii 映射

Hermes 自述为四层递进 + 旁路 Kanban：

```
模型级 MOA → 任务级 delegate_task → 后台 async_delegation → 文件级 worktree
旁路：Kanban（跨 profile）；耐久：cron / terminal notify
```

映射到 Lumii：

| Hermes 层 | Lumii 对应 | 成熟度 | 说明 |
|-----------|------------|--------|------|
| L1 模型级 MOA | **无**（单模型 turn；`modelTier` / purpose 槽选模型） | ❌ | 无参考扇出 / 聚合器 |
| L2 任务级委派 | `spawn_agent` + `AgentOrchestrator` + 内置/用户 Agent 定义 | ✅ 主体有，边界硬 | 默认子 Agent **禁止再委派**（bridge 强制） |
| L3 异步委派 | `mode: "async"` | ⚠️ 半成品 | 有创建与后台 prompt，无完成投递 / 持久化 / 崩溃恢复 |
| L4 工作树隔离 | 项目 Git / 开发者 worktree（**非**子 Agent 运行时隔离） | ❌ | 并行子 Agent 共享 cwd |
| 旁路多 Agent 板 | AI 团队 + MessageBus `send_message` +（设计中的）execution plan | 🟡 | 协作面不同，非 Kanban 队列 |
| 跨重启耐久 | `cron` / scheduled origin | 🟡 | 与子 Agent 树无关，符合 Hermes「async ≠ 跨进程复活」原则 |

---

## 3. 现状快照（Lumii）

### 3.1 主路径

```
主 Agent（assistant）
  └─ spawn_agent(name, prompt, agentType?, mode?, allowedTools?)
        └─ AgentOrchestrator.spawnAgent
              ├─ resolveDefinition(agentType | "assistant")
              ├─ createChildInstance（bridge：强制 canSpawnSubAgents=false，剥离 spawn/send）
              ├─ sync：prompt → waitForIdle → 返回 output（verify 可解析 VERDICT）→ destroy
              └─ async：prompt 后立即返回 instanceId（无完成回调到父）
```

### 3.2 权限与角色

| 机制 | 位置 | 行为 |
|------|------|------|
| 子 Agent 工具硬屏蔽 | `CHILD_AGENT_DISALLOWED_TOOLS` | `spawn_agent`、`send_message` |
| 定义级黑名单 | `builtin:explore/plan/verify` | 写文件、再委派、ask_user 等 |
| `canSpawnSubAgents` | bridge `createChildInstance` | **一律 false**（覆盖定义） |
| 深度上限 | `MAX_SPAWN_DEPTH = 3` | orchestrator 有检查，但 **spawnDepth 未写入子实例上下文**，且子侧工具已摘除 → 实际深度恒为 1 |
| 并发上限 | `subagentMaxConcurrent` | 仅类型/API 映射，**运行时未强制** |
| 提示词角色约束 | `system-prompt-builder` `isSubAgent` | 禁止再 spawn / todo_write；要求短摘要 |

### 3.3 已有优势（应保留）

1. **专家型子 Agent**：explore（只读搜索）/ plan（架构）/ verify（对抗验证 + VERDICT 消费）比通用 leaf 更贴合编码助手场景。  
2. **定义驱动**：`AgentDefinition`（工具、权限模式、maxTurns、记忆 scope、allowedSubAgents）可下发与缓存。  
3. **StuckGuard**：工具指纹循环 + assistant 文本重复 → steer → 冷却后 abort；进度式思路接近 Hermes stale，但作用域是单实例循环而非「后台委派空闲」。  
4. **压缩与预算**：多层 compact、turn token budget；子 Agent 提示词裁剪（`isSubAgent`）。  
5. **宿主可观测**：`agent:activity:snapshot`、父子 registry、IPC 事件流。  
6. **用户插话 steer**：`AgentInstance.steer` 与 pi-agent steering queue 已打通（用户侧，非父→子控制 API）。

---

## 4. 维度对照表

| 维度 | Hermes | Lumii | 差距等级 |
|------|--------|-------|----------|
| 建议权 vs 执行权分离 | MOA 参考模型无工具；仅 aggregator 执行 | 无模型级顾问层；专家子 Agent 仍可执行（explore 只读） | P3（可选） |
| 委派入口 | `delegate_task` + 插件 lifecycle 包装 | `spawn_agent`（stub + bridge override） | — 形态不同即可 |
| 角色 | leaf / orchestrator | 定义 ID（builtin:* / 用户 Agent）；无 orchestrator 再委派角色 | P2（按需） |
| 工具收敛 | blocklist + toolsets ⊆ 父 | 硬屏蔽 + 定义 disallowed + 可选 allowedTools | P1 对齐「子集校验」 |
| 深度 | 默认 1，可配 | 文档/代码宣称 3，实际 1 | **P0 语义清理** |
| 异步结果投递 | **新回合**注入，保 role 交替与 prompt cache | 无标准投递 | **P0** |
| 异步耐久 | SQLite delivery_state + PID 双重所有权 | 进程内即失 | P1（先进程内闭环，再谈 DB） |
| 停滞检测 | 进度空闲阈值（非默认墙钟杀） | StuckGuard（循环）+ `timeoutMs`（定义） | P1 补后台 idle stale |
| 父控子 | interrupt / steer / pause spawn | 无公开父→子 API | P1 |
| 生命周期合约 | 状态机 + HMAC handle | Registry + activity 快照 | P1（内部可简化，不必照搬 HMAC） |
| 结果完整性 | SHA256 result_hash | 无 | P2 |
| 摘要边界 | max_summary_chars + spill | sync 全量 output 回灌 | P1 |
| 文件隔离 | opt-in worktree | 共享工作区 | P2 |
| 成本旋钮 | fanout 节奏、reference max tokens、并发帽 | modelTier / maxTurns / compact | P1 并发帽；P3 MOA |
| 隐私 | MOA PII 三级模式 | 无跨模型顾问脱敏需求 | P3 随 MOA |
| Prompt cache 硬约束 | 显式文档化 | compact 是改写历史主路径；async 缺口会破坏约定 | P0 与投递一并规范 |

---

## 5. 关键缺口详解（必须先修认知）

### 5.1 异步委派「假等待」

`buildTaskOrchestrationSection` 明确写：

> start parallel tasks with `spawn_agent mode=async`, and wait for all `dependsOnIndex` tasks…

实现上（`orchestrator.ts`）：

- async 仅 `void prompt(...).catch(...)` 后返回 `instanceId`；  
- **不**在子 Agent `waitForIdle` 后 `followUp` / 新回合投递给父；  
- sync 路径才会销毁子实例并返回 `output`。

后果：模型按提示词并行委派后，要么空等、要么臆造结果。这是协作栈最高优先级缺陷。

### 5.2 深度限制「双轨不一致」

| 声明 | 实际 |
|------|------|
| orchestrator：`MAX_SPAWN_DEPTH = 3`，`spawnDepth` 注入 createChild | bridge **忽略** `opts.spawnDepth`；强制 `canSpawnSubAgents: false` |
| 提示词：子 Agent Do NOT spawn | 工具层已无 `spawn_agent` |

建议统一为：**产品语义深度 = 1（扁平委派）**；若未来要 orchestrator 嵌套，再显式开启 `delegation.maxDepth` 与角色例外，并真正贯通 `_spawnDepth`。

### 5.3 `subagentMaxConcurrent` 未落地

字段存在于 `AgentDefinition` / API mapper，spawn 路径无闸门。并行 async 可打满模型与磁盘 IO。

### 5.4 sync 结果无摘要硬顶

长 explore/verify 输出整段进入父工具结果，易挤爆父上下文；Hermes 有 `max_summary_chars` + spill。Lumii 子提示词已要求「1–3 句摘要」，但**缺少运行时截断护栏**。

---

## 6. 优化原则（吸收 Hermes，贴合 Lumii）

1. **职责单一，权限只减不增**：子 Agent 工具集 ⊆ 父可见集 ∩ 定义允许集；禁止在 spawn 参数中「越权加工具」。  
2. **数据流与控制流分离**：顾问/只读探索不写共享记忆；verify 结论结构化（已有 VERDICT）优先于长文。  
3. **异步结果必须新回合投递**：禁止插入当前 tool/assistant 间隙，保护 role 交替与缓存前缀（与 Hermes §8 对齐）。  
4. **进度优先于墙钟**：后台子 Agent 默认用 idle/in-tool stale，而非一律 timeout 杀死合法慢任务。  
5. **配置写严读宽**：委派配置校验失败拒绝写入；读路径缺省安全默认值。  
6. **YAGNI**：不引入虚拟 MOA provider，直到有明确「多模型投票」产品场景与成本预算。  
7. **保留 Lumii 差异化**：builtin 专家、Router、VERDICT、Definition Store、桌面 IPC，不改为 Hermes 通用 leaf 模型。

---

## 7. 分阶段优化方案

### 阶段 A — P0：语义闭环与诚实契约（建议 1～2 周量级）

#### A1. 异步完成投递通道

**目标**：`mode=async` 完成后，父会话收到可消费的结果，且不破坏消息交替。

**建议设计**：

```
子 Agent idle/end
  → SubagentCompletionEvent { parentId, childId, status, summary, spillPath? }
  → 写入父实例「投递队列」（进程内）
  → 父空闲时开启内部 origin=internal|subagent 的新 user/system 回合
     （文案模板：【子任务完成】name=… status=…\nsummary…）
  → 可选：同步推 IPC `agent:subagent:completed` 供 UI
```

约束：

- **禁止**把完成结果拼进正在进行的 tool_result 与下一条 assistant 之间。  
- 父正在 running 时入队，idle 后再投（对齐 Hermes completion_queue）。  
- sync 保持现状（工具结果内返回），与 async 通道分离。

#### A2. 统一深度与提示词

- 文档与代码统一：**默认 maxDepth = 1**。  
- 删除或降级未接线的 `MAX_SPAWN_DEPTH = 3` 误导；或接线但默认仍为 1。  
- Task Orchestration 段改为依赖真实 API：例如「async 完成后系统会注入完成通知；在收到通知前不要假设结果」。

#### A3. 运行时并发帽

- 实现 `subagentMaxConcurrent`（定义缺省如 3～5，全局硬顶如 10）。  
- sync + async 共用计数；超额返回明确 error，供模型改串行。

**验收**：

- 双 async explore 并行结束后，父各收到一次完成投递并可综合回复。  
- 子 Agent 无法再 spawn；深度相关单测与 bridge 行为一致。  
- 并发超额有稳定错误文案。

---

### 阶段 B — P1：可控、可观测、可恢复（进程内）

#### B1. 子 Agent 生命周期状态机（内部）

最小状态集（可少于 Hermes）：

```
PENDING → RUNNING → SUCCEEDED | FAILED | CANCELLED | STALE
```

暴露给 bridge / UI：

- `listChildren(parentId)`  
- `interruptChild(childId)`（协作式，下一迭代边界）  
- `steerChild(childId, text)`（复用已有 `AgentInstance.steer`）  
- 仅允许操作**自己的后代**（registry 父子链校验）

不必首版引入 HMAC 插件句柄；Electron 主进程单信任域可先用内部 ID。若未来插件/外部 CLI 监督子 Agent，再加 capability 签名（Hermes 模式 1）。

#### B2. 后台停滞检测

在 StuckGuard（循环）之外，为 **async 子 Agent** 增加进度心跳：

| 条件 | 建议阈值 | 动作 |
|------|----------|------|
| 无工具执行且无文本增量 | idle > N 秒（可配，参考 450s 量级可下调） | interrupt + 向父投递 `STALE` |
| 长工具执行中 | 更宽阈值 | 仅告警或延长 |
| 定义 `timeoutMs` | 墙钟帽（可选） | 与 stale 正交 |

#### B3. sync/async 摘要护栏

- 硬顶字符数（如 24k 或按父上下文动态 headroom）。  
- 超限：截断 + 写入 cache/spill 文件，父结果中附 `read_file`/`file_read` 路径提示。  
- verify 的 VERDICT 行**永不截断**（保证结构化结论）。

#### B4. 工具子集校验

spawn 时 `allowedTools` 必须 ⊆ 父当前工具名集；禁止通过参数恢复 `spawn_agent` / `send_message`（已有 filter，补测试与错误信息）。

#### B5. 可观测性

- 结构化日志：spawn / complete / stale / interrupt。  
- IPC：扩展 activity snapshot（含 depth、mode、startedAt、lastProgressAt）。  
- 可选 JSONL 委派 trace（默认关，对齐 Hermes opt-in）。

**验收**：UI 可中断失控子 Agent；长输出不爆父上下文；并发与子集有单测。

---

### 阶段 C — P2：隔离与嵌套（按产品需求启用）

#### C1. Opt-in Git Worktree 隔离

适用：多个**可写**子 Agent 并行改同一仓库。

```
delegation.worktreeIsolation: false  # 默认关
启用后：
  create worktree → 子 cwd 指向 worktree → finalize 报告 branch/commits/dirty
  探针失败 → inspection_failed，禁止「0 commits / clean」假阴性
  非 git 目录 → 静默降级共享 cwd
```

只读 explore/plan/verify 默认**不必**开 worktree（成本高于收益）。

#### C2. Orchestrator 角色（可选）

仅当产品需要「二级拆分」时：

- `AgentDefinition.toolPermissions.delegation.maxDepth` 与 `canSpawnSubAgents` 真正生效。  
- `role=orchestrator` 或定义标记允许再 spawn，但仍 ⊆ 父权限。  
- 默认关闭，避免成本乘数。

#### C3. 结果哈希（可选）

对 async 投递 payload 做 `result_hash`，便于调试与防篡改审计；非桌面主路径阻塞项。

---

### 阶段 D — P3：模型级协作（谨慎评估）

#### D1. 是否引入 MOA？

| 赞成 | 反对 |
|------|------|
| 高风险决策多模型交叉验证 | 桌面订阅成本 ×N；延迟；隐私 |
| 与「选模型」同一 UX（虚拟 provider） | Lumii 已有 plan/verify 角色分工 |
| | 实现与缓存/压缩交互复杂 |

**建议**：不作为近端路线。若做，采用 **窄场景顾问扇出**：

- 仅用户显式开启的「审慎模式」或特定 skill；  
- 参考模型无工具、有输出预算、fanout=`user_turn`；  
- 聚合器 = 当前会话主模型；  
- Trace 默认关闭；可选 PII filter。  

实现形态可参考 Hermes「虚拟 provider」，但挂在 Lumii 的 purpose/model 解析链，而非复制整套 Python 模块。

#### D2. 不建议照搬的部分

- Kanban 跨 profile 板（除非产品明确要任务认领系统）。  
- 插件 HMAC 生命周期公共 API（无插件监督需求前）。  
- 子 Agent 默认 max_iterations 远大于父（Lumii 用定义 maxTurns 已可配；explore 30 / plan 40 更省）。

---

## 8. 推荐目标架构（演进后）

```
                    ┌─────────────────────────────┐
                    │  Session / Compact / Cache  │
                    │  （唯一主动改写历史：compact） │
                    └──────────────┬──────────────┘
                                   │
                    ┌──────────────▼──────────────┐
                    │     AgentInstance (主)       │
                    │  Router · Definition · Tools │
                    └──────┬─────────────┬────────┘
                           │             │
              ┌────────────▼──┐    ┌─────▼──────────────┐
              │ spawn_agent   │    │ （可选 P3）顾问扇出  │
              │ sync | async  │    │ 无工具参考 → 注入    │
              └──────┬────────┘    └────────────────────┘
                     │
         ┌───────────┼───────────┐
         ▼           ▼           ▼
   builtin:*    用户 Agent    worktree?(P2)
   explore/plan/verify
         │
         ▼
   Completion Broker (P0)
   · 新回合投递 · 并发帽 · stale · interrupt/steer(P1)
```

控制权：仅主会话（及显式 orchestrator）可委派。  
数据权：子结果以摘要 + 可选 spill 进入父；完整 transcript 不默认回灌。

---

## 9. 与现有模块的落点建议

| 改动 | 建议落点 |
|------|----------|
| 完成投递 / 并发帽 / 深度配置 | `packages/agent-runtime`：`AgentOrchestrator` + 新 `subagent-broker.ts` |
| 状态机 / interrupt / steer 后代校验 | `agent-registry` + orchestrator API |
| bridge 接线 spawnDepth、投递泵、IPC | `bridge-lifecycle.ts` / `bridge-tool-registrar.ts` |
| 摘要截断 | orchestrator sync 返回前 + async 投递前 |
| 提示词诚实化 | `agent-collaboration-section.ts` |
| worktree | 新模块 + Windows bridge cwd 注入；默认关 |
| 配置默认值 | `AgentDefinition` 或宿主 config（写严读宽） |
| 测试 | `orchestrator.test.ts` 扩 async 投递；bridge 集成测并发与子集 |

---

## 10. 非目标（本方案明确不做）

- 将 Lumii 主循环替换为 Hermes `run_agent.py` 结构。  
- 默认开启多模型 MOA。  
- 让 async 子 Agent 跨应用重启后「复活执行」（跨重启用现有 cron/scheduled）。  
- 为子 Agent 开放 `send_message` 广播（保持副作用收敛；团队协作仍由主 Agent 编排）。  
- 在 wiki/记忆写入路径上让子 Agent 默认 `memory.scope=user`（builtin 已为 `none`，保持）。

---

## 11. 风险与迁移

| 风险 | 缓解 |
|------|------|
| 新回合投递改变主 Agent 行为，旧会话习惯「async 即不管」 | 投递文案明确；UI 角标；默认仍鼓励 sync |
| 并发帽过严导致模型反复报错 | 错误信息指导改 sync/串行；默认值可调 |
| worktree 在 Windows 路径/权限问题 | opt-in；失败降级；充分单测 |
| 提示词与实现短期不一致 | A2 与 A1 同 PR 合并 |

---

## 12. 建议落地顺序（一句话）

**先让 async 真的能把结果送回父会话并统一深度/并发语义（A），再补生命周期与摘要/stale（B），有并行写冲突再开 worktree（C），最后才评估窄场景 MOA（D）。**

---

## 附录 A：代码锚点速查

| 主题 | Lumii 路径 |
|------|------------|
| 编排入口 | `packages/agent-runtime/src/agent/orchestrator.ts` |
| spawn 工具 | `packages/agent-runtime/src/tools/built-in/spawn-agent-tool.ts` |
| 内置定义 | `packages/agent-runtime/src/agent/builtin/definitions.ts` |
| 子工具屏蔽 | `apps/windows/src/main/agent-runtime/bridge-utils.ts` |
| 子实例创建 | `apps/windows/src/main/agent-runtime/bridge-lifecycle.ts` `ensureOrchestrator` |
| 协作提示词 | `packages/agent-runtime/src/prompt/sections/agent-collaboration-section.ts` |
| 卡死检测 | `packages/agent-runtime/src/reliability/stuck-guard.ts` |
| 定义类型 | `packages/agent-runtime/src/types/agent-definition.ts` |
| Hermes 对照 | `E:/open-source-project/hermes-agent/docs/MOA-Agent-Architecture-Guide.md` |

## 附录 B：术语对照

| Hermes | Lumii |
|--------|-------|
| `delegate_task` | `spawn_agent` |
| leaf / orchestrator | `canSpawnSubAgents` + 定义 ID（建议未来显式 role） |
| async_delegation + SQLite | （待建）Completion Broker；近端进程内队列 |
| Capability HMAC handle | 内部 instanceId（未来可加强） |
| MOA virtual provider | （无）；可选「审慎模式」顾问扇出 |
| subagent worktree | （待建）opt-in isolation |
| Stuck / stale（进度） | StuckGuard（循环）+（待建）async stale |

---

> 本文基于 Hermes 指南 v1.1 与 Lumii 当前源码静态对照。实现前请再跑一轮相关测试与类型检查，并以符号名为准核对行号漂移。
