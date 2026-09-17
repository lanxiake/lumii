# Hermes MOA / 子 Agent 架构 vs Lumii 对比分析

> 日期：2026-08-26  
> 状态：分析定稿（供优化方案引用）  
> 对照文档：Hermes-Agent `docs/MOA-Agent-Architecture-Guide.md` v1.1  
> Lumii 代码锚点：`packages/agent-runtime/src/agent/*`、`tools/built-in/spawn-agent-tool.ts`、`apps/windows/src/main/agent-runtime/bridge-lifecycle.ts`

---

## 0. 结论摘要

| 维度 | Hermes | Lumii 现状 | 差距性质 |
|------|--------|------------|----------|
| 协作分层 | 四层：MOA → 委派 → 异步调度 → worktree | 单层主路径：`spawn_agent` + MessageBus；无模型级扇出 | Lumii **缺第 1/3/4 层**；第 2 层有雏形 |
| 子 Agent 模型 | 通用 leaf / orchestrator + 工具 blocklist | **预制角色** explore/plan/verify + `AgentDefinition` | Lumii **产品化更强**；Hermes **运行时护栏更完整** |
| 异步委派 | SQLite 投递状态、崩溃恢复、**新回合**注入 | `mode=async` 仅 fire-and-forget，无完成回灌协议 | **高优先级缺口** |
| 生命周期 | 显式状态机 + Capability HMAC 句柄 | Registry 父子树 + running/idle；无公共合约 | 中优先级 |
| 并行隔离 | 可选 Git worktree | 共享工作区；无子 Agent worktree | 中后期 |
| 故障与停滞 | 进度优先 stale 检测 | 内容/工具循环 stuck-guard；无「无进度」墙钟互补 | 部分重叠 |
| 安全边界 | 权限逐级收敛；叶节点禁用户交互/共享 memory | 子实例强制 `canSpawnSubAgents=false` + 禁 `spawn_agent`/`send_message`；内置只读 | 方向一致，配置面不足 |

**总判**：Hermes 是「通用 Agent 操作系统」式协作栈；Lumii 是「桌面助手 + 角色化委派」产品栈。可迁移的是**模式与约束**，不是模块一一拷贝。

---

## 1. Hermes 四层协作（对照基线）

Hermes 用四层解决不同粒度问题：

```text
第1层 模型级协作     MOA（参考模型扇出 → Aggregator 唯一执刀）
第2层 任务级派发     delegate_task（sync / batch / background）
第3层 后台调度       async_delegation（SQLite 投递 + 崩溃恢复）
第4层 文件级隔离     subagent_worktree（opt-in）

旁路：Kanban（跨 profile，不挂在委派树）
耐久：cron / terminal notify（跨进程；async 委派仅进程内 runner）
```

核心原则（与 Lumii 对齐时最有价值）：

1. **职责单一、权限最小化**：顾问无执行权；子 Agent 工具集 ⊆ 父；叶节点默认不可再委派。
2. **边界清晰、可观测**：每层独立追踪面；状态机明确。
3. **故障隔离、优雅降级**：单参考失败不影响回合；探针失败不假报「干净」。
4. **成本可控**：扇出节奏、token 预算、并发帽。
5. **Prompt 缓存与角色交替不可破坏**：异步结果必须**新回合**注入，禁止塞进 tool/assistant 间隙。

---

## 2. Lumii 当前协作栈（已验证）

### 2.1 主路径

```text
用户 / 通道
    │
    ▼
AgentInstance（pi-agent-core 循环）
    │ spawn_agent 工具
    ▼
AgentOrchestrator.spawnAgent
    ├─ sync：prompt → waitForIdle → 销毁子实例 → 把 output 写入工具结果
    └─ async：prompt 后台 → 立即返回 instanceId（无完成事件协议）
    │
    ├─ MessageBus + send_message（进程内邮箱 + followUp）
    └─ AgentRegistry（parentOf / childrenOf，级联 destroy）
```

关键实现：

| 模块 | 路径 | 职责 |
|------|------|------|
| 编排器 | `packages/agent-runtime/src/agent/orchestrator.ts` | sync/async spawn、send_message、活动列表；硬编码 `MAX_SPAWN_DEPTH=3` |
| 工具 stub | `.../tools/built-in/spawn-agent-tool.ts` | Schema；真实 execute 由 bridge 覆盖 |
| Bridge 装配 | `apps/windows/.../bridge-lifecycle.ts` | `createChildInstance`：强制禁再委派；合并 `CHILD_AGENT_DISALLOWED_TOOLS` |
| 内置角色 | `.../agent/builtin/definitions.ts` | assistant + explore/plan/verify |
| 验证闭环 | `verdict-parser` + `verification-gate-hook` | sync verify 输出 VERDICT；task_complete 软提醒 |
| 卡死防护 | `stuck-detection` + `reliability/stuck-guard` | 重复 assistant 文本 + 工具指纹循环 |
| 定义面 | `types/agent-definition.ts` | maxTurns、canSpawnSubAgents、subagentMaxConcurrent、delegation 权限字段等 |

