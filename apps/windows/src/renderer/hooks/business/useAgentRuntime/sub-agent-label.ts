/**
 * 子 Agent 显示名回填判定（活动快照 → 消息 sourceAgent.label）
 *
 * 背景（2026-09-14，见 docs/plans/专项Agent/08-委托可见性.md §3）：
 * `agent:activity:snapshot` 到达时会用快照里的名字回填消息的 `sourceAgent.label`，
 * 初衷是修「`agent:message:start` 先于 snapshot 到达」的竞态。但原实现是无条件覆盖：
 * 快照名由 `findBuiltInAgent(definitionId)?.name ?? definitionId` 得出，只认内置定义——
 * 用户自建 Agent 会退化成 `user-<ts>-<rand>` 这样的编码 id，**反过来把已经落库的正确名字盖掉**。
 *
 * 这里把判定收敛成两个纯函数：只回填「占位值」，绝不覆盖真实名。
 */

import { resolveBuiltinDisplayName } from '@mtbot/agent-runtime/browser'

/**
 * 判断一个 label 是否为「占位值」而非真实显示名。
 *
 * 命中任一即视为占位：
 * - 空 / 纯空白
 * - 等于实例 id（`agent:message:start` 竞态下可能先写入的兜底值）
 * - 运行时生成的 id 形状：`agent-<ts>-<rand>` / `user-<ts>-<rand>`
 * - 内置定义 id 被当成了名字（`default` / `assistant` / `builtin:explore` …）
 */
export function isPlaceholderAgentLabel(label: string, instanceId: string): boolean {
  const value = label.trim()
  if (!value) return true
  if (value === instanceId) return true
  if (/^(agent|user)-\d+-[a-z0-9]+$/i.test(value)) return true
  if (resolveBuiltinDisplayName(value) !== undefined) return true
  return false
}

/**
 * 计算快照回填后的 label；无需变更时返回 `null`。
 *
 * 规则：
 * - 快照名缺失 / 与当前值相同 → 不变更
 * - 当前 label 已是真实名 → 不变更（**绝不覆盖**，这是本模块存在的理由）
 * - 快照名自身是占位值 → 不变更（避免用编码串覆盖占位串，白折腾）
 */
export function resolveBackfilledAgentLabel(
  currentLabel: string,
  instanceId: string,
  snapshotName: string | undefined,
): string | null {
  const preferred = snapshotName?.trim()
  if (!preferred) return null
  if (preferred === currentLabel) return null
  if (!isPlaceholderAgentLabel(currentLabel, instanceId)) return null
  if (isPlaceholderAgentLabel(preferred, instanceId)) return null
  return preferred
}
