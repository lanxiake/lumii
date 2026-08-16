import type {
  AppUiRef,
  FilterSnapshotOptions,
  FilterSnapshotResult,
  RawSnapshotNode,
} from './types'

/** 快照节点数量默认上限 */
export const DEFAULT_SNAPSHOT_NODE_LIMIT = 120

/** 语义角色：不可交互，但含关键标题/字段名信息 */
export const SEMANTIC_ROLES = new Set(['heading', 'section_title', 'label'])

/**
 * 注入主窗口 webContents 的快照采集脚本。
 * 在页面内遍历可交互节点与语义标题节点，返回原始节点数组供 filterSnapshotNodes 过滤。
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
    '[tabindex]:not([tabindex="-1"])',
    '[data-app-ui-heading]',
    '[data-app-ui-section-title]',
    '[data-app-ui-label]',
    'h1, h2, h3, h4, h5, h6'
  ].join(',');

  var NAME_MAX = 80;
  var LABEL_NAME_MAX = 60;

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
    var maxLen = el.hasAttribute('data-app-ui-label') ? LABEL_NAME_MAX : NAME_MAX;
    return normalize(el.textContent).slice(0, maxLen);
  }

  function getRole(el) {
    var blockHost = el.closest('[data-app-ui-block]');
    if (blockHost) {
      var blockRole = blockHost.getAttribute('data-app-ui-block');
      if (blockRole === 'composer' || blockRole === 'runtime') return blockRole;
    }
    // 语义标记优先于显式 ARIA role / 标签推断
    if (el.hasAttribute('data-app-ui-heading')) return 'heading';
    if (el.hasAttribute('data-app-ui-section-title')) return 'section_title';
    if (el.hasAttribute('data-app-ui-label')) return 'label';
    var explicit = el.getAttribute('role');
    if (explicit) return explicit;
    var tag = el.tagName.toLowerCase();
    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4' || tag === 'h5' || tag === 'h6') {
      return 'heading';
    }
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
 * 语义层=0、交互层=1，供两阶段配额截断分层。
 */
function semanticTier(node: RawSnapshotNode): number {
  return SEMANTIC_ROLES.has(node.role) ? 0 : 1
}

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
 * 支持 refs_filter（roles / y 区间 / name_contains）与语义/交互两阶段配额。
 * 纯函数，不依赖 DOM，供单测与截图控制器共用。
 */
export function filterSnapshotNodes(
  raw: RawSnapshotNode[],
  options: FilterSnapshotOptions = {},
): FilterSnapshotResult {
  let eligible = raw.filter((n) => !shouldExcludeNode(n))

  // refs_filter：在截断前应用，避免浪费配额
  if (options.roles) {
    const set = new Set(options.roles)
    eligible = eligible.filter((n) => set.has(n.role))
  }
  if (typeof options.y_min === 'number') {
    const yMin = options.y_min
    eligible = eligible.filter((n) => n.y + n.h >= yMin)
  }
  if (typeof options.y_max === 'number') {
    const yMax = options.y_max
    eligible = eligible.filter((n) => n.y <= yMax)
  }
  if (options.name_contains) {
    const q = options.name_contains.toLowerCase()
    eligible = eligible.filter((n) => n.name.toLowerCase().includes(q))
  }

  const totalLimit = options.limit ?? DEFAULT_SNAPSHOT_NODE_LIMIT
  // 约 1/3 给语义；limit 很小时至少留 1 个语义名额（limit>=2），保证标题不被挤掉
  const defaultSemantic = Math.max(totalLimit >= 2 ? 1 : 0, Math.floor(totalLimit / 3))
  const semLimit = Math.min(options.semantic_limit ?? defaultSemantic, totalLimit)
  const intLimit = totalLimit - semLimit

  const semSorted = eligible
    .filter((n) => semanticTier(n) === 0)
    .sort((a, b) => compareReadingOrder(a, b))
  const intSorted = eligible
    .filter((n) => semanticTier(n) === 1)
    .sort((a, b) => {
      const priorityDelta = nodePriority(a) - nodePriority(b)
      return priorityDelta !== 0 ? priorityDelta : compareReadingOrder(a, b)
    })

  // 未用满的一侧配额让给另一侧，避免「无标题页」白白浪费语义名额
  let keptSem = semSorted.slice(0, semLimit)
  let keptInt = intSorted.slice(0, intLimit)
  const unusedSem = semLimit - keptSem.length
  if (unusedSem > 0) {
    keptInt = intSorted.slice(0, intLimit + unusedSem)
  }
  const unusedInt = intLimit + unusedSem - keptInt.length
  if (unusedInt > 0) {
    keptSem = semSorted.slice(0, semLimit + unusedInt)
  }
  const kept = [...keptSem, ...keptInt]
  const truncated = eligible.length > kept.length

  // 语义在前、交互在后，便于 LLM 一眼看到标题
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
