# 短上下文模型的会话级上下文预算方案

日期：2026-08-23
问题来源：`docs/temp/运行日志.log`（MiniMax-M2.7，200K 窗口，400 context exceeded 终止会话）

## 1. 病因

日志第 34 行的实测分布：

```
used=195915/200000 (98.0%)
systemPrompt:2229  tools:10310  skills:1083
mcp:150708  subagents:475  dynamicContext:1939  conversation:9578
```

**固定开销 = 2229+10310+1083+150708+475+1939 = 166744 (83.4%)，其中 MCP 工具定义独占 150708 (75.4%)。**
对话历史只有 9578 (4.8%)。

由此推出三个结论：

**缺陷 1：压缩机制在此场景下结构性失效。** `bridge-context-compactor.ts:425-439` 的 `applyConversationCompactToUsage()` 只扣 conversation 差值，其余分类保持压缩前值——这本身是正确的口径。但当 conversation 仅占 4.8% 时，压缩上限就是 9.5K，而缺口是 164.8K 的固定开销。日志第 54 行压缩成功移出 3 条，第 65 行 `used=195915` 一字未变，即为此因。

**缺陷 2：触发阈值口径错误。** 两处触发点都拿对话历史的量去比整窗阈值：

- `bridge-prompt-dispatcher.ts:320`（实施前）：`estimatedTokens` 只含对话历史，阈值却是 `contextWindow × 0.78 = 156000`。对话要涨到 156K 才触发自动压缩，而本例对话池的实际上限只有 25064（=200000-166744-8192）—— **阈值高了 6 倍，形同虚设**，爆窗前压缩根本没启动过。这是比原判断严重得多的真 bug。
- `scanIdleInstances`：`floor=156000` 同样按整窗算，压缩后 `used` 仍高于 floor，反复评估无收敛目标。

> **实施时修正**：原文断言"固定开销 164805 高于 floor 156000，压缩目标永远不可达"有误。正确的固定开销是 166744，加 8192 补全预留 = 174936，**小于** 200000，对话池仍有 25064 空间，压缩是有效的。日志 54 行 `used` 不降是因为只移出 3 条、幅度太小（对话总量本就只有 9578）；39/42/44/46 行的"决策=跳过"是 idle 300s 未到与冷却，不是目标不可达。

**缺陷 3：400 后无法恢复。** 日志 22→26 行：`LLM ERROR ... retryable=false` 直接走到 `agent:end`。

> **实施时修正**：原判断"无自愈路径"有误。自愈机制已完整存在且已装配 —— `classifyLlmError`（`packages/agent-runtime/src/reliability/message-repair.ts:124-130`）的关键字表含 `maximum context length`（实测日志里的真实报文能正确归类为 `prompt_too_long`）；`SelfHealController` 有 `healPromptTooLong` 分支，`maxRetries: 2`；`agent-instance.ts:424` 在 `agent_end` 时已调 `attemptSelfHeal()`；错误消息确实进 `state.messages`（pi-agent-core 的 `message_end` → `appendMessage`），触发条件可满足。
>
> 真实原因是**自愈跑了但两次都失败**：`healPromptTooLong` 只丢弃前 1/3 对话消息，而本例对话历史仅 9578，丢 1/3 约省 3K，固定开销 166744 完全没动，重试的输入仍在 196K 量级，再次越界。两次耗尽后 `onError` 只抛 `Self-heal retry failed`，用户无从判断该做什么。

### 缺陷 4：压缩按钮永久转 —— 独立 bug，已定位

`event-handler.ts:1410-1412`：

```ts
case 'agent:context:usage': {
  const ratio = event.contextWindow > 0 ? event.usedTokens / event.contextWindow : 0
  const isAutoCompacting = ratio >= event.triggerThreshold   // ← 从占用率推导
```

`isAutoCompacting` 被当成"占用率是否超阈值"的派生值，而非真实压缩状态。占用停在 97% 时，每个 `agent:context:usage` 事件都会把它重新置 true，`ChatPage.tsx:878` 的 `finally` 复位随即被覆盖——这才是 spinner 永久转的原因，与"压缩无效"是两个独立缺陷。

**修法**：该分支只更新 `contextUsage`，不再推导压缩状态。`isAutoCompacting` 改由真实压缩生命周期驱动：手动触发置 true、`agent:context:compacted` 置 false、自动压缩开始时由主进程补一个 `agent:context:compacting` 事件置 true。"占用率高"的语义已有 `isNearThreshold`（1420 行）承载，UI 的 danger 配色用它，不要复用压缩状态。

## 2. 会话级化：现状与差距

用户要求：会话压缩、模型选择、MCP 工具、Skill 技能开关全部会话级，设置页作为全局总开关。

