import type { AppUiClickContext, AppUiRef } from './types'

export type ClickAllowedError = 'missing_ref' | 'stale_snapshot' | 'blocked_composer'

export type AssertClickAllowedParams = {
  ref: string | undefined
  snapshotId: string | undefined
  current: AppUiClickContext
  blockRoles: readonly string[]
}

export type AssertClickAllowedResult =
  | { ok: true; ref: AppUiRef }
  | { ok: false; error: ClickAllowedError }

/**
 * 校验 click 是否允许：缺 ref、快照过期、composer 禁点。
 */
export function assertClickAllowed(params: AssertClickAllowedParams): AssertClickAllowedResult {
  const { ref, snapshotId, current, blockRoles } = params

  if (!ref || ref.trim() === '') {
    return { ok: false, error: 'missing_ref' }
  }

  if (snapshotId !== undefined && snapshotId !== current.snapshotId) {
    return { ok: false, error: 'stale_snapshot' }
  }

  const matched = current.refs.find((r) => r.ref === ref)
  if (!matched) {
    return { ok: false, error: 'stale_snapshot' }
  }

  if (blockRoles.includes(matched.role)) {
    return { ok: false, error: 'blocked_composer' }
  }

  return { ok: true, ref: matched }
}
