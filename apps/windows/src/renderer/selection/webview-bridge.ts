/**
 * webview-bridge.ts - HTML 预览里的划词 → 宿主划词层
 *
 * HTML 预览跑在 `<webview>` 的独立文档里（见 FilePreviewModal 的说明），
 * 宿主的 SelectionLayer 收不到那里的鼠标事件。guest 侧的 preload
 * （`src/preload/webview-selection.ts`）把选区送过来，这里做两件事：
 *
 * 1. **坐标翻译**：guest 给的 rect 是它自己视口里的坐标，而浮条/气泡都按宿主视口
 *    绝对定位（它们是 fixed）。所以要加上 webview 元素在宿主里的位置。
 * 2. **拼成和宿主一致的快照形状**：下游（浮条、菜单、气泡、引用）只认
 *    `SelectionSnapshot`，不关心它是从哪个文档来的。
 *
 * 出处标为 `markdown-preview` —— 它是「文件预览」这一类的既有取值；HTML 预览没有
 * 更贴切的 kind，而 `plain` 会丢掉出处。
 */

import type { SelectionSnapshot, SelectionSource, SnapshotRect } from './snapshot'

/** 与 `src/preload/webview-selection.ts` 约定的通道名，两侧必须一致 */
export const WEBVIEW_SELECTION_CHANNEL = 'lumii:webview-selection'

type Surface = 'bar' | 'menu'

export interface WebviewSelectionEvent {
  type: 'show' | 'close'
  surface?: Surface
  text?: string
  rect?: SnapshotRect
  anchorRect?: SnapshotRect
  point?: { x: number; y: number }
}

/** 宿主里 webview 元素的位置；只需要用到左上角与它自己的原点 */
export interface WebviewFrame {
  readonly left: number
  readonly top: number
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

function parseRect(value: unknown): SnapshotRect | null {
  if (!value || typeof value !== 'object') return null
  const r = value as Record<string, unknown>
  if (!isFiniteNumber(r.top) || !isFiniteNumber(r.left)) return null
  if (!isFiniteNumber(r.width) || !isFiniteNumber(r.height)) return null
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

function shift(rect: SnapshotRect, frame: WebviewFrame): SnapshotRect {
  return {
    top: rect.top + frame.top,
    left: rect.left + frame.left,
    width: rect.width,
    height: rect.height,
  }
}

/**
 * 把 guest 送来的事件解析成宿主侧的快照。
 *
 * 返回 null 表示这条消息不构成「该弹浮条/菜单」（close、或字段不合法）——
 * guest 的 preload 与应用同版本发布，但跨进程消息不该假设形状一定对。
 */
export function toSelectionSnapshot(
  event: WebviewSelectionEvent,
  frame: WebviewFrame,
  now: number = Date.now(),
): SelectionSnapshot | null {
  if (event?.type !== 'show') return null

  const text = typeof event.text === 'string' ? event.text : ''
  if (text.trim().length === 0) return null

  const rect = parseRect(event.rect)
  if (!rect) return null
  const anchorRect = parseRect(event.anchorRect) ?? rect

  const source: SelectionSource = { kind: 'markdown-preview' }

  return {
    text,
    rect: shift(rect, frame),
    anchorRect: shift(anchorRect, frame),
    source,
    createdAt: now,
  }
}

/** 菜单的弹出坐标（指针位置）也要翻译 */
export function toHostPoint(
  point: { x: number; y: number } | undefined,
  frame: WebviewFrame,
): { x: number; y: number } | undefined {
  if (!point || !isFiniteNumber(point.x) || !isFiniteNumber(point.y)) return undefined
  return { x: point.x + frame.left, y: point.y + frame.top }
}

/** iframe 那条路（CSS / SVG 静态预览）用 postMessage，报文带这个标记以便与页面上别的消息区分 */
export const IFRAME_SELECTION_MARKER = 'lumii-selection'

/**
 * 注入 iframe（`srcDoc`）里的取词脚本。
 *
 * 与 webview 的 preload 是同一套逻辑的两种载体：webview 有 preload 通道，
 * iframe 只能 `srcDoc` 注入 + `postMessage`。**两边必须同步改** ——
 * 所以报文形状与 preload 保持一致（type/surface/text/rect/anchorRect/point）。
 *
 * 写成字符串是因为它要进 srcDoc，不能是模块。
 *
 * `nonce` 是必需的，不是可选的加固：iframe 的 `sandbox` 必须放开 `allow-scripts`
 * 内联脚本才会执行（`sandbox=""` 下**任何**脚本都不跑，实测见
 * `verify/selection/probe-webview-preload.cjs` 的 E/F 用例）。放开之后，
 * 预览内容里自带的 `<script>`（SVG 可以有）也会跟着跑，所以配一条
 * `script-src 'nonce-…'` 的 CSP 把授权收到只认这段脚本。nonce 由调用方每次生成。
 */
function buildIframeSelectionScript(nonce: string): string {
  return `<script nonce="${nonce}">(function(){
  var M = ${JSON.stringify(IFRAME_SELECTION_MARKER)};
  function rectOf(r){ return { top: r.top, left: r.left, width: r.width, height: r.height }; }
  function editable(node){
    var el = node && node.nodeType === 1 ? node : (node && node.parentElement);
    if (!el || !el.closest) return false;
    if (el.closest('input, textarea, select')) return true;
    var declared = el.closest('[contenteditable]');
    return !!declared && declared.getAttribute('contenteditable') !== 'false';
  }
  function send(payload){ try { parent.postMessage(Object.assign({ marker: M }, payload), '*'); } catch (e) {} }
  function read(e){
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount || sel.isCollapsed) return null;
    var text = sel.toString();
    if (!text.trim()) return null;
    var range = sel.getRangeAt(0);
    if (editable(range.startContainer)) return null;
    var rect = rectOf(range.getBoundingClientRect());
    var anchor = rect, rects = range.getClientRects();
    for (var i = rects.length - 1; i >= 0; i--) {
      if (rects[i].width > 0 && rects[i].height > 0) { anchor = rectOf(rects[i]); break; }
    }
    return { text: text, rect: rect, anchorRect: anchor, point: e ? { x: e.clientX, y: e.clientY } : undefined };
  }
  document.addEventListener('mouseup', function(e){
    if (e.button !== 0) return;
    var p = read(e);
    send(p ? Object.assign({ type: 'show', surface: 'bar' }, p) : { type: 'close' });
  }, true);
  document.addEventListener('contextmenu', function(e){
    var p = read(e);
    if (!p) return;
    e.preventDefault();
    send(Object.assign({ type: 'show', surface: 'menu' }, p));
  }, true);
  window.addEventListener('scroll', function(){ send({ type: 'close' }); }, true);
  window.addEventListener('resize', function(){ send({ type: 'close' }); });
  document.addEventListener('mousedown', function(){ send({ type: 'close' }); }, true);
  document.addEventListener('keydown', function(e){ if (e.key === 'Escape') send({ type: 'close' }); });
})()</script>`
}

/**
 * 静态预览 srcDoc 的开头注入物：CSP + 取词脚本。
 *
 * CSP 必须排在脚本**之前**（meta 形式的 CSP 只对出现在它之后的内容生效）。
 */
export function buildIframeSelectionInjection(nonce: string): string {
  const csp = `<meta http-equiv="Content-Security-Policy" content="script-src 'nonce-${nonce}'">`
  return csp + buildIframeSelectionScript(nonce)
}
