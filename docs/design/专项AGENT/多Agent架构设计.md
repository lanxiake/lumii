# 多 Agent 架构设计

> 日期：2026-09-12
> 状态：v2（按反思压缩，聚焦「先可用」）
> 前置阅读：无。相关：[编码 Agent 接入设计](./2026-09-12-in-client-coding-agent-design.md)（代码 Agent 的 CLI 接入细节）
> 本文替代 2026-09-12 早些时候产出的 v1 五篇文档（已删除，反思结论保留在 §1.2）

---

## 0. 结论摘要

| 问题 | 结论 |
|------|------|
| 为什么要多 Agent | 有些职责的价值来自**持续存在**而非响应调用——典型是「定时任务、资讯收集」，有了**用户偏好记忆**，产出才符合预期（§1.1） |
| 一等公民的最小定义 | **一个开关 + 三件事**：Agent 有自己的记忆、自己的会话、能被调度。不做 L1/L2/L3 分级（§3.1） |
| 记忆 | 分两层：**用户偏好跨 Agent 共享**（已有，需验证）、**领域经验 per-agent 独立**（已有）。这是专项 Agent 的核心价值 |
| 自主会话 | **保留且强化**：用户要能看「哪个 Agent 什么时候运行、做了什么」，也要能**直接和它对话**（§3.3） |
| 调度 | `EVOLUTION_AGENT_ID` 参数化——数据层早已支持，只需贯通到编排层（§3.4） |
| 预算与配额 | **不做**。当前阶段不重要，等真有两个自主 Agent 抢预算时再说 |
| 信箱 | **不做新表**。`send_message` 补空闲兜底（约 3 行），复用现有唤醒路径（§5 不做清单） |
| 会话接续 | **理想状态，本次只设计不实现**：用户提到写代码 → 代码 Agent 接续默认会话；返回时反向接续（§4） |
| 预置 Agent | **2 个**：代码开发、系统维护。researcher / creator 不做（§6.3） |
| 实施 | **2 个阶段**，阶段 1 交付「多 Agent 架构可用」（§7） |

---

## 1. 为什么要多 Agent

### 1.1 实际要解决的问题

多 Agent 架构的价值**不在于「多」**，而在于三个具体的收益：

| 收益 | 说明 | 实例 |
|------|------|------|
| **持续上下文带来更好的产出** | 专属的经验积累 + 用户偏好，让同类任务越做越准 | 资讯收集 Agent 记住了「用户只关心某几个领域、讨厌标题党、偏好早上 8 点推送」→ 产出直接可用 |
| **职责隔离带来更清晰的行为** | 每个 Agent 的提示词和工具面收敛，行为可预期 | 代码 Agent 不会在改代码时突然去搜网页 |
| **自主时间带来主动价值** | 触发源是时间/事件，不是用户消息 | 系统维护 Agent 每周自动检查失效的定时任务 |

**第一条是核心。** 如果专项 Agent 读不到用户偏好、攒不下领域经验，它和主 Agent 加一个技能包没有区别——那就没有存在的必要。

### 1.2 反思：为什么 v1 设计被压缩

v1 设计的 5 篇文档提出了完整体系（L1/L2/L3 分级、per-agent 配额、`agent_messages` 表、五态消息、三重防环、审计视图、4 个预置 Agent）。反思后发现三类问题：

| 问题 | 具体表现 | v2 处理 |
|------|---------|--------|
| **为当前不存在的场景建基础设施** | 信箱新表解决的是「A 给空闲的 B 发消息」，但当前只有 assistant 能 spawn，子 Agent 既不能 spawn 也不能 send——**这个场景要等 L2 存在才出现** | 砍掉，只补 3 行兜底 |
| **发明了没有依据的规则** | 「Σ(L2 配额) ≤ 全局 50%」、`subagentMaxConcurrent: 3` 等数值 | 砍掉 |
| **违背既有模式** | 系统已有的 `builtin:explore`/`plan`/`verify` 都是**按需 spawn 的临时能力包**，v1 却引入了「常驻角色」模型 | 收敛到 2 个真正需要常驻的 Agent |

