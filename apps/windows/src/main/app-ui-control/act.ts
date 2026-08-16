import type { AppUiClickContext, AppUiRef } from './types'

/** click 时禁止点击的角色（composer / runtime 容器及其子节点） */
export const CLICK_BLOCK_ROLES = ['composer', 'runtime'] as const

/** 纯语义角色：标题/字段名，不可点击/输入，返回 not_interactive */
export const NON_INTERACTIVE_ROLES = ['heading', 'section_title', 'label'] as const

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
  'Home',
  'End',
  'PageUp',
  'PageDown',
  'Space',
] as const

export type AllowedKey = (typeof KEY_WHITELIST)[number]

export type ClickAllowedError =
  | 'missing_ref'
  | 'stale_snapshot'
  | 'blocked_composer'
  | 'not_interactive'

/**
 * click 准备阶段错误：
 * - click_target_lost：快照坐标处已经找不到元素（界面变了）
 * - click_blocked：元素还在，但中心点被弹层/遮罩挡住，硬点会误触遮罩
 * - use_select_action：目标是原生 select，点击只会弹出截图捕获不到的系统菜单
 */
export type ClickPrepareError = 'click_target_lost' | 'click_blocked' | 'use_select_action'

/** act 通用错误（含 usage，供 key 白名单拒绝等） */
export type ActUsageError = 'usage'

/** type/select 注入阶段错误 */
export type ActInjectError = 'not_editable' | 'not_select' | 'option_not_found' | 'inject_failed'

export type AppUiClickError = ClickAllowedError | ClickPrepareError | 'app_not_running'

