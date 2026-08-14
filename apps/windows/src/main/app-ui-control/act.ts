import type { AppUiClickContext, AppUiRef } from './types'

/** click 时禁止点击的角色（composer / runtime 容器及其子节点） */
export const CLICK_BLOCK_ROLES = ['composer', 'runtime'] as const

export type ClickAllowedError = 'missing_ref' | 'stale_snapshot' | 'blocked_composer'

/** click 准备阶段目标丢失 */
export type ClickPrepareError = 'click_target_lost'

export type AppUiClickError = ClickAllowedError | ClickPrepareError | 'app_not_running'

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

/** 点击准备脚本返回的重新测量矩形 */
export interface ClickPrepareRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 生成 scrollIntoView + 重测 rect 的注入脚本。
 * 以快照坐标中心点定位元素，滚动到视口后再返回新包围盒。
 */
export function buildClickPrepareScript(x: number, y: number, w: number, h: number): string {
  return `(function () {
  var cx = ${x} + ${w} / 2;
  var cy = ${y} + ${h} / 2;
  var el = document.elementFromPoint(cx, cy);
  if (!el) return null;
  while (el && !(el instanceof HTMLElement)) {
    el = el.parentElement;
  }
  if (!el) return null;
  el.scrollIntoView({ block: 'center', inline: 'center' });
  var rect = el.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.width),
    h: Math.round(rect.height)
  };
})()`
}