**v2 的原则**：先用起来，痛点驱动补能力。多 Agent 架构先「可用」，再谈完善。

---

## 2. 代码事实核查

### 2.1 已具备的基础（不需要新建）

| 能力 | 证据 | 说明 |
|------|------|------|
| **per-agent 记忆表** | `agent_memories.agent_id TEXT NOT NULL`，键 `(agent_id, user_id)`（`schema.ts:68-93`） | 领域经验的独立积累已就绪 |
| **用户偏好共享层** | `user_memory` Markdown（`memory/manager.ts:121-125`） | per-user 全局，**跨 Agent 共享** |
| **自主引擎已参数化** | `collectTickSignals(db, agentId, now)`（`tick-signals.ts:70`）；`collectMetricsFromSession` 用 `session.agentId`（`metrics-collector.ts:169`） | 引擎本身 agent-agnostic |
| **自主数据表已泛化** | `autonomous_*` 全表带 `agent_id`（满意度/目标/能力/反思/日记/人格） | 每个 Agent 可独立评分与进化 |
| **cron 支持指定 Agent** | `local_cron_jobs.agent_id`（`schema.ts:165`）；`runLocalCronJob` 按 `job.agent_id` 建实例（`cron-scheduler.ts:840`） | 调度层已支持 |
| **空闲唤醒路径** | `subagent-delivery.ts:36-42`：idle → `prompt(msg, undefined, 'internal')` | 可直接复用 |
| **Agent 切换器** | `ChatInput/ComposerPlusMenu.tsx:457-505`；`ChatPage.tsx:844` `handleNewConversation(agentId)` | 用户选 Agent 开对话的入口已有 |
| **团队生成/优化向导** | `GenerateTeamWizard`、`OptimizeTeamWizard` | 用户自建 Agent 的通道已有 |

### 2.2 缺口

| 缺口 | 位置 | 影响 |
|------|------|------|
| 🔴 **cron 产出归属错标** | `bridge.ts:1117` `saveMessage`、`:1132` `addMemory` 硬编码 `agentId:'assistant'` | 多 Agent 的产出会**污染 L1 的满意度评分与能力画像**。既定教训：满意度是 Prompt 进化和人格 EMA 的输入，错误输入比不接更糟 |
| 🔴 **调度硬编码单 Agent** | `evolution-tick.ts:25` `EVOLUTION_AGENT_ID = 'assistant'` | 自主能力只有 assistant 有 |
| 🔴 **自主会话单例** | `EVOLUTION_CONVERSATION_ID = 'evolution:main'`（`autonomous/config.ts:151`），`bridge.ts:1214-1219` 强制 `agentId:'assistant'` | 无法看「某个专项 Agent 做了什么」 |
| 🟠 **空闲 Agent 收不到消息** | `sendMessage`（`orchestrator.ts:575-638`）调 `followUp`；`followUp` 仅在 prompt 循环内被消费（`subagent-delivery.ts:5` 注释确认） | Agent 间主动通知会丢 |
| 🟠 **自主开关不存在** | — | 无法表达「这个 Agent 有自主能力」 |

### 2.3 一个需要实测确认的假设

**「专项 Agent 能读到用户偏好记忆」是本文档的核心价值主张，但未经实测验证。**

已知：`user_memory` Markdown 是 per-user 全局。未知：新建的 Agent（`memory.scope` 非 `none`）是否真的走同一条注入路径、能否读到已有的用户偏好。

**这是阶段 1 的第一个验证项**——若答案是否定的，多 Agent 的第一条收益就不成立，需要先修记忆注入再谈其他。

---

## 3. 核心设计

### 3.1 一等公民 = 一个开关 + 三件事

