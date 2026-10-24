# Phase 3 实施计划：时间线卡片注册表

> 来源研究：`docs/research/phase3-card-registry-plugin.md`
> 创建：2026-10-24 · 状态：**3A 已实施**（3B/3C 见 §五 明确不做）
> 上位文档：`docs/research/phase2-agent-parallel-dashboard.md`（Phase 2 已完成）

---

## 一、先校正研究文档的三个前提

研究文档写于实现之前，三处与现状不符，**按现状改方案，不按文档照搬**：

| 文档假设 | 现实 | 处理 |
|---|---|---|
| `MessageList.tsx` 1000+ 行，含全部卡片渲染 | 不存在此文件。列表是 `ChatContainer`（800 行，已窗口化 + 行级 `React.memo`） | 不新建 MessageList，不动列表管线 |
| 卡片类型 5 种，渲染逻辑耦合严重 | `ChatMessage` 1470 行里**只有约 40 行**是卡片分发；其余是 Markdown/语音/记忆提示 | 只抽这 40 行，不搬组件 |
| 需要一个 `CardRenderer` 统一重渲染每条消息 | 每条消息已经是 memo 的行，再加一层统一 renderer 只会多一层重渲染 | **不做** CardRenderer |

**真正的痛点**只有一条：新增一种「按工具名单独成卡」的卡片，要同时改
`buildRenderUnits`（if 链）、`RenderUnit` 联合类型、`renderUnit`（switch）、`isPinned`（硬编码 kind）
四处，漏一处就是「卡片被折叠进执行过程」或类型报错。

---

## 二、3A 设计

### 2.1 注册表

`apps/windows/src/renderer/pages/ChatPage/components/TimelineCards/registry.ts`

```ts
export interface TimelineCardContext {
  part: ToolAssistantPart          // 命中的工具 part
  messageStreaming: boolean        // 本条消息是否仍在流式
  runs: readonly SubAgentRun[]     // 本条时间线可认领的子运行（仅委托类卡片用）
  renderRunBody?: (run: SubAgentRun) => React.ReactNode
}

export interface TimelineCardDefinition {
  id: string
  order?: number                   // 小的先匹配，默认 100；内置用 10/20/30
  match: (part: ToolAssistantPart) => boolean
  component: React.ComponentType<TimelineCardContext>
  /** 露在「执行过程」折叠区之外（用户必须直接看到） */
  pinned?: boolean
  /** 该卡片对应哪个子实例（并行看板「详情」定位、子运行归属都要它） */
  instanceId?: (part: ToolAssistantPart) => string | undefined
  owner?: string
}
```

- `registerTimelineCard(def)` 返回注销函数；**同 id 重复注册抛错**（与 `slot-registry`、
  A2UI `card-registry` 同一约定——后者静默覆盖会让「谁生效」取决于加载顺序）。
- `findTimelineCard(part)`：按 `order` 升序、同序按注册顺序，返回**第一个命中的**。
- `listTimelineCards()` 供诊断；`__resetTimelineCardsForTest()` 仅测试用。

### 2.2 内置三张卡

`TimelineCards/builtin.ts` 把现有 hardcode 搬成三条注册，**组件本身一行不改**：

| id | 匹配 | 组件 | pinned |
|---|---|---|---|
| `builtin.handoff` | `name === 'propose_dev_handoff'` | `HandoffCard` | ✓ |
| `builtin.spawn` | `name === 'spawn_agent'` | `SpawnAgentCard` + `instanceId: parseSpawnResult` | ✓ |
| `builtin.task-complete` | `name === 'task_complete'` | `TaskCompleteCard` | ✓ |

**幂等注册**按注册表实际状态判重（`listTimelineCards()` 里有就跳过），不用模块级布尔——
Vite HMR 会重跑模块、布尔被重置而注册表还在，这是仓库里已经踩过三次的坑
（见 `dashboard-cards.tsx` 的同款注释）。

### 2.3 ChatMessage 改造

四处硬编码收敛成两处：

```ts
// 1) 建单元：if 链 → 查表
const card = findTimelineCard(part)
if (card) { flush(); units.push({ kind: 'card', part, card }); continue }

// 2) 渲染：switch → 统一交给 card.component
if (unit.kind === 'card') {
  const { component: Comp, instanceId } = unit.card
  const claimed = instanceId ? runs.filter(r => r.instanceId === instanceId(unit.part)) : []
  return <div className={styles['part-block']}><Comp part={unit.part} messageStreaming={isStreaming}
           runs={claimed} renderRunBody={...} /></div>
}
```

`isPinned` 从「kind 是不是 handoff/spawn/taskComplete」变成 `unit.card.pinned === true`。

### 2.4 开放给插件（唯一新增的对外 API）

`RendererPluginApi` / `ClientPluginApi` 各加一行 `registerTimelineCard`，宿主直接透传。
这样外部插件可以给**新的工具名**做卡片，而不必改核心代码——这就是研究文档里
「第三方卡片插件」的**全部可行部分**（沙箱见 §五）。

内置 `order` 10–30，插件默认 100，所以插件只能「补空缺」，不能顶掉内置三卡。

---

## 三、任务清单与工时

