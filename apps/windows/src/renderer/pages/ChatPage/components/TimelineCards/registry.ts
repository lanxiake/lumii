/**
 * 时间线卡片注册表
 *
 * 解决的问题只有一个：往对话时间线里加一种「按工具名单独成卡」的卡片，
 * 此前要同时改 `buildRenderUnits` 的 if 链、`RenderUnit` 联合、`renderUnit` 的 switch、
 * `isPinned` 的硬编码 kind —— 四处，漏一处就是「卡片被折叠进执行过程」或类型报错。
 *
 * 刻意不做的事：
 * - 不做统一 `CardRenderer` 重渲染每条消息：消息行已是 `React.memo`、列表已窗口化，
 *   中间再插一层只会多一次重渲染（详见 docs/plans/PHASE-3-CARD-REGISTRY.md §五）。
 * - 不做懒加载卡片组件：内置三张卡本来就随 bundle 进来，懒加载只是多一层 Suspense。
 */

import type React from 'react'
import type { AssistantPart } from '@mtbot/agent-runtime/browser'
import type { SubAgentRun } from '../ChatContainer/sub-agent-runs'

export type ToolPart = Extract<AssistantPart, { type: 'tool' }>

/** 卡片组件收到的全部上下文 */
export interface TimelineCardContext {
  part: ToolPart
  /** 本条消息是否仍在流式（判「执行中」的必要条件，见 08-委托可见性.md §5） */
  messageStreaming: boolean
  /** 本条时间线可认领的子运行（只有委托类卡片用得上） */
  runs: readonly SubAgentRun[]
  /** 渲染某个子运行的轨迹正文（复用父回合的时间线渲染器） */
  renderRunBody?: (run: SubAgentRun) => React.ReactNode
}

export interface TimelineCardDefinition {
  /** 唯一标识，如 `builtin.spawn` */
  id: string
  /**
   * 匹配优先级：小的先。内置 10–30，插件默认 100，
   * 于是插件只能补空缺，**顶不掉**内置卡片。
   */
  order?: number
  match: (part: ToolPart) => boolean
  component: React.ComponentType<TimelineCardContext>
  /**
   * 露在「执行过程」折叠区之外。
   * true 用于「用户必须直接看到」的卡（转交 / 委托 / 任务完成）——
   * 被折叠进「调用 1 次工具」等于隐形。
   */
  pinned?: boolean
  /** 该卡片对应的子实例 id（子运行归属、看板「详情」定位都要它） */
  instanceId?: (part: ToolPart) => string | undefined
  /** 提供者（内置 `builtin`，插件写插件 id），用于诊断 */
  owner?: string
}

export class TimelineCardRegistryError extends Error {
  name = 'TimelineCardRegistryError'
}

interface StoredCard extends TimelineCardDefinition {
  seq: number
  order: number
}

interface RegistryState {
  cards: Map<string, StoredCard>
  seq: number
}

/**
 * 注册表挂到 globalThis 而不是模块作用域。
 *
 * Vite HMR 会**重新执行本模块**，模块级的 `new Map()` 于是变成一张新表；
 * 而外部插件（`~/.lumii/plugins/<dir>/client.js`）只在文件 revision 变化时才重新激活，
 * 它们的注册项留在**旧表**里——本模块一热更新，所有插件卡片就静默消失，
 * 只有重开窗口或改一下插件文件才会回来。
 *
 * 这与 `client-plugin-host.ts` 的 `SHARED_KEY` 是同一个取舍（那里踩过一次整机重启）。
 * 内置三卡靠 `ensureTimelineCard` 幂等，新旧实例读写同一张表不会重复登记。
 */
const SHARED_KEY = Symbol.for('lumii.timeline-cards.shared')
const state: RegistryState = ((globalThis as Record<symbol, unknown>)[SHARED_KEY] ??= {
  cards: new Map<string, StoredCard>(),
  seq: 0,
}) as RegistryState

const cards = state.cards

/** 注册一张卡片，返回注销函数。同 id 重复注册抛错（静默覆盖会让「谁生效」取决于加载顺序）。 */
export function registerTimelineCard(def: TimelineCardDefinition): () => void {
  if (cards.has(def.id)) {
    throw new TimelineCardRegistryError(`时间线卡片 "${def.id}" 已被注册`)
  }
  const stored: StoredCard = { ...def, seq: state.seq++, order: def.order ?? 100 }
  cards.set(def.id, stored)

  return () => {
    if (cards.get(def.id) === stored) cards.delete(def.id)
  }
}

/** 幂等注册：已存在同 id 就跳过（HMR 重跑模块时不能抛，也不能重复登记） */
export function ensureTimelineCard(def: TimelineCardDefinition): void {
  if (cards.has(def.id)) return
  registerTimelineCard(def)
}

/** 找到第一个命中的卡片；没有则返回 null（调用方回落到工具批次组） */
export function findTimelineCard(part: ToolPart): TimelineCardDefinition | null {
  let best: StoredCard | null = null
  for (const card of cards.values()) {
    if (!card.match(part)) continue
    if (best && (card.order > best.order || (card.order === best.order && card.seq > best.seq))) continue
    best = card
  }
  return best
}

/** 已注册卡片（诊断/开发者面板用） */
export function listTimelineCards(): TimelineCardDefinition[] {
  return [...cards.values()].sort((a, b) => a.order - b.order || a.seq - b.seq)
}

/** 仅测试用：清空注册表 */
export function __resetTimelineCardsForTest(): void {
  cards.clear()
  state.seq = 0
}