不做 L1/L2/L3 分级。一个 Agent 是否是「一等公民」，由**一个布尔开关**决定——它是否有自主能力。

开关打开后，Agent 获得三件事：

| 能力 | 含义 | 用户价值 |
|------|------|---------|
| **自己的记忆** | 领域经验独立积累；用户偏好共享 | 同类任务越做越准 |
| **自己的会话** | 自主行为有落地载体，可回看、可对话 | 能看它干了什么、能直接聊 |
| **自己的时间** | 可自建 cron、被 tick 遍历 | 主动发现、无人值守 |

**开关的存储**：优先放在 Agent 定义（api-server `system_agents`）；若服务端排期不允许，先用本机配置 `~/.lumii/config/app.json` 的 `autonomousAgents: string[]`。**不引入 `isL2` 之类的概念字段**——「是否有自主配置」本身就是开关。

**为什么要开关而不是默认全开**：自主能力有真实成本（LLM 调用、token）。用户批量生成 10 个 Agent 就自动获得 10 份自主权，会迅速摊薄资源且无法排查。**升级必须是显式的。**

### 3.2 记忆：两层结构

```
用户偏好层（user_memory Markdown）
  ├─ per-user 全局，跨 Agent 共享
  ├─ 内容：回复风格、关注领域、作息、禁忌
  └─ 价值：让所有 Agent 的产出都符合用户预期   ← §1.1 的第一条收益

领域经验层（agent_memories 表）
  ├─ per-agent 独立（键 = agent_id + user_id）
  ├─ 内容：这个领域的踩坑、方法、历史
  └─ 价值：让同类任务越做越准
```

**设计要点**：

1. **专项 Agent 必须能读用户偏好层**——这是核心价值主张（§2.3 待验证）
2. **`memory.scope` 收敛为 `none | user`**，保留 `conversation` 作为 `user` 的别名。理由：`agent_memories` 表**没有 `conversation_id` 列**，实现真正的会话级隔离要动 schema 和所有写入路径，而收益极低（会话临时上下文已由上下文窗口承载）
3. **不做记忆隔离的硬约束**——所有 Agent 都能读用户偏好是**期望行为**，不是漏洞

### 3.3 自主会话：可见性与对话入口

用户的两个诉求：**看它做了什么** + **直接和它对话**。

**设计**：每个开启自主的 Agent 拥有 `evolution:<agentId>` 会话（L1 保持 `evolution:main`，兼容存量数据）。

| 属性 | 设计 |
|------|------|
| 不可删除 | 沿用现有 `evolution:` 前缀守卫（`bridge.ts:257`） |
| 不进默认列表 | 避免污染用户的会话列表（4 个 Agent 就是 4 个噪音条目） |
| 进团队页 | 「AI 团队 → 某 Agent → 活动」入口 |
| **可对话** | 用户可在其中直接发消息，与该 Agent 交流它的自主行为 |
| 消息形态 | 沿用现有成对落库（user 自问 + assistant 自答），保持独白对话化 |

**为什么保留**（用户明确要求）：这是自主行为的**唯一可观测窗口**。没有它，Agent 自主跑了什么、花了多少、做对没有，用户一无所知——「有生命感」就退化成黑箱。

### 3.4 调度：贯通而非重建

数据层早已参数化，缺的是编排层。改动为**参数化 + 单 tick 遍历**：

```
现状：  tick → EVOLUTION_AGENT_ID ('assistant' 硬编码)
目标：  tick → for agentId in [assistant, ...autonomousAgents]:
                  signals = collectTickSignals(db, agentId, now)
                  action  = decideAction(signals, ...)
                  if action.kind !== 'idle': execute(action, agentId)
```

**选择单 tick 遍历而非 per-agent tick job**：`collectTickSignals` 是纯 DB 查询，遍历成本极低；N 个 job 会淹没调度器，且全局判断（如总预算）需要跨 job 协调。

