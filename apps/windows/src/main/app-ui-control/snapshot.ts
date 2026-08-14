import type {
  AppUiRef,
  FilterSnapshotOptions,
  FilterSnapshotResult,
  RawSnapshotNode,
} from './types'

/** 快照节点数量默认上限（与设计 §7.6 一致） */
export const DEFAULT_SNAPSHOT_NODE_LIMIT = 80

/**
 * 注入主窗口 webContents 的快照采集脚本。
 * 在页面内遍历可交互节点，返回原始节点数组供 filterSnapshotNodes 过滤。
 */
export const SNAPSHOT_SCRIPT = `(function () {
  var SELECTORS = [
    'button',
    'a[href]',
    'input',
    'textarea',
    'select',
    '[role=button]',
    '[role=tab]',
    '[role=menuitem]',
    '[role=switch]',
    '[contenteditable=true]',
    '[data-app-ui]',
    '[tabindex]:not([tabindex="-1"])'
  ].join(',');

  function getAccessibleName(el) {
    var labelled = el.getAttribute('aria-label');
    if (labelled) return labelled.trim();
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var ref = document.getElementById(labelledBy);
      if (ref && ref.textContent) return ref.textContent.trim();
    }
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      var placeholder = el.getAttribute('placeholder');
      if (placeholder) return placeholder.trim();
    }
    var text = (el.textContent || '').replace(/\\s+/g, ' ').trim();
    return text.slice(0, 120);
  }

  function getRole(el) {
    var blockHost = el.closest('[data-app-ui-block]');
    if (blockHost) {
      var blockRole = blockHost.getAttribute('data-app-ui-block');
      if (blockRole === 'composer' || blockRole === 'runtime') return blockRole;
    }
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'button') return 'button';
    if (tag === 'a') return 'link';
    if (tag === 'input') return el.getAttribute('type') === 'checkbox' ? 'checkbox' : 'textbox';
    if (tag === 'textarea') return 'textbox';
    if (tag === 'select') return 'combobox';
    return tag;
  }

  function isHidden(el, rect) {
    if (el.disabled) return true;
    if (el.getAttribute('aria-hidden') === 'true') return true;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
      return true;
    }
    if (rect.width <= 0 || rect.height <= 0) return true;
    var vw = window.innerWidth || document.documentElement.clientWidth;
    var vh = window.innerHeight || document.documentElement.clientHeight;
    if (rect.bottom <= 0 || rect.right <= 0 || rect.top >= vh || rect.left >= vw) {
      return true;
    }
    return false;
  }

  var nodes = [];
  var seen = new Set();
  document.querySelectorAll(SELECTORS).forEach(function (el) {
    if (!(el instanceof HTMLElement) || seen.has(el)) return;
    seen.add(el);
    if (el.closest('[data-app-ui-ignore]')) return;
    var rect = el.getBoundingClientRect();
    var hidden = isHidden(el, rect);
    var appUi = el.getAttribute('data-app-ui');
    nodes.push({
      role: getRole(el),
      name: getAccessibleName(el),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      hidden: hidden,
      ignored: false,
      appUi: appUi || undefined
    });
  });
  return nodes;
})()`

/**
 * 判断原始节点是否应被过滤掉。
 */
function shouldExcludeNode(node: RawSnapshotNode): boolean {
  if (node.hidden) return true
  if (node.ignored) return true
  if (node.w <= 0 || node.h <= 0) return true
  return false
}

/**
 * 计算节点包围盒面积，用于降序排序。
 */
function nodeArea(node: RawSnapshotNode): number {
  return node.w * node.h
}

/**
 * 将原始节点列表过滤、排序、截断并分配 ref（e1、e2…）。
 * 纯函数，不依赖 DOM，供单测与截图控制器共用。
 */
export function filterSnapshotNodes(
  raw: RawSnapshotNode[],
  options: FilterSnapshotOptions = {},
): FilterSnapshotResult {
  const limit = options.limit ?? DEFAULT_SNAPSHOT_NODE_LIMIT
  const eligible = raw.filter((n) => !shouldExcludeNode(n))
  const sorted = [...eligible].sort((a, b) => nodeArea(b) - nodeArea(a))
  const truncated = sorted.length > limit
  const kept = sorted.slice(0, limit)

  const refs: AppUiRef[] = kept.map((node, index) => ({
    ref: `e${index + 1}`,
    role: node.role,
    name: node.name,
    x: node.x,
    y: node.y,
    w: node.w,
    h: node.h,
  }))

  return { refs, truncated }
}

/**
 * 生成单调递增的 snapshotId 字符串，并返回下一序号供内存计数器使用。
 */
export function nextSnapshotId(sequence: number): { snapshotId: string; nextSequence: number } {
  const nextSequence = sequence + 1
  return { snapshotId: String(nextSequence), nextSequence }
}
