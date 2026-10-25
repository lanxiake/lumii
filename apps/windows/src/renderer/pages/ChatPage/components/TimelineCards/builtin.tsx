/**
 * 内置时间线卡片注册。
 *
 * 原先三条（转交 / 委托 / 任务完成）+ 询问 / 审批。
 * `pinned: true`：被折叠进「执行过程」就等于用户看不见。
 */

import { AskUserCard } from '../AskUserCard/AskUserCard'
import { HandoffCard } from '../HandoffCard'
import { matchesPendingPermission, PermissionCard } from '../PermissionCard/PermissionCard'
import { SpawnAgentCard, parseSpawnResult } from '../SpawnAgentCard'
import { TaskCompleteCard } from '../TaskCompleteCard'
import { ensureTimelineCard, type TimelineCardDefinition, type ToolPart } from './registry'

const isAskUser = (part: ToolPart) => part.name === 'ask_user_question'
const isHandoff = (part: ToolPart) => part.name === 'propose_dev_handoff'
const isSpawn = (part: ToolPart) => part.name === 'spawn_agent'
const isTaskComplete = (part: ToolPart) => part.name === 'task_complete'

/** spawn 卡片结果里的子实例 id；同步执行中结果未返回时读不到 */
function spawnInstanceId(part: ToolPart): string | undefined {
  const id = parseSpawnResult(part.result)?.instanceId
  return typeof id === 'string' && id ? id : undefined
}

/** 询问卡优先于其它内置卡；始终按工具名命中 */
const ASK_USER: TimelineCardDefinition = {
  id: 'builtin.ask-user',
  order: 5,
  pinned: true,
  match: isAskUser,
  component: AskUserCard,
  owner: 'builtin',
}

/**
 * 审批卡：仅当挂起 requestId === part.id 时命中。
 * ChatMessage 须订阅 pending 变化以触发重新匹配。
 */
const PERMISSION: TimelineCardDefinition = {
  id: 'builtin.permission',
  order: 6,
  pinned: true,
  match: matchesPendingPermission,
  component: PermissionCard,
  owner: 'builtin',
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
  ensureTimelineCard(ASK_USER)
  ensureTimelineCard(PERMISSION)
  ensureTimelineCard(HANDOFF)
  ensureTimelineCard(SPAWN)
  ensureTimelineCard(TASK_COMPLETE)
}
