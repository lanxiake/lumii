/**
 * 「自上次查看以来新增了多少成品」——纯函数，供工具栏角标与 rail 分隔行共用。
 *
 * 口径：
 * - 只数**成品**（`classifyArtifact === 'deliverable'`）：过程文件不是用户要「看」的东西；
 * - 同一路径多轮改写只算一条（用户关心的是「多了几份东西」，不是写了几次）；
 * - `deleted` 与 `unattributed` 不算；
 * - 时间严格大于 `since`（等于边界的那条可能正是上次看到的那条）。
 */

import { classifyArtifact } from './artifact-rules'

export interface CountableFileChange {
  readonly path: string
  readonly status: string
  readonly confidence?: string
}

export interface CountableMessage {
  readonly timestamp: number
  readonly fileChanges?: readonly CountableFileChange[]
}

export function countDeliverablesSince(
  messages: readonly CountableMessage[],
  since: number,
): number {
  const paths = new Set<string>()
  for (const message of messages) {
    if (!(message.timestamp > since)) continue
    for (const change of message.fileChanges ?? []) {
      if (!change || typeof change.path !== 'string' || change.path.length === 0) continue
      if (change.status === 'deleted') continue
      if (change.confidence === 'unattributed') continue
      if (classifyArtifact({ path: change.path }) !== 'deliverable') continue
      paths.add(change.path)
    }
  }
  return paths.size
}