export type AppUiActError = AppUiClickError | ActUsageError | ActInjectError

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

  if ((NON_INTERACTIVE_ROLES as readonly string[]).includes(matched.role)) {
    return { ok: false, error: 'not_interactive' }
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
  /** 中心点命中测试是否指向目标自身（false 表示被弹层遮住） */
  hit?: boolean
  /** 目标标签名，小写；用于识别原生 select 等特殊控件 */
  tag?: string
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
 * 以快照坐标中心点定位元素，滚动到视口后再返回新包围盒，
 * 并回读一次命中测试：中心点若落在别的浮层上就告诉上层别硬点。
 */
export function buildClickPrepareScript(x: number, y: number, w: number, h: number): string {
  return `(function () {
${buildElementLocatePrefix(x, y, w, h)}
  el.scrollIntoView({ block: 'center', inline: 'center' });
  var rect = el.getBoundingClientRect();
  var hitEl = document.elementFromPoint(
    rect.left + rect.width / 2,
    rect.top + rect.height / 2
  );
  var hit = !!hitEl && (hitEl === el || el.contains(hitEl) || hitEl.contains(el));
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    w: Math.round(rect.width),
    h: Math.round(rect.height),
    hit: hit,
    tag: el.tagName ? el.tagName.toLowerCase() : 'unknown'
  };
})()`
}

/** type 注入脚本回读结果 */
export interface TypeScriptResult {
  ok: boolean
  /** 失败原因：not_editable | inject_failed */
  error?: string
  /** 写入后的实际值；password 字段不回传明文 */
  value?: string
  /** 值是否被脱敏（password 字段为 true） */
  masked?: boolean
  /** 写入后的字符数，供脱敏字段校验 */
  length?: number
  /** 实际写入的元素标签名 */
  tag?: string
}

/**
 * 生成「从快照坐标找到真正可编辑元素」的脚本片段。
 *
 * 快照 ref 命中的常常是包裹层（Input 组件的 input-container、带 suffix 图标的容器），
 * 直接对它调用 HTMLInputElement 的 value setter 会抛 Illegal invocation，
 * 表现为 act_failed。这里先看自身，再向上 closest，最后往子树找，找不到就明确报错。
 */
function buildEditableResolverSnippet(): string {
  return `  var EDITABLE_SELECTOR = 'input, textarea, [contenteditable=""], [contenteditable="true"]';
  var NON_TEXT_INPUT = ['checkbox', 'radio', 'button', 'submit', 'reset', 'file', 'image', 'range'];
  function isEditable(node) {
    if (!node || !node.tagName) return false;
    var tag = node.tagName.toLowerCase();
    if (tag === 'textarea') return true;
    if (tag === 'input') {
      var type = (node.getAttribute('type') || 'text').toLowerCase();
      return NON_TEXT_INPUT.indexOf(type) === -1;
    }
    return node.isContentEditable === true;
  }
  function resolveEditable(node) {
    if (isEditable(node)) return node;
    var up = node.closest ? node.closest(EDITABLE_SELECTOR) : null;
    if (isEditable(up)) return up;
    var down = node.querySelector ? node.querySelector(EDITABLE_SELECTOR) : null;
    if (isEditable(down)) return down;
    return null;
  }`
}

/**
 * 生成 type 注入脚本：定位可编辑元素后用 native value setter 写入文本。
 *
 * 语义：默认整体替换原有内容；append=true 时追加到末尾。
 * 写入后派发 input + change，让 React 受控组件与 blur 保存逻辑都能收到。
 * 返回结构化结果（含写入后的实际值），让调用方无需再截图确认。
 */
export function buildTypeScript(
  x: number,
  y: number,
  w: number,
  h: number,
  text: string,
  append = false,
): string {
  const textJson = JSON.stringify(text)
  return `(function () {
  try {
${buildElementLocatePrefix(x, y, w, h)}
${buildEditableResolverSnippet()}
  var target = resolveEditable(el);
  if (!target) {
    return { ok: false, error: 'not_editable', tag: el.tagName ? el.tagName.toLowerCase() : 'unknown' };
  }
  target.scrollIntoView({ block: 'center', inline: 'center' });
  if (typeof target.focus === 'function') target.focus();
  function setNativeValue(node, value) {
    var proto = node instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
    var descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(node, value);
    } else {
      node.value = value;
    }
    node.dispatchEvent(new Event('input', { bubbles: true }));
    node.dispatchEvent(new Event('change', { bubbles: true }));
  }
  var text = ${textJson};
  var append = ${append ? 'true' : 'false'};
  var tag = target.tagName.toLowerCase();
  var isFormField = tag === 'input' || tag === 'textarea';
  if (isFormField) {
    var current = append ? String(target.value == null ? '' : target.value) : '';
    setNativeValue(target, current + text);
  } else {
    target.textContent = append ? String(target.textContent || '') + text : text;
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }
  var finalValue = isFormField
    ? String(target.value == null ? '' : target.value)
    : String(target.textContent || '');
  var masked = isFormField && (target.getAttribute('type') || '').toLowerCase() === 'password';
  return {
    ok: true,
    tag: tag,
    masked: masked,
    length: finalValue.length,
    value: masked ? '' : finalValue.slice(0, 300)
  };
  } catch (e) {
    return { ok: false, error: 'inject_failed', message: String((e && e.message) || e) };
  }
})()`
}

/** select 选项摘要，回传给模型用于确认可选值 */
export interface SelectOptionInfo {
  value: string
  label: string
  selected?: boolean
}

/** select 注入脚本回读结果 */
export interface SelectScriptResult {
  ok: boolean
  /** 失败原因：not_select | option_not_found | inject_failed */
  error?: string
  /** 选中项的 value */
  value?: string
  /** 选中项的可读文案 */
  label?: string
  /** 全部可选项，失败时也回传，便于模型改用正确的值重试 */
  options?: SelectOptionInfo[]
}

/**
 * 生成 select 注入脚本：直接设置原生下拉框的值。
 *
 * Electron 里点击 <select> 弹出的是系统级菜单，capturePage 截不到、a11y 树也看不到，
 * Agent 只能干等；因此下拉框不走点击，而是按 value 或可读文案直接选中并派发 change。
 * value 与 label 都没给时只回读当前选项列表，不做修改。
 */
export function buildSelectScript(
  x: number,
  y: number,
  w: number,
  h: number,
  value?: string,
  label?: string,
): string {
  const valueJson = JSON.stringify(value ?? null)
  const labelJson = JSON.stringify(label ?? null)
  return `(function () {
  try {
${buildElementLocatePrefix(x, y, w, h)}
  var select = el.tagName.toLowerCase() === 'select'
    ? el
    : (el.closest ? el.closest('select') : null) || (el.querySelector ? el.querySelector('select') : null);
  if (!select || select.tagName.toLowerCase() !== 'select') {
    return { ok: false, error: 'not_select', tag: el.tagName ? el.tagName.toLowerCase() : 'unknown' };
  }
  function describeOptions() {
    return Array.prototype.map.call(select.options, function (opt) {
      return {
        value: String(opt.value),
        label: String(opt.textContent || '').replace(/\\s+/g, ' ').trim(),
        selected: opt.selected === true
      };
    });
  }
  var wantValue = ${valueJson};
  var wantLabel = ${labelJson};
  if (wantValue == null && wantLabel == null) {
    return { ok: true, value: String(select.value), label: '', options: describeOptions() };
  }
  var options = describeOptions();
  var matched = -1;
  for (var i = 0; i < options.length; i++) {
    if (wantValue != null && options[i].value === wantValue) { matched = i; break; }
  }
  if (matched === -1 && wantLabel != null) {
    var lowerLabel = String(wantLabel).toLowerCase();
    for (var j = 0; j < options.length; j++) {
      if (options[j].label.toLowerCase() === lowerLabel) { matched = j; break; }
    }
    if (matched === -1) {
      for (var k = 0; k < options.length; k++) {
        if (options[k].label.toLowerCase().indexOf(lowerLabel) !== -1) { matched = k; break; }
      }
    }
  }
  if (matched === -1 && wantValue != null) {
    var lowerValue = String(wantValue).toLowerCase();
    for (var m = 0; m < options.length; m++) {
      if (options[m].label.toLowerCase() === lowerValue) { matched = m; break; }
    }
  }
  if (matched === -1) {
    return { ok: false, error: 'option_not_found', options: options };
  }
  select.scrollIntoView({ block: 'center', inline: 'center' });
  if (typeof select.focus === 'function') select.focus();
  var descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
  if (descriptor && descriptor.set) {
    descriptor.set.call(select, options[matched].value);
  } else {
    select.value = options[matched].value;
  }
  select.dispatchEvent(new Event('input', { bubbles: true }));
  select.dispatchEvent(new Event('change', { bubbles: true }));
  return {
    ok: true,
    value: String(select.value),
    label: options[matched].label,
    options: describeOptions()
  };
  } catch (e) {
    return { ok: false, error: 'inject_failed', message: String((e && e.message) || e) };
  }
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
