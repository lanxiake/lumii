import type { AppUiClickContext, AppUiRef } from './types'

/** click 时禁止点击的角色（composer / runtime 容器及其子节点） */
export const CLICK_BLOCK_ROLES = ['composer', 'runtime'] as const

/** key 白名单：仅允许导航/编辑类按键，禁止任意 keyCode 打拼音 */
export const KEY_WHITELIST = [
  'Enter',
  'Escape',
  'Tab',
  'Backspace',
  'Delete',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
] as const

export type AllowedKey = (typeof KEY_WHITELIST)[number]

export type ClickAllowedError = 'missing_ref' | 'stale_snapshot' | 'blocked_composer'

/** click 准备阶段目标丢失 */
export type ClickPrepareError = 'click_target_lost'

/** act 通用错误（含 usage，供 key 白名单拒绝等） */
export type ActUsageError = 'usage'

export type AppUiClickError = ClickAllowedError | ClickPrepareError | 'app_not_running'

export type AppUiActError = AppUiClickError | ActUsageError

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

/**
 * 判断按键是否在白名单内。
 */
export function isKeyAllowed(key: string): boolean {
  return (KEY_WHITELIST as readonly string[]).includes(key)
}

/** 点击准备脚本返回的重新测量矩形 */
export interface ClickPrepareRect {
  x: number
  y: number
  w: number
  h: number
}

/**
 * 生成 elementFromPoint 定位 HTMLElement 的公共脚本前缀。
 */
function buildElementLocatePrefix(x: number, y: number, w: number, h: number): string {
  return `  var cx = ${x} + ${w} / 2;
  var cy = ${y} + ${h} / 2;
  var el = document.elementFromPoint(cx, cy);
  if (!el) return null;
  while (el && !(el instanceof HTMLElement)) {
    el = el.parentElement;
  }
  if (!el) return null;`
}

/**
 * 生成 scrollIntoView + 重测 rect 的注入脚本。
 * 以快照坐标中心点定位元素，滚动到视口后再返回新包围盒。
 */
export function buildClickPrepareScript(x: number, y: number, w: number, h: number): string {
  return `(function () {
${buildElementLocatePrefix(x, y, w, h)}
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

/**
 * 生成 type 注入脚本：scrollIntoView 后用 native value setter 写入文本。
 * 支持 input/textarea；clear=true 时先设空字符串再设新值。
 */
export function buildTypeScript(
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  clear = false,
): string {
  const textJson = JSON.stringify(text)
  return `(function () {
${buildElementLocatePrefix(x, y, w, h)}
  el.scrollIntoView({ block: 'center', inline: 'center' });
  function setNativeValue(target, value) {
    var proto = target instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(target, value);
    }
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
  var text = ${textJson};
  if (${clear ? 'true' : 'false'}) {
    setNativeValue(el, '');
  }
  setNativeValue(el, text);
  return true;
})()`
}

/** scroll 注入脚本的回读结果 */
export interface ScrollScriptResult {
  /** 容器位置是否真的变了；false 表示已到边界或没有可滚动容器 */
  moved: boolean
  /** 实际滚动的容器描述，如 div.settings-body；退化到页面滚动时为 document */
  container: string
  scrollTop: number
  scrollHeight: number
  clientHeight: number
  atTop: boolean
  atBottom: boolean
}

/**
 * 生成 scroll 注入脚本：从 ref 元素向上找最近的可滚动祖先并滚动它。
 *
 * ref 命中的往往是按钮、文本这类本身不可滚动的元素，直接对它 scrollBy 不会有任何效果，
 * 因此这里沿 parentElement 上溯，找到 overflow 为 auto/scroll/overlay 且内容确实溢出的容器；
 * 都找不到时退化为滚动页面根元素。返回滚动后的位置信息，供上层判断是否已经到底。
 */
export function buildScrollScript(
  x: number,
  y: number,
  w: number,
  h: number,
  dx: number,
  dy: number,
): string {
  return `(function () {
${buildElementLocatePrefix(x, y, w, h)}
  var dx = ${dx};
  var dy = ${dy};
  var SCROLLABLE = /(auto|scroll|overlay)/;
  function describe(node) {
    var tag = node.tagName ? node.tagName.toLowerCase() : 'unknown';
    var className = typeof node.className === 'string' ? node.className.trim() : '';
    if (className === '') return tag;
    return tag + '.' + className.split(/\\s+/).slice(0, 2).join('.');
  }
  function scrollable(node) {
    var style = window.getComputedStyle(node);
    if (dy !== 0 && node.scrollHeight - node.clientHeight > 1 && SCROLLABLE.test(style.overflowY)) {
      return true;
    }
    if (dx !== 0 && node.scrollWidth - node.clientWidth > 1 && SCROLLABLE.test(style.overflowX)) {
      return true;
    }
    return false;
  }
  var found = el;
  while (found && !scrollable(found)) {
    found = found.parentElement;
  }
  var container = found || document.scrollingElement || document.documentElement;
  if (!container) return null;
  var beforeTop = container.scrollTop;
  var beforeLeft = container.scrollLeft;
  container.scrollTop = beforeTop + dy;
  container.scrollLeft = beforeLeft + dx;
  var scrollTop = container.scrollTop;
  var clientHeight = container.clientHeight;
  var scrollHeight = container.scrollHeight;
  return {
    moved: scrollTop !== beforeTop || container.scrollLeft !== beforeLeft,
    container: found ? describe(found) : 'document',
    scrollTop: Math.round(scrollTop),
    scrollHeight: Math.round(scrollHeight),
    clientHeight: Math.round(clientHeight),
    atTop: scrollTop <= 0,
    atBottom: scrollTop + clientHeight >= scrollHeight - 1
  };
})()`
}