**心跳仍是保活看门狗，不是主调度器**（既定原则）——Agent 的主动性主要来自它自己建的 cron，心跳只负责兜底。

**同时修 `bridge.ts:1117/1132` 的归属污染**——这是引入第二个 Agent 的前置条件。

### 3.5 会话接续（理想状态，本次只设计不实现）

用户描述的目标：

> 提到写代码 → 代码 Agent 接续默认 Agent 的会话，但**不是全部历史**，而是默认 Agent 把**背景信息**给到代码 Agent，代码 Agent 用这些信息和用户继续对话。返回时反向接续。用户不需要手动切换即可在多个 Agent 间来回对话。

**机制设计**：

```
用户在 L1 会话说「帮我改一下 X 的代码」
  │
  ├─ 触发：意图识别（或用户显式点击「交给代码 Agent」）
  │
  ├─ L1 生成背景包（LLM 总结，不是机械截取历史）
  │     { originUserRequest, 已确认的需求, 约束, 相关文件/产物, doneDefinition }
  │
  ├─ 切换到 code-dev 会话，背景包作为开场上下文注入
  │     └─ code-dev 用这些信息继续对话（用户看到的是连续的体验）
  │
  └─ 返回时反向：code-dev 生成结果摘要 → 交回 L1 会话
```

**关键设计点**：

1. **背景包由 LLM 生成**——这是「不是全部历史记录」的实现方式。机械截取会带上大量无关上下文，反而干扰
2. **与跨渠道接续同构**——系统已有 `/link` 跨渠道绑定（`weixin-session-binding.ts`）与「跨渠道接续」，机制可复用其思路
3. **本次只设计不实现**——用户明确说「现在可以不实现」。但**背景包的结构要从一开始就定义**（见下），因为它同时服务于 `spawn_agent` 的任务描述

**背景包结构**（可立即用于 `spawn_agent` 的 prompt 模板）：

```
{
  originUserRequest,   // 必填：用户原始请求，否则接收方不知道最终目的
  confirmedNeed,       // 已确认的需求细节
  constraints,         // 用户约束（时间、风格、范围）
  artifacts,           // 已有产物引用
  doneDefinition       // 必填：什么算完成——接收方自检的依据
}
```

`originUserRequest` 与 `doneDefinition` **必填**。缺这两项，接收方会做出「技术上完成但不符合用户本意」的东西——这是子 Agent prompt 必须自包含的既有教训。

---

## 4. 专项 Agent 的判据

一个能力值得独立成常驻 Agent，需同时满足四条：

| # | 判据 | 反例 |
|---|------|------|
| 1 | **独占的能力面** | 「数据分析」用的还是 bash + file，与代码 Agent 重合 |
| 2 | **独立的长期上下文** | 「翻译」每次都是独立的，无积累 |
| 3 | **清晰的触发边界** | 「通用助手」——什么都能干 = 什么都该找它 = 边界消失 |
| 4 | **可验证的产出** | 「提供建议」——无法验证 |

**第 3 条最容易被忽略、也最致命。** 边界模糊的专项 Agent 会变成「第二个主 Agent」，增加选择负担而不增加能力。

**补充判据（v2 新增）**：**是否需要「自己的时间」**。只在被调用时工作的职责，用 `spawn_agent` 的临时子 Agent 就够了——系统已有的 `builtin:explore`/`plan`/`verify` 正是这个模式。

---

## 5. 专项 Agent 设计

### 5.1 代码开发 Agent · `code-dev`