| 配置项 | 现状 | 位置 | 差距 |
|---|---|---|---|
| 模型选择 | 会话级，**仅进程内存** | `bridge-session-model-catalog.ts:241` `sessionPreferredModelRaw: Map` | 重启丢失，需持久化 |
| 思考模式 | 会话级，仅进程内存 | `BridgeSessionThinkingPrefs` | 同上 |
| Skill 开关 | **全局**（对话框里能点，但改全局） | `ComposerPlusMenu.tsx:189` → `skills.setEnabled` | 需加会话层 |
| MCP server | **全局** | `mcp-servers.json` 的 `enabled` 字段；`tools-and-mcp-commands.ts:77` | 需加会话层 |
| 工具禁用集 | **全局**，已持久化 | `tool-registry.ts:49` `userDisabled`；`bridge.ts:425-432` | 需加会话维度 |
| 压缩参数 | 全局常量 | `DEFAULT_COMPACTION_TRIGGER_RATIO` | 需会话级覆盖 |

四种配置各自为政，没有统一的会话设置载体。逐个加会话层会把合并逻辑写四遍——**这是要求 4/5 的前置条件，必须先建。**

## 3. 设计原则

- **先砍固定开销，再谈压缩。** 150K 的 MCP 定义是唯一值得动的目标，其余分类加起来不到 16K。
- **复用既有机制。** `getEnabledTools()` 的 `userDisabled` 过滤（tool-registry.ts:49，已持久化于 bridge.ts:425-432）、`mcp-servers.json` 的 `enabled` 字段、`COMPACTABLE_TOOLS` 白名单都已存在，扩展而非另建。
- **全局是默认值，会话是覆盖值。** 合并规则单点实现，避免每个调用方各写一遍。
- **不改压缩引擎的分类口径。** 现有 `patchBreakdownAfterConversationCompact` 的"只动 conversation"是对的，问题在触发条件而非压缩本身。

## 4. 实施步骤

### 步骤 0：会话设置载体（要求 4/5 的前置）

`conversations` 表加一个 JSON 列，一次性解决所有会话级配置的持久化：

```sql
ALTER TABLE conversations ADD COLUMN session_config TEXT DEFAULT NULL;
```

```ts
type SessionConfig = {
  preferredModel?: string
  disabledMcpServers?: string[]   // 会话级禁用，叠加在全局 enabled 之上
  disabledSkills?: string[]
  disabledTools?: string[]
  compaction?: { triggerRatio?: number; keepRecentTurns?: number }
}
```

**合并规则单点实现**（新增 `session-config.ts`）：全局启用且会话未禁用 = 生效。全局禁用则会话级不可开启，UI 上置灰并提示"已在设置中全局关闭"。

顺带把模型偏好和思考模式从进程内存迁到这里，修掉重启丢失。

### 步骤 1：压缩状态修复（缺陷 4）

- `event-handler.ts:1412` 删掉 `isAutoCompacting` 的占用率推导，`agent:context:usage` 分支只更新 `contextUsage`。
- UI 的 danger 配色改用 `isNearThreshold`。
- 主进程自动压缩开始时补一个 `agent:context:compacting` 事件置 true，与既有 `agent:context:compacted` 配对。

独立于其它步骤，改动最小，可先做。

### 步骤 2：触发阈值口径修正（缺陷 1+2）

```
fixedOverhead = systemPrompt + tools + mcp + skills + subagents
compressible  = used - fixedOverhead
budget        = contextWindow - fixedOverhead - reserveForCompletion(8192)
```

- 触发条件改为 `compressible > budget × triggerRatio`，而非 `used > contextWindow × 0.78`。
- `budget <= 0` 时**不再尝试压缩**，直接报错并给出可操作指引："工具定义占用 150K，超出模型窗口，请禁用部分 MCP server"，附跳转。比日志里那四次无效的"决策=跳过"有用得多。
- `triggerRatio` 优先读 `session_config.compaction.triggerRatio`，回落全局常量。

### 步骤 3：MCP server 的会话级开关 + token 可见（要求 5）

- 设置页 `McpServersPanel/index.tsx` 每个 server 补显示**估算 token 数**，复用 `context-usage-breakdown.ts:197` 的 `estimateTextTokenCount(toolText(tool))` 按 server 聚合。
- 对话框新增 MCP 选择框，与 `ComposerPlusMenu` 的技能选择框同构，写 `session_config.disabledMcpServers`。
- **注入侧两处必须同源**：`bridge-instance-factory.ts:329` 的 `allTools` 与 `:477` 的 `getMcpServerHints()`。不一致会导致 systemPrompt 里宣告的 MCP hints 与实际 tools 参数不符，模型会幻觉调用不存在的工具。
- `tool-registry.ts` 的 `getEnabledTools()` 加可选 scope 参数叠加会话禁用集；无参调用行为不变。

