/**
 * 异步子 Agent 完成投递：按父实例状态选择 followUp / internal prompt / 延后
 *
 * 关键约束（pi-agent-core）：followUp 仅在已有 prompt 循环内消费；
 * 父已 idle 时必须 prompt(origin=internal)，否则消息永不出队。
 */

import type { AgentInstance } from '@mtbot/agent-runtime'
import type { SubagentCompletionPayload } from '@mtbot/agent-runtime'
import { agentRuntimeLog as log } from './bridge-utils'

/** 投递结果：已 followUp / 已开新回合 / 暂不可投需延后 */
export type SubagentDeliveryMode = 'followUp' | 'prompt' | 'deferred'

/**
 * 将子 Agent 完成载荷投递给父实例。
 * running → followUp；idle → prompt(origin=internal)；其他 → 延后队列。
 */
export async function deliverSubagentCompletion(opts: {
  parent: AgentInstance
  payload: SubagentCompletionPayload
  format: (p: SubagentCompletionPayload) => string
}): Promise<SubagentDeliveryMode> {
  const msg = opts.format(opts.payload)
  const state = opts.parent.state
  const { childId, parentId, name, status } = opts.payload

  if (state === 'running') {
    opts.parent.followUp(msg)
    log.info(
      `[subagent-delivery] followUp parent=${parentId} child=${childId} name=${name} status=${status} parentState=running`,
    )
    return 'followUp'
  }

  if (state === 'idle') {
    log.info(
      `[subagent-delivery] prompt(internal) parent=${parentId} child=${childId} name=${name} status=${status} parentState=idle`,
    )
    await opts.parent.prompt(msg, undefined, 'internal')
    return 'prompt'
  }

  log.info(
    `[subagent-delivery] deferred parent=${parentId} child=${childId} name=${name} status=${status} parentState=${state}`,
  )
  return 'deferred'
}
