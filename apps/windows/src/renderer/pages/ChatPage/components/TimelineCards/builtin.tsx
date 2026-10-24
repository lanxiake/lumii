/**
 * 内置时间线卡片注册。
 *
 * 三条注册就是此前 `ChatMessage` 里那三处 `if (part.name === ...)` 的搬家，
 * 组件本身一行不改。`pinned: true` 对应原先的 `isPinned()` 硬编码——
 * 这几张卡被折叠进「执行过程」就等于用户看不见（转交确认按钮点不到、
 * task_complete 的 summary 被埋），所以必须露在外面。
 */

import { HandoffCard } from '../HandoffCard'
import { SpawnAgentCard, parseSpawnResult } from '../SpawnAgentCard'
import { TaskCompleteCard } from '../TaskCompleteCard'
import { ensureTimelineCard, type TimelineCardDefinition, type ToolPart } from './registry'

const isHandoff = (part: ToolPart) => part.name === 'propose_dev_handoff'
const isSpawn = (part: ToolPart) => part.name === 'spawn_agent'
const isTaskComplete = (part: ToolPart) => part.name === 'task_complete'

/** spawn 卡片结果里的子实例 id；同步执行中结果未返回时读不到 */
function spawnInstanceId(part: ToolPart): string | undefined {
  const id = parseSpawnResult(part.result)?.instanceId
  return typeof id === 'string' && id ? id : undefined
}

const HANDOFF: TimelineCardDefinition = {
  id: 'builtin.handoff',
  order: 10,
  pinned: true,
  match: isHandoff,
  component: ({ part }) => <HandoffCard part={part} />,
  owner: 'builtin',
}

const SPAWN: TimelineCardDefinition = {
  id: 'builtin.spawn',
  order: 20,
  pinned: true,
  match: isSpawn,
  instanceId: spawnInstanceId,
  component: ({ part, messageStreaming, runs, renderRunBody }) => (
    <SpawnAgentCard
      part={part}
      messageStreaming={messageStreaming}
      runs={runs.length > 0 ? runs : undefined}
      renderRunBody={renderRunBody}
    />
  ),
  owner: 'builtin',
}

const TASK_COMPLETE: TimelineCardDefinition = {
  id: 'builtin.task-complete',
  order: 30,
  pinned: true,
  match: isTaskComplete,
  component: ({ part }) => <TaskCompleteCard part={part} />,
  owner: 'builtin',
}

/** 幂等：HMR 重跑本模块时不能抛「已注册」 */
export function registerBuiltinTimelineCards(): void {
  ensureTimelineCard(HANDOFF)
  ensureTimelineCard(SPAWN)
  ensureTimelineCard(TASK_COMPLETE)
}