### 2.2 子 Agent 安全现状

`bridge-lifecycle.createChildInstance`：

- 一律 `canSpawnSubAgents: false`
- 追加禁止：`spawn_agent`、`send_message`（`CHILD_AGENT_DISALLOWED_TOOLS`）
- 可选 `allowedTools` 白名单（父传入）
- 内置 explore/plan/verify：`permissionMode: readOnly`，禁写文件与用户提问

效果上接近 Hermes 的 **leaf 默认**，但：

- **没有** orchestrator 角色逃生口（深度嵌套被物理关掉，而非可配置）
- Orchestrator 里的 `_spawnDepth` / `spawnDepth` **未真正贯通**：`createChildInstance` 未把 `spawnDepth` 写入子实例；工具 Schema 也不暴露 `_spawnDepth`。当前深度限制对「子再 spawn」几乎是死代码，因为子已无 `spawn_agent`。

### 2.3 异步路径缺口（相对 Hermes §5）

| Hermes 要求 | Lumii |
|-------------|-------|
| `background=true` 立即返回 handle | 有（async 模式） |
| 完成后 **新回合** 投递结果 | **无**：父只收到「正在后台运行」工具结果 |
| SQLite 投递状态 / 崩溃标记 unknown | **无** |
| 进度停滞检测（idle/in-tool 不同阈值） | **无**（仅有内容循环 stuck） |
| 摘要硬顶 + spill 到 cache | **无**（sync 全量 output 回灌工具结果） |

### 2.4 与 Hermes 不对齐但合理的产品差异

| Lumii 选择 | 理由 |
|------------|------|
| 预制 verify + VERDICT 消费 | 桌面编码场景需要「对抗性验收」，而非通用委派摘要 |
| 子消息写入**同一 conversationId** | UI 时间线合并子 Agent parts，产品体验优先 |
| CapabilityRegistry 按 `AgentTurnOrigin` 过滤 | 云通道最小权限，与 Hermes HMAC 句柄解决不同问题 |
| 多层上下文压缩 | 长会话成本控制；Hermes 有 ContextCompressor，语义相近 |

---

## 3. 维度对照表

### 3.1 协作范式

| 范式 | Hermes | Lumii | 建议 |
|------|--------|-------|------|
| 模型级扇出（MOA） | 虚拟 provider + fan-out | 无 | **P2 可选「顾问回合」**，不作默认 provider |
| 同步子 Agent | `delegate_task` | `spawn_agent` sync（默认） | 保持；补摘要上限 |
| 异步子 Agent | + SQLite 投递 | 半成品 | **P0 闭环** |
| Agent 间消息 | 委派摘要为主 | MessageBus + send_message | 保留；子侧禁 send 合理 |
| 文件隔离 | worktree opt-in | 无 | **P2**，仅编码/并行写场景 |
| 看板/跨 profile | Kanban 旁路 | 无对等物 | 暂不引入 |

### 3.2 生命周期与控制面

| 能力 | Hermes | Lumii | 差距 |
|------|--------|-------|------|
| 状态机 | PENDING→…→SUCCEEDED/FAILED/… | instance.state + Registry | 缺统一 SubAgent 状态枚举与对外 API |
| 句柄安全 | Capability HMAC + 父 session 绑定 | instanceId 明文 | 桌面同进程风险较低；插件化后再要 HMAC |
| interrupt | 迭代边界请求停止 | abort / abortWithChildren | 有，需对齐「子树」语义文档化 |
| steer | 下一工具结果边界注入 | `AgentInstance.steer` 已有 | **未作为子 Agent 一等控制面暴露给 UI/父工具** |
| 后代校验 | `_is_descendant_of` | Registry parentOf | 有树；缺「仅父可 steer/stop」显式守卫 |
| 最近完成表 | FIFO 200，归因晚到通知 | 无 | 异步补齐时一并做 |

### 3.3 配置与成本

| 项 | Hermes 默认 | Lumii | 备注 |
|----|-------------|-------|------|
| 最大深度 | 1（可配） | 代码 3，但子禁 spawn → 实际 1 | 应对齐为**可配置默认 1** |
| 子迭代预算 | 250（父 90） | 按 AgentDefinition.maxTurns（explore 30 / plan 40 / verify 60 / assistant 80） | Lumii 更细，优于 Hermes 一刀切 |
| 并发帽 | max_concurrent_children=10 | `subagentMaxConcurrent` 字段存在，编排器**未强制执行** | **P0 落地** |
| 摘要上限 | 24000 + headroom | 无 | sync 大输出易撑爆父上下文 |
| 扇出节奏 | user_turn / every_n / per_iteration | N/A | 仅未来顾问层需要 |

