import type {
  AppUiRef,
  FilterSnapshotOptions,
  FilterSnapshotResult,
  RawSnapshotNode,
} from './types'

/** 快照节点数量默认上限 */
export const DEFAULT_SNAPSHOT_NODE_LIMIT = 120

/**
 * 注入主窗口 webContents 的快照采集脚本。
 * 在页面内遍历可交互节点，返回原始节点数组供 filterSnapshotNodes 过滤。
 *
 * 除位置与名称外还会回读：
 * - 输入框的当前值与 placeholder（分开回传，避免把占位符误当成已填内容）
 * - 原生下拉框的全部选项（Electron 里点开 select 弹的是系统菜单，截图看不到）
 * - 中心点命中测试结果（弹窗打开时，被遮罩挡住的背景元素会被标记后剔除）
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

  var NAME_MAX = 80;

  function normalize(text) {
    return String(text == null ? '' : text).replace(/\\s+/g, ' ').trim();
  }

  function getSelectOptions(el) {
    return Array.prototype.map.call(el.options || [], function (opt) {
      return { value: String(opt.value), label: normalize(opt.textContent) };
    });
  }

  function getSelectedLabel(el) {
    var opt = el.options && el.options[el.selectedIndex];
    return opt ? normalize(opt.textContent) : '';
  }

  function getAccessibleName(el) {
    var labelled = el.getAttribute('aria-label');
    if (labelled) return normalize(labelled).slice(0, NAME_MAX);
    var labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      var ref = document.getElementById(labelledBy);
      if (ref && ref.textContent) return normalize(ref.textContent).slice(0, NAME_MAX);
    }
    var tag = el.tagName.toLowerCase();
    if (tag === 'select') {
      return getSelectedLabel(el).slice(0, NAME_MAX);
    }
    if (tag === 'input' || tag === 'textarea') {
      var title = el.getAttribute('title');
      if (title) return normalize(title).slice(0, NAME_MAX);
      var placeholder = el.getAttribute('placeholder');
      if (placeholder) return normalize(placeholder).slice(0, NAME_MAX);
      return '';
    }
    return normalize(el.textContent).slice(0, NAME_MAX);
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
    if (tag === 'input') {
      var type = (el.getAttribute('type') || 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      return 'textbox';
    }
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

  // 中心点被挡时再试左上角内缩点，兼容 tooltip、圆角、装饰层等局部遮挡
  function isOccluded(el, rect) {
    if (typeof document.elementFromPoint !== 'function') return false;
    var probes = [
      [rect.left + rect.width / 2, rect.top + rect.height / 2],
      [rect.left + Math.min(8, rect.width / 4), rect.top + Math.min(8, rect.height / 4)]
    ];
    for (var i = 0; i < probes.length; i++) {
      var hit = document.elementFromPoint(probes[i][0], probes[i][1]);
      if (hit && (hit === el || el.contains(hit) || hit.contains(el))) return false;
    }
    return true;
  }

  function readValue(el) {
    var tag = el.tagName.toLowerCase();
    if (tag === 'select') return String(el.value == null ? '' : el.value);
    if (tag !== 'input' && tag !== 'textarea') return undefined;
    var raw = String(el.value == null ? '' : el.value);
    if (raw === '') return '';
    var type = (el.getAttribute('type') || 'text').toLowerCase();
    if (type === 'password') return '***(' + raw.length + ' 字符)';
    return raw.slice(0, 120);
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
    var tag = el.tagName.toLowerCase();
    nodes.push({
      role: getRole(el),
      name: getAccessibleName(el),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      w: Math.round(rect.width),
      h: Math.round(rect.height),
      hidden: hidden,
      ignored: false,
      occluded: hidden ? false : isOccluded(el, rect),
      inDialog: !!el.closest('[role=dialog], dialog, [aria-modal="true"]'),
      value: readValue(el),
      placeholder: el.getAttribute('placeholder') || undefined,
      options: tag === 'select' ? getSelectOptions(el) : undefined,
      appUi: appUi || undefined
    });
  });
  return nodes;
})()`

/**
 * 判断原始节点是否应被过滤掉。
 * occluded 的节点点了也点不到（典型场景：弹窗打开时背后的侧栏按钮），直接剔除。
 */
function shouldExcludeNode(node: RawSnapshotNode): boolean {
  if (node.hidden) return true
  if (node.ignored) return true
  if (node.occluded) return true
  if (node.w <= 0 || node.h <= 0) return true
  return false
}

/** 表单类角色，配置面板里最常被操作，排序时优先保留 */
const FORM_ROLES = new Set(['textbox', 'combobox', 'checkbox', 'radio', 'switch'])

/**
 * 计算节点优先级：数值越小越靠前。
 *
 * 截断上限有限，弹层内的表单控件比背景里的长列表有用得多，
 * 因此先按「弹层 > 显式标记 > 表单控件 > 其他」分层，再在层内按阅读顺序排。
 */
function nodePriority(node: RawSnapshotNode): number {
  if (node.inDialog && FORM_ROLES.has(node.role)) return 0
  if (node.inDialog) return 1
  if (node.appUi) return 2
  if (FORM_ROLES.has(node.role)) return 3
  return 4
}

/**
 * 阅读顺序比较：先上后下、先左后右，坐标接近时视为同一行。
 */
function compareReadingOrder(a: RawSnapshotNode, b: RawSnapshotNode): number {
  const rowDelta = a.y - b.y
  if (Math.abs(rowDelta) > 8) return rowDelta
  return a.x - b.x
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
  const sorted = [...eligible].sort((a, b) => {
    const priorityDelta = nodePriority(a) - nodePriority(b)
    if (priorityDelta !== 0) return priorityDelta
    return compareReadingOrder(a, b)
  })
  const truncated = sorted.length > limit
  const kept = sorted.slice(0, limit)

  const refs: AppUiRef[] = kept.map((node, index) => {
    const ref: AppUiRef = {
      ref: `e${index + 1}`,
      role: node.role,
      name: node.name,
      x: node.x,
      y: node.y,
      w: node.w,
      h: node.h,
    }
    if (node.value !== undefined) ref.value = node.value
    if (node.placeholder) ref.placeholder = node.placeholder
    if (node.options && node.options.length > 0) ref.options = node.options
    return ref
  })

  return { refs, truncated }
}

/**
 * 生成单调递增的 snapshotId 字符串，并返回下一序号供内存计数器使用。
 */
export function nextSnapshotId(sequence: number): { snapshotId: string; nextSequence: number } {
  const nextSequence = sequence + 1
  return { snapshotId: String(nextSequence), nextSequence }
}