让用户看见"这个 server 值 40K token"是本步骤最大价值，比任何自动策略都有效。

### 步骤 4：Skill 开关会话级化（要求 4）

`ComposerPlusMenu.tsx:189` 的 `handleToggleSkill` 当前改全局状态，改为写 `session_config.disabledSkills`；设置页 `SkillsPage` 保持全局总开关。系统提示词侧在 `bridge-prompt-dispatcher.ts:269` 的 `resolveSkillActivations` 传入前过滤 `skillsSnapshot`。

### 步骤 5：UI 工具结果截断

`COMPACTABLE_TOOLS`（`packages/agent-runtime/src/compact/types.ts:44`）现有 8 项：file_read、bash、grep、glob、web_search、web_fetch、file_edit、file_write。**已确认不含 UI 自动化工具**，补入：

```ts
"app_screenshot", "app_act", "app_goto", "screen_record_mark",
```

日志第 12 行的 a11y refs 树单次可达数 K，几轮就吃掉剩余空间。这四个工具的结果幂等可重放（重新截图即可），符合白名单语义。

测试照 `transform-context.test.ts:194-198` 的既有断言格式加一条。

### 步骤 6：400 自愈失败时的可操作提示（缺陷 3）—— 未实施

原计划"识别错误 → 紧急压缩 → 重试 1 次"**取消**：这套机制已存在（见缺陷 3 的修正说明），叠一层重复重试只会让失败路径更难排查。

改为待做项：`healPromptTooLong` 两次耗尽后，把 `computeContextBudget` 的结果带进错误信息 ——「固定开销 166744/200000，压缩无法回收，请禁用部分 MCP server」。需要把预算数据穿到自愈层，是小改动但要加一层依赖注入。

本例的正解是步骤 3（用户手动关 server）或 Phase B（按需加载），不是重试。

### 步骤 7：模型感知的工具预算

- 模型 catalog（`bridge-session-model-catalog.ts:22-87` 的 `KNOWN_CONTEXT_WINDOWS` 旁）补 `toolBudgetTokens`，默认 `contextWindow × 0.15`。
- 超预算时按优先级裁剪：内置工具 > 会话显式启用的 server > 其余按调用频次（`hooks/tool-usage-hook.ts` 已在计数）。
- **裁剪必须在系统提示词里显式告知模型**，不静默裁剪，否则模型会幻觉调用不存在的工具。

## 5. Phase B：工具按需加载（后续）

目标把 mcp 从 150K 降到 10K 量级。保留全部内置工具 + 每个启用 server 的名称与一句话描述（不含 JSON Schema），新增 `tool_search` 工具按需拉取完整 schema，模型调用未加载工具时返回提示先搜索而非硬失败。这是 Claude Code 自身的做法。

**建议步骤 3 落地并观测一周后再启动**——届时 token 统计会告诉我们哪些 server 真正需要按需化，而不是现在拍脑袋全做。

## 6. 不做的事

- 不裁剪 systemPrompt/skills/subagents/memory。合计 5.7K（2.9%），动它们是拿架构复杂度换零头。
- 不做设计文档里的 per-model 阈值表。步骤 2 的公式天然适配不同窗口大小，查表是多余的一层。
- 不做记忆注入优化。1.9K，同上。

## 7. 实施状态

| 步 | 内容 | 状态 |
|---|---|---|
| 0 | 会话设置载体 + 合并规则 | ✅ V14 迁移 + `session-config.ts`，12 测试；顺带修模型偏好重启丢失 |
| 1 | 压缩状态修复 | ✅ 实际有**四处**占用率推导（非一处），全部移除 |
| 2 | 阈值口径修正 + 超限报错 | ✅ `context-budget.ts` + 8 测试；两处触发点接入 |
| 3 | MCP 会话级开关 + token 可见 | ✅ 注入侧同源过滤；三处显示 token；5 测试 |
| 4 | Skill 会话级化 | ✅ id 优先 name 兜底；6 测试；抽出共用读写方法 |
| 5 | UI 工具结果截断 | ✅ 白名单补 4 个 UI 工具 |
| 6 | 400 自愈 | ⛔ 取消，机制已存在（见缺陷 3 修正）；待做：失败提示带预算数据 |
| 7 | 模型感知预算 | ⏸ 未做，收益与步骤 3 重叠且自动裁剪有幻觉风险 |

合计 467 个测试通过，两包类型检查干净。

**未验证项**（单测覆盖不到，需实机确认）：
- `invalidateInstance` 后下一轮消息是否真按新工具/技能清单重建
- 设置页 token 数字是否对得上（日志 MCP 合计 150708）
- 关掉 server 后用量卡片是否真的降
- 关掉技能后系统提示词 skills 段是否变小