| # | 任务 | 文件 | 工时 |
|---|---|---|---|
| T1 | 注册表 + 单测 | `TimelineCards/registry.ts` / `.test.ts` | 0.5d |
| T2 | 内置三卡注册 + 幂等 | `TimelineCards/builtin.ts` | 0.3d |
| T3 | ChatMessage 接表（4 处 → 2 处） | `ChatMessage/index.tsx` | 0.5d |
| T4 | 插件 API 透传 | `plugins/api/renderer.ts`、`plugins/client-plugin-host.ts` | 0.2d |
| T5 | 回归：现有 620 行 ChatMessage parts 测试必须全绿 | `src/test/components/ChatMessage.parts.test.tsx` | 0.2d |
| T6 | 类型检查 + 相关全量测试 | — | 0.3d |

合计 **2 人天**（研究文档估的 15 天里，有 13 天花在不存在的 MessageList 重写和视觉令牌统一上）。

---

## 四、验证口径

1. `npx vitest run src/test/components/ChatMessage.parts.test.tsx` — 22 个既有用例全绿，
   覆盖 handoff 按钮可见、spawn 卡片在折叠区外、子运行归属、`interrupted` 态。
2. `npx vitest run src/renderer/pages/ChatPage/components/TimelineCards` — 新注册表用例。
3. `npx tsc --noEmit` — 干净。
4. 真实客户端冒烟（沿用 `docs/test/lumii-cli/chat/` 的脚本）：发一条会触发 `spawn_agent`
   的消息，确认委托卡片照常出现在折叠区外。

---

## 五、明确不做（附理由）

| 文档里的项 | 为什么不做 |
|---|---|
| `CardRenderer` 统一渲染组件 | 消息行已 memo + 列表已窗口化，再加一层统一 renderer 只会多一次重渲染 |
| 3B 沙箱隔离（Worker/iframe） | 插件要与宿主共享同一份 React 才能用 hooks，跨 realm 做不到；现有
`client-plugin-host` 也已是同上下文执行，并在 `PluginErrorBoundary` 按条目兜错。写一份做不到的沙箱设计不如直说 |
| 3B 脚手架 `lumii create-card-plugin` | 已有「新建示例插件」按钮（`plugins/external/template.ts`），引脚本体即可 |
| 3B 插件市场 / 审核 | 3C 且研究文档自己标的「可选」，没有后端、没有需求方 |
| 统一 `--card-*` 视觉令牌 | 卡片已统一用 `--mt-*` 令牌；再造一套是**第二个**令牌体系，不是统一 |
| 性能优化（React.memo 卡片） | 已由 `ChatMessageRowMemo` + `useWindowedRows` 覆盖（见 `docs/plans/代码重构/客户端切片/06-消息列表虚拟化.md`） |
| 100+ 消息性能测试 | 同上，实测已在切片 6 做过（10.5 小时内容涨 3 倍、RSS 涨 3%） |

---

## 六、风险

| 风险 | 缓解 |
|---|---|
| 迁移后卡片被误折叠进「执行过程」 | `pinned` 由注册项声明，不再靠 kind 硬编码；既有 22 条用例专测这个 |
| HMR 重复注册抛错 | 按注册表实际状态判重 |
| 插件顶掉内置卡片 | `order` 分层（内置 10–30 / 插件默认 100） |
| 子运行归属丢失 | `instanceId` 提取器随卡片定义走，spawn 卡片显式提供 |

---

## 七、实施记录（2026-10-24）

**已落地**（3A 全量，2 人天预估实际约 1.5 小时）：

| 文件 | 性质 |
|---|---|
| `TimelineCards/registry.ts` | 新增，注册表（~110 行） |
| `TimelineCards/builtin.tsx` | 新增，三张内置卡注册 + 幂等 |
| `TimelineCards/registry.test.ts` | 新增，7 例 |
| `TimelineCards/builtin.test.ts` | 新增，6 例 |
| `ChatMessage/index.tsx` | 改，**-54/+32**（4 处硬编码 → 2 处查表） |
| `plugins/api/renderer.ts` | 改，`registerTimelineCard` 进 `RendererPluginApi` |
| `renderer/plugins/client-plugin-host.ts` | 改，外部插件同能力 + owner 标记 |
| `docs/test/lumii-cli/chat/run-timeline-cards.mjs` | 新增，真实 renderer 验收 |

**验证结果**：

- `npx vitest run src/renderer/pages/ChatPage/components/TimelineCards` → 13 passed
- `npx vitest run src/test/components/ChatMessage.parts.test.tsx` → 25 passed（迁移前基线，含 handoff 按钮可见 / spawn 在折叠区外 / 子运行归属 / interrupted 态）
- `npx tsc --noEmit` → clean
- 真实客户端（`-RemoteDebug 9222`）：`run-timeline-cards.mjs` 输出
  `折叠区 2 个 · 委托卡片 2 个 · 落在折叠区内 0 个`，三张内置卡 `pinned=true` 按 order 10/20/30 注册。

**顺带发现（未在本片处理）**：`src/plugins/external/loader.test.ts` 有 5 例稳定失败，
`git diff HEAD -- apps/windows/src/plugins/external` 为空——与本次改动无关的历史失败。