### 3.4 可观测性

| 表面 | Hermes | Lumii |
|------|--------|-------|
| 活动列表 | list_active_subagents | `getActiveAgents` + `agent:activity:snapshot` IPC |
| Trace | MOA JSONL opt-in；async SQLite | 工具遥测 / perf 聚合；无委派专用时间线表 |
| 进度事件 | moa.progress / subagent RPC | message:delta 等；缺「委派阶段」事件 |

---

## 4. Lumii 相对 Hermes 的优势（应保留）

1. **角色化内置子 Agent**：explore（快、只读、basic）、plan（架构、performance）、verify（对抗验证 + VERDICT），比「万能 leaf」更符合产品叙事。
2. **验证门禁**：`verification-gate-hook` 在 task_complete 时软提醒，逼主 Agent 真实验收，而不是只靠摘要。
3. **定义驱动装配**：`AgentDefinition` + `filterToolsByDefinition` + host-kit，权限与人格数据源清晰（含 API/离线兜底）。
4. **UI 时间线一体**：子 Agent 与父同 conversation，渲染层可合并 parts——Hermes「父只看摘要」在聊天产品里反而更难用。
5. **卡死检测双通道**：工具指纹循环 + 重复 assistant 文本，覆盖「不调工具空转」场景。

---

## 5. 差距根因归类

| 根因 | 表现 | 优化落点 |
|------|------|----------|
| A. 异步半成品 | async 无完成回灌 / 无耐久投递 | 优化方案 P0 |
| B. 配置未接线 | subagentMaxConcurrent、spawnDepth、delegation.maxDepth | P0 |
| C. 缺生命周期合约 | 无统一状态机；插件/UI 只能猜 | P1 |
| D. 并行写冲突未建模 | 多 async 写同一 workspace | P2 worktree |
| E. 无模型级顾问 | 单模型偏见无对照 | P2 可选顾问回合（非完整 MOA） |
| F. 文档硬约束缺失 | Prompt cache / 角色交替未写成闸门 | P0 文档 + 代码注释级约束 |

---

## 6. 明确不建议照搬的部分

| Hermes 能力 | 不照搬原因 |
|-------------|------------|
| MOA 作为默认虚拟 provider | 桌面默认成本 ×N；需用户显式开启；与现有 purpose/slot 模型冲突 |
| Capability HMAC 全量 | 当前 Electron 同进程、无插件监督边界；过早复杂度高 |
| Kanban 多 Agent 板 | 产品未定义跨 profile 认领场景 |
| 子 Agent 默认 max_iterations=250 | 与 Lumii 按角色收紧 maxTurns 的策略相反 |
| 异步委派「跨进程复活整棵树」 | Hermes 自己也划清边界；应用 cron，不要假耐久 |

---

## 7. 可复用设计模式（从 Hermes 抽取）

1. **Capability 句柄模式** → 插件化后再用；短期用「父 session + instanceId + parentOf 校验」即可。  
2. **进度优先超时** → 替换/补充「仅靠 maxTurns」对长工具调用的误杀。  
3. **写入严、读取宽** → Agent 定义 / 委派配置：API 写入校验，本地缓存 normalize 降级。  
4. **结果完整性哈希** → async 完成投递载荷加 `resultHash`，便于 UI/调试验真。  
5. **新回合投递异步结果** → 与 pi-agent-core followUp / 新 user turn 对齐，保护角色交替与缓存。  
6. **顾问 vs 执行分离** → 若做顾问扇出：顾问禁止工具；仅主 Agent 执刀。

---

## 8. 代码索引（Lumii）

| 主题 | 位置 |
|------|------|
| spawn / 深度 | `packages/agent-runtime/src/agent/orchestrator.ts` |
| 子工具禁止列表 | `apps/windows/src/main/agent-runtime/bridge-utils.ts` → `CHILD_AGENT_DISALLOWED_TOOLS` |
| 子实例创建 | `apps/windows/.../bridge-lifecycle.ts` → `createChildInstance` |
| 内置角色 | `packages/agent-runtime/src/agent/builtin/definitions.ts` |
| 定义类型 | `packages/agent-runtime/src/types/agent-definition.ts` |
| MessageBus | `packages/agent-runtime/src/messaging/message-bus.ts` |
| 验证门 | `packages/agent-runtime/src/agent/hooks/verification-gate-hook.ts` |
| stuck | `packages/agent-runtime/src/agent/stuck-detection.ts`、`reliability/stuck-guard.ts` |

Hermes 侧索引见对照文档附录 A（`moa_loop.py`、`delegate_tool.py`、`async_delegation.py`、`subagent_lifecycle.py`、`subagent_worktree.py`）。