| 维度 | 设计 |
|------|------|
| **职责** | 在指定代码仓库中完成可验证的代码改动 |
| **触发边界** | 用户要求修改代码、修复 bug、实现功能、重构，且目标是本地代码仓库 |
| **工具面** | `bash`、文件读写编辑、`glob`/`grep`、`todo_write`、`spawn_agent`、**编程 CLI（见 coding 设计文档）** |
| **记忆** | 用户偏好（共享）+ 项目结构、构建命令、代码规范（独立） |
| **自主场景** | 依赖过期、TODO 积累、测试持续失败（**默认关闭，用户可开**） |
| **自主会话** | `evolution:code-dev` |
| **CLI 接入** | 见 [编码 Agent 接入设计](./2026-09-12-in-client-coding-agent-design.md) |
| **不设** | 不设技能硬约束、不设独立配额、不禁用 `web_*`（写代码经常要查文档） |

### 5.2 系统维护 Agent · `system-keeper`

用户提出：「可以有一个专门的系统维护 AGENT，它可以自主的去维护定时任务、wiki、客户端设置等。」

| 维度 | 设计 |
|------|------|
| **职责** | 维护系统自身的健康：定时任务、Wiki、设置 |
| **触发边界** | 「整理一下」「清理失效任务」「我的设置是不是有问题」；以及周期性的自主检查 |
| **工具面** | `cron_*`（全量）、`wiki_*`（全量）、`memory_*`（全量）、**设置读取**、`todo_write` |
| **不做** | `bash`、文件写入、`web_*`、渠道出站 |
| **记忆** | 用户偏好（共享）+ 系统状态历史、维护经验（独立） |
| **自主场景** | ✅ **这是最需要自主的 Agent**：周期检查失效/冲突的定时任务、Wiki 去重与结构化、设置一致性检查 |
| **自主会话** | `evolution:system-keeper` |

**关键约束：客户端设置只「建议」不「自主改」。**

推演：Agent 自主修改了用户的设置（比如关闭了某个通知），用户不知道为什么行为变了——这是不可接受的。**设置类操作必须走「发现 → 建议 → 用户确认」**，确认后才由用户操作或经权限闸门执行。

**与既有 memory-wiki 规划的关系**：`docs/design/2026-08-23-memory-wiki-knowledge-base-design.md` 已规划了矛盾检测、ERO 图谱、DKR 编译等**自动机制**。`system-keeper` **不重复实现这些**——它的职责是调用/触发这些机制，以及在机制覆盖不到的地方做人工式的整理。**落地顺序应在 memory-wiki 的 P2/P3 之后**。

### 5.3 不做的（v1 有、v2 砍掉）

| Agent | 砍掉理由 |
|-------|---------|
| `researcher` | 主 Agent 加 `web_search` 就能答常规问题；长链条调研用 `spawn_agent` 临时子 Agent 即可，不需要常驻角色 |
| `creator` | 与主 Agent 高度重叠，差异只在「多轮产出成品文件」，不需要独立身份。可降级为技能包 |
| `curator` | 与 memory-wiki 规划的自动机制重叠；其独特价值（周期整理）已由 `system-keeper` 覆盖 |

**新增通道**：若日后确实需要更多专项 Agent，用已有的团队生成向导创建，显式开启自主开关即可。**不预先占位。**

---

## 6. 实施路线

### 阶段 1：多 Agent 架构可用

**目标**：两个非默认 Agent（`code-dev`、`system-keeper`）能独立运转——有自己的记忆、会话、时间，用户能看到它们在做什么。

| # | 改动 | 位置 | 类型 |
|---|------|------|------|
| 1.1 | cron 产出归属修正 | `bridge.ts:1117` `saveMessage`、`:1132` `addMemory` | 🔴 债务修复 |
| 1.2 | `EVOLUTION_AGENT_ID` 参数化 + 单 tick 遍历 | `evolution-tick.ts:25` | 贯通 |
| 1.3 | `evolution:<agentId>` 会话 | `autonomous/config.ts:151`、`bridge.ts:1214-1219` | 贯通 |
| 1.4 | 自主开关（本机配置 `autonomousAgents`） | `config/types.ts` + 遍历处读取 | 新增 |
| 1.5 | **验证用户偏好记忆可读**（§2.3） | 实测 | 验证项 |
| 1.6 | `code-dev` 定义 + CLI 接入 | api-server + 客户端镜像 + coding 设计 | 新增 |
| 1.7 | `system-keeper` 定义 | api-server + 客户端镜像 | 新增 |
| 1.8 | `send_message` 空闲兜底 | `orchestrator.ts:575-638` | 🟠 约 3 行 |
| 1.9 | 团队页「活动」入口 | AgentsPage → DetailPanel | UI |

**验收**：

- [ ] 1.5 有明确答案（能读 / 不能读，不能读则先修）
- [ ] 两个 Agent 各有独立自主会话，用户可在其中对话
- [ ] cron 任务的产出 `agent_id` 与 job 的 `agent_id` 一致（查库验证）
- [ ] `code-dev` 能通过聊天改掉一行代码并经 `git diff` 验证
- [ ] `send_message` 给空闲 Agent 能送达
- [ ] **现有行为零回归**：`run-autonomous-life-e2e.mjs`（23 用例）+ `run-autonomous-full-e2e.mjs`（11 用例）全绿

### 阶段 2：会话接续（本次不实现）

依赖阶段 1 稳定运行 + 用户确认体验痛点。届时实现 §3.5 的接续机制。

**先决条件**：阶段 1 跑一段时间后，确认「用户确实需要频繁在 Agent 间切换」——如果实际使用中很少切换，接续机制就不必做。

### 明确不做（本设计范围内）

| 项 | 理由 |
|----|------|
| per-agent 预算与配额 | 当前不重要；等真有两个自主 Agent 抢预算时再设计 |
| `agent_messages` 新表 | 解决的是「L2 存在后」才出现的场景；先做 3 行兜底 |
| 三重防环 / 三重节流 | 当前没有多 Agent 循环的真实风险 |
| 技能可调用硬约束 | 是行为变更，可能限制 Agent 能力；现有提示词级白名单大概率够用 |
| 审计视图 / 活动流 | 现有 `DetailPanel` 的 lifecycle snapshot 够用 |
| L1/L2/L3 分级模型 | 过度概念化；一个布尔开关足够 |
| `isL2` 字段 | 同上，用「是否有自主配置」隐式表达 |

---

## 7. 风险

| 风险 | 等级 | 缓解 |
|------|------|------|
| **用户偏好记忆实际读不到**（§2.3 未验证） | **高** | 阶段 1 第一项验证；不成立则先修记忆注入 |
| cron 归属污染已存在 | 中 | 1.1 优先修；检查历史数据是否已污染 |
| 自主开关被滥用（每个新 Agent 都开） | 中 | 升级必须显式；开启时提示将占用的资源 |
| `system-keeper` 与 memory-wiki 规划重复 | 中 | 明确分工：它调用机制，不实现机制；落地排在其 P2/P3 之后 |
| 多 Agent 自主行为产生会话噪音 | 低 | 自主会话不进默认列表 |

---

## 8. 与其他设计的关系

| 设计 | 关系 |
|------|------|
| [编码 Agent 接入设计](./2026-09-12-in-client-coding-agent-design.md) | 本文 §5.1 的实现细节，**可并行推进**（其 P0 零代码验证不依赖本文任何阶段） |
| `docs/design/自主进化Agent/`（10 篇） | 本文是其**多 Agent 化延伸**；阶段 1 全部改动都保证其既有行为不变 |
| `docs/plans/2026-09-06-autonomous-proactive-planning-*` | 规划器参数化后，从「assistant 专属」变为「每个自主 Agent 可用」 |
| `2026-08-23-memory-wiki-knowledge-base-design.md` | `system-keeper` 复用其自动机制，不重复实现 |
| 跨渠道接续（`weixin-session-binding.ts`） | §3.5 会话接续的机制同构，可复用思路 |
