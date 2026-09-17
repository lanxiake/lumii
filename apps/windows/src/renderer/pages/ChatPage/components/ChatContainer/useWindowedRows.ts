/**
 * 消息列表的窗口化渲染（自实现虚拟化）
 *
 * 背景（2026-09-15，perf 日志实证，见 docs/plans/代码重构/客户端切片/06-消息列表虚拟化.md）：
 * 长会话把每条消息的完整 DOM 常驻在列表里。实测单个渲染进程 3 小时从 394MB 涨到 1737MB，
 * 其中 73%（+976MB）是 Blink 分配器（PartitionAlloc）的预留量，而真正活跃的分配只有
 * 145MB —— 875MB 是「扩出去就没再归还系统」的碎片。成因是每条消息里成百上千个
 * highlight.js `<span>` 反复分配/释放。同一时刻 JS 堆只有 116MB，所以正解是
 * **少挂点 DOM**，而不是去优化 React 的渲染次数。
 *
 * 两条独立手段，各自可单独失效：
 *
 * A. **窗口化（卸载 DOM，治本）**：超出视口 ±OVERSCAN 的行换成等高占位 div，
 *    真实子树整个卸载，Blink 才有机会回收那些 span。
 * B. **content-visibility（跳过布局绘制，缓解）**：仍在窗口带内、但确实在视口外的行，
 *    让 Chromium 跳过其布局与绘制。它**不**卸载 DOM、不回收内存，只降渲染开销。
 *
 * 四条不变式：
 *
 * 1. **只占位「已实测高度」的行**。没测过高度的行永远渲染真实内容 —— 新前插的历史、
 *    流式新增的消息都在此列，天然避免「估算高度 ≠ 实际高度」带来的滚动跳动。
 * 2. **占位高度 === 实测高度**。替换前后行高一致，滚动位置不变。（故实测值不取整。）
 * 3. **两个判定都只信「明确报告为不可见」**。observer 尚未报告的 key 一律当作可见
 *    （两个 hidden 集合都从空开始、只被 `isIntersecting === false` 写入）——否则行会在
 *    首帧、测高与观察回调之间的窗口里被误判离屏，造成闪烁。
 * 4. **B 只加在真正视口外的行上**。`content-visibility` 会无条件施加 `contain: paint`，
 *    把子元素溢出裁掉；而 `.message` 的入场动画正是 `translateY(20px)` 的溢出，
 *    可见行加 B 会被切掉一截。
 *
 * 另外两个贯穿性约束：
 * - `pinnedKeys` 对 A、B **都**成立：跳过期间元素受 size containment 约束、行高被冻结，
 *   正在长的流式行同样不能被冻（理由见 selectSkippableKeys）。
 * - 实测高度由 `useLayoutEpoch` 兜底失效：字号 / zoom / 容器宽度一变，折叠行内联钉死的
 *   高度就成了错值，必须整体作废重测。
 *
 * 无 observer 时（jsdom）两条手段都不启用，退化为全量渲染 —— 既有测试不受影响。
 * 被占位过的行重新挂载时会补 `no-enter`（见 wasCollapsed）：用户已经看过的内容
 * 不该在滚回来时再弹一次入场动画。
 *
 * 已知局限（不打算靠本机制解决，见计划文档 §六）：
 * - 首帧仍是全量挂载（折叠的前提是先测到高度），冷启动长会话的瞬时峰值不降；
 * - 折叠会卸载行内子树，行内组件的本地 UI 状态（展开态、编辑草稿）随之复位；
 * - 跨窗口带的文本选择 / Ctrl+A 复制只覆盖已挂载的行。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** 视口上下各外扩多少像素内的行保持真实挂载 */
export const ROW_OVERSCAN_PX = 2000

/** 空集合常量：让「无行 / 无 pinned」时下游能拿到稳定引用 */
const EMPTY_KEYS: ReadonlySet<string> = new Set()

export interface WindowedRowsOptions {
  /** 滚动容器（两个 IntersectionObserver 的 root）；为 null（如空会话首屏）时整块不启用 */
  scrollRoot: HTMLElement | null
  /** 列表里所有行的稳定 key，顺序与渲染顺序一致 */
  keys: readonly string[]
  /** 永不占位的 key（如正在流式输出的行） */
  pinnedKeys: ReadonlySet<string>
  /** 视口外扩像素，默认 ROW_OVERSCAN_PX */
  overscanPx?: number
}

export interface WindowedRows {
  /** 行容器的 ref 回调（按 key 记忆，同 key 引用稳定，避免 React 反复重挂） */
  registerRow: (key: string) => (el: HTMLElement | null) => void
  /** 该行本轮是否应替换为等高占位（手段 A） */
  isCollapsed: (key: string) => boolean
  /** 该行是否该加 content-visibility（手段 B：在窗口带内、但确实在视口外） */
  isSkippable: (key: string) => boolean
  /** 该行已实测高度（px）；未测到为 undefined */
  heightOf: (key: string) => number | undefined
  /** 该行是否曾被占位卸载过 —— 重新挂载时据此抑制入场动画 */
  wasCollapsed: (key: string) => boolean
}

/**
 * 挑出需要占位的行 key（纯函数，便于单测）。
 * 条件：已实测高度 > 0、落在窗口带之外、且不在「永不占位」名单里。
 */
export function selectCollapsedKeys(
  keys: readonly string[],
  heights: ReadonlyMap<string, number>,
  bandHidden: ReadonlySet<string>,
  pinned: ReadonlySet<string>,
): Set<string> {
  const collapsed = new Set<string>()
  for (const key of keys) {
    if (pinned.has(key) || !bandHidden.has(key)) continue
    const height = heights.get(key)
    if (height === undefined || height <= 0) continue
    collapsed.add(key)
  }
  return collapsed
}

/**
 * 挑出可以加 content-visibility 的行 key（纯函数，便于单测）。
 * 与占位互斥：已占位的行只剩一个空 div，没什么可跳过的。
 *
 * 四个条件缺一不可：
 * - **确实在视口外**：见文件头不变式 4 关于 contain: paint 裁切的说明；
 * - **在窗口带内**：带外的行已经走占位，不需要这种「轻量」手段；
 * - **已经被看见过**：跳过期间不跑动画，若让「挂载时就在屏外」的行（前插的历史页）
 *   跳过，它的入场动画会推迟到用户滚到它时才播 —— 表现为滚上去时消息逐条弹入。
 *   只对已经滚过去看过的行动手，既避开这个坑，也让「跳过」始终是纯优化。
 * - **不是 pinned**：跳过期间元素受 size containment 约束，行高会冻结在最后一次实测值。
 *   正在流式输出的那条正文每帧都在长，冻住它会让 scrollHeight 停在旧值、粘底跟随失准，
 *   滑回来时行高一次性补齐而跳变 —— 与不占位是同一个理由（见 pinnedKeys）。
 */
export function selectSkippableKeys(
  keys: readonly string[],
  heights: ReadonlyMap<string, number>,
  bandHidden: ReadonlySet<string>,
  viewportHidden: ReadonlySet<string>,
  seen: ReadonlySet<string>,
  pinned: ReadonlySet<string>,
): Set<string> {
  const skippable = new Set<string>()
  for (const key of keys) {
    if (pinned.has(key)) continue
    if (bandHidden.has(key) || !viewportHidden.has(key) || !seen.has(key)) continue
    const height = heights.get(key)
    if (height === undefined || height <= 0) continue
    skippable.add(key)
  }
  return skippable
}

/** 读 ResizeObserver 条目的块轴尺寸；borderBoxSize 优先（含 padding/border），退化到 contentRect */
export function readEntryBlockSize(entry: ResizeObserverEntry): number {
  const box = entry.borderBoxSize as ResizeObserverSize | readonly ResizeObserverSize[] | undefined
  const first = (Array.isArray(box) ? box[0] : box) as ResizeObserverSize | undefined
  if (first && typeof first.blockSize === 'number' && first.blockSize > 0) return first.blockSize
  return entry.contentRect?.height ?? 0
}

/** 读根元素上的消息字号（--chat-font-size 由 TitleBar 的 A−/A+ 写在 documentElement 上） */
function readChatFontSize(): string {
  if (typeof getComputedStyle !== 'function') return ''
  return getComputedStyle(document.documentElement).getPropertyValue('--chat-font-size').trim()
}

/** 布局信号静默多久后才认定为「一次布局变更」—— 见 useLayoutEpoch 的防抖说明 */
const LAYOUT_SETTLE_MS = 200

/**
 * 全局布局纪元：消息字号（TitleBar A−/A+ → `--chat-font-size`）或滚动容器宽度一变，值 +1。
 *
 * 为什么需要它：折叠行的高度是内联钉死的。一旦发生全局重排（改字号、Ctrl+滚轮 zoom、
 * 窗口缩放、拖动工作区面板），已挂载的行会经 RO 更新，而折叠行停在旧值 ——
 * scrollHeight 与实际布局对不上，每滚回一行就跳一次。纪元变化时上层清空高度缓存并
 * 强制重测，以「暂时多挂几行」换布局正确。
 *
 * 两个信号都经**防抖**才 +1，且刻意避开会造成自激的量：
 * - 防抖：拖动窗口边缘/分隔条时宽度每帧都在变，若每帧作废，折叠行会逐帧走
 *   「展开 → 重测 → 再折叠」，等于把整份会话按帧重挂一遍（卡死）。等布局静默下来算一次。
 * - 宽度取 **border box**（`getBoundingClientRect`）：滚动条出现/消失会改变 content box，
 *   若跟着失效就会「失效 → 展开行 → 撑出滚动条 → 再失效」来回震荡；
 * - 字号只在根元素 style 上的 `--chat-font-size` 真的变了才算数：根元素还有别的内联变量
 *   写入（如 `--chat-overlay-top`），不能一有 style 变更就失效。
 */
function useLayoutEpoch(scrollRoot: HTMLElement | null): number {
  const [epoch, setEpoch] = useState(0)

  useEffect(() => {
    if (!scrollRoot) return

    let timer: ReturnType<typeof setTimeout> | null = null
    const bump = () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => {
        timer = null
        setEpoch((n) => n + 1)
      }, LAYOUT_SETTLE_MS)
    }

    let width = scrollRoot.getBoundingClientRect().width
    const ro =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            const next = scrollRoot.getBoundingClientRect().width
            if (Math.abs(next - width) < 1) return
            width = next
            bump()
          })
        : null
    ro?.observe(scrollRoot)

    let fontSize = readChatFontSize()
    const mo =
      typeof MutationObserver !== 'undefined'
        ? new MutationObserver(() => {
            const next = readChatFontSize()
            if (next === fontSize) return
            fontSize = next
            bump()
          })
        : null
    mo?.observe(document.documentElement, { attributes: true, attributeFilter: ['style'] })

    return () => {
      if (timer) clearTimeout(timer)
      ro?.disconnect()
      mo?.disconnect()
    }
  }, [scrollRoot])

  return epoch
}

/** 剔除已不在列表里的 key；无变化时返回原集合，避免下游白白重渲染 */
export function pruneKeySet(prev: ReadonlySet<string>, alive: ReadonlySet<string>): ReadonlySet<string> {
  let next: Set<string> | null = null
  for (const key of prev) {
    if (alive.has(key)) continue
    next ??= new Set(prev)
    next.delete(key)
  }
  return next ?? prev
}

/** 剔除已不在列表里的高度记录；无变化时返回原 Map */
export function pruneHeightMap(
  prev: ReadonlyMap<string, number>,
  alive: ReadonlySet<string>,
): ReadonlyMap<string, number> {
  let next: Map<string, number> | null = null
  for (const key of prev.keys()) {
    if (alive.has(key)) continue
    next ??= new Map(prev)
    next.delete(key)
  }
  return next ?? prev
}

/** 三个集合共用的写入逻辑：把「明确不可见」的 key 记进 hidden，可见的移出；无变化返回原集合 */
function applyHidden(
  prev: ReadonlySet<string>,
  entries: IntersectionObserverEntry[],
  alive: ReadonlySet<string>,
): ReadonlySet<string> {
  let next: Set<string> | null = null
  for (const entry of entries) {
    const key = rowKeyOfEntry(entry, alive)
    if (!key) continue
    // IO 的 isIntersecting 与「hidden」语义相反，这里统一取反后再比较
    const want = !entry.isIntersecting
    if (want === prev.has(key)) continue
    next ??= new Set(prev)
    if (want) next.add(key)
    else next.delete(key)
  }
  return next ?? prev
}

/**
 * 从 intersection 条目取行 key，并丢弃「已不在列表里」的迟到条目。
 *
 * 为什么必须过滤：规范里 unobserve 只把目标移出观察列表，**不会清空已排队的条目**，
 * 所以切换会话时被 unobserve 的行仍可能投递一次。那些 key 本已被 prune 掉，任其写回
 * 就会留下「幽灵记录」—— 切回原会话时 key 重新出现，行会在首帧就被判成离屏/已看过，
 * 出现文件头不变式 3 要避免的闪烁。
 */
function rowKeyOfEntry(
  entry: IntersectionObserverEntry,
  alive: ReadonlySet<string>,
): string | undefined {
  const key = (entry.target as HTMLElement).dataset.rowKey
  return key && alive.has(key) ? key : undefined
}

/**
 * 窗口化行渲染。返回值里的访问器每次渲染都会重建，调用方（ChatContainer）只在自身
 * render 内同步使用，不参与 props/memo 比较；唯一需要引用稳定的是 registerRow(key)。
 */
export function useWindowedRows({
  scrollRoot,
  keys,
  pinnedKeys,
  overscanPx = ROW_OVERSCAN_PX,
}: WindowedRowsOptions): WindowedRows {
  const [heights, setHeights] = useState<ReadonlyMap<string, number>>(() => new Map())
  /** 窗口带（±overscan）之外 —— 可占位 */
  const [bandHidden, setBandHidden] = useState<ReadonlySet<string>>(() => new Set())
  /** 真实视口之外 —— 可加 content-visibility（配合「在窗口带内」使用） */
  const [viewportHidden, setViewportHidden] = useState<ReadonlySet<string>>(() => new Set())
  /** 曾经进入过视口的 key —— content-visibility 的前置条件，见 selectSkippableKeys */
  const [seenKeys, setSeenKeys] = useState<ReadonlySet<string>>(() => new Set())
  const [everCollapsed, setEverCollapsed] = useState<ReadonlySet<string>>(() => new Set())

  /** key → 行容器元素 */
  const elementsRef = useRef(new Map<string, HTMLElement>())
  /** key → ref 回调（同 key 复用同一函数，React 才不会每次渲染都重挂元素） */
  const callbacksRef = useRef(new Map<string, (el: HTMLElement | null) => void>())
  const bandIoRef = useRef<IntersectionObserver | null>(null)
  const viewIoRef = useRef<IntersectionObserver | null>(null)
  const roRef = useRef<ResizeObserver | null>(null)

  /**
   * 列表当前的 key 集合。观察回调据此丢弃「已不在列表里」的迟到条目
   * （unobserve 不清空已排队条目，见 rowKeyOfEntry）。keys 引用不变时沿用同一集合，
   * 所以只有增删消息/切会话时才重建。
   */
  const aliveRef = useRef<ReadonlySet<string>>(EMPTY_KEYS)
  const aliveSourceRef = useRef<readonly string[] | null>(null)
  if (aliveSourceRef.current !== keys) {
    aliveSourceRef.current = keys
    aliveRef.current = new Set(keys)
  }

  const enabled =
    scrollRoot !== null &&
    typeof IntersectionObserver !== 'undefined' &&
    typeof ResizeObserver !== 'undefined'

  const handleBandIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) =>
      setBandHidden((prev) => applyHidden(prev, entries, aliveRef.current)),
    [],
  )
  /**
   * 视口 observer 兼两职：既维护「视口外」集合，也把进入过视口的 key 记进 seen。
   * 两个 setState 在同一个回调里，React 会批处理成一次渲染。
   */
  const handleViewportIntersect = useCallback((entries: IntersectionObserverEntry[]) => {
    setViewportHidden((prev) => applyHidden(prev, entries, aliveRef.current))
    setSeenKeys((prev) => {
      let next: Set<string> | null = null
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const key = rowKeyOfEntry(entry, aliveRef.current)
        if (!key || prev.has(key)) continue
        next ??= new Set(prev)
        next.add(key)
      }
      return next ?? prev
    })
  }, [])

  const handleResize = useCallback((entries: ResizeObserverEntry[]) => {
    setHeights((prev) => {
      let next: Map<string, number> | null = null
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.rowKey
        if (!key || !aliveRef.current.has(key)) continue
        // 不取整：占位高度要与实测值严格相等（不变式 2）。行高常是小数，
        // 每行差 0.5px 同号累积，几百行就是几十像素的滚动条误差
        const height = readEntryBlockSize(entry)
        // 高度没变就不写 state：滚动/流式期间 RO 会反复触发，全部照单收下会引发无谓重渲染
        if (height <= 0 || prev.get(key) === height) continue
        next ??= new Map(prev)
        next.set(key, height)
      }
      return next ?? prev
    })
  }, [])

  // 观察器随滚动容器出现/消失重建。容器在空会话等分支下不存在 → 整块不启用（退化为全渲染）
  useEffect(() => {
    if (!enabled || !scrollRoot) return

    const bandIo = new IntersectionObserver(handleBandIntersect, {
      root: scrollRoot,
      rootMargin: `${overscanPx}px 0px`,
    })
    const viewIo = new IntersectionObserver(handleViewportIntersect, {
      root: scrollRoot,
      rootMargin: '0px',
    })
    const ro = new ResizeObserver(handleResize)
    bandIoRef.current = bandIo
    viewIoRef.current = viewIo
    roRef.current = ro
    // 容器可能在已有行之后才就位（首屏空态 → 有消息），把已登记的行补挂上
    for (const el of elementsRef.current.values()) {
      bandIo.observe(el)
      viewIo.observe(el)
      ro.observe(el)
    }
    return () => {
      bandIo.disconnect()
      viewIo.disconnect()
      ro.disconnect()
      bandIoRef.current = null
      viewIoRef.current = null
      roRef.current = null
    }
  }, [enabled, scrollRoot, overscanPx, handleBandIntersect, handleViewportIntersect, handleResize])

  /**
   * 全局重排（改字号 / zoom / 容器宽度变化）后，所有实测高度作废。
   * 清空而不是逐行修正：清空后这些行退回「未测高」→ 渲染真实内容 → RO 重新测量，
   * 以「暂时多挂几行」换布局正确。详见 useLayoutEpoch。
   */
  const layoutEpoch = useLayoutEpoch(scrollRoot)
  const epochRef = useRef(layoutEpoch)
  useEffect(() => {
    if (epochRef.current === layoutEpoch) return
    epochRef.current = layoutEpoch
    setHeights(new Map())

    // 清空还不够，得**强制**重新测量一次：RO 只在尺寸变化时回调，而「高度与宽度无关」
    // 的行（纯代码块、max-height 锁死的折叠块、单行短消息）清空后重新展开时，盒子尺寸
    // 与占位高度完全相同（正是不变式 2）→ 不再回调 → 记录永远回不来 → 该行从此不再折叠，
    // 而它恰恰是 span 大户。unobserve + observe 会投递一次初始条目，把这批捞回来。
    for (const el of elementsRef.current.values()) {
      roRef.current?.unobserve(el)
      roRef.current?.observe(el)
    }
  }, [layoutEpoch])

  const registerRow = useCallback((key: string) => {
    const cached = callbacksRef.current.get(key)
    if (cached) return cached
    const callback = (el: HTMLElement | null) => {
      const known = elementsRef.current.get(key)
      if (known && known !== el) {
        bandIoRef.current?.unobserve(known)
        viewIoRef.current?.unobserve(known)
        roRef.current?.unobserve(known)
        elementsRef.current.delete(key)
      }
      if (!el) {
        // 行彻底卸载：元素与回调一并回收，key 复用时重新登记
        callbacksRef.current.delete(key)
        return
      }
      // 观察回调靠这个属性回认 key（与 React 的 key 无关，故在这里直接写 DOM）
      el.dataset.rowKey = key
      elementsRef.current.set(key, el)
      bandIoRef.current?.observe(el)
      viewIoRef.current?.observe(el)
      roRef.current?.observe(el)
    }
    callbacksRef.current.set(key, callback)
    return callback
  }, [])

  // 列表换了一批 key（切会话、压缩移出消息）时清掉残留，避免各集合随会话数无界增长
  useEffect(() => {
    const alive = new Set(keys)
    for (const [key, el] of [...elementsRef.current]) {
      if (alive.has(key)) continue
      bandIoRef.current?.unobserve(el)
      viewIoRef.current?.unobserve(el)
      roRef.current?.unobserve(el)
      elementsRef.current.delete(key)
    }
    for (const key of [...callbacksRef.current.keys()]) {
      if (!alive.has(key)) callbacksRef.current.delete(key)
    }
    setBandHidden((prev) => pruneKeySet(prev, alive))
    setViewportHidden((prev) => pruneKeySet(prev, alive))
    setSeenKeys((prev) => pruneKeySet(prev, alive))
    setHeights((prev) => pruneHeightMap(prev, alive))
    // everCollapsed 也在这个集合族里，漏掉它就等于留一个只增不减的结构
    // （且切回旧会话时 wasCollapsed 恒真，那批行的入场动画再也回不来）
    setEverCollapsed((prev) => pruneKeySet(prev, alive))
  }, [keys])

  const collapsedKeys = useMemo(
    () => selectCollapsedKeys(keys, heights, bandHidden, pinnedKeys),
    [keys, heights, bandHidden, pinnedKeys],
  )

  const skippableKeys = useMemo(
    () => selectSkippableKeys(keys, heights, bandHidden, viewportHidden, seenKeys, pinnedKeys),
    [keys, heights, bandHidden, viewportHidden, seenKeys, pinnedKeys],
  )

  useEffect(() => {
    if (collapsedKeys.size === 0) return
    setEverCollapsed((prev) => {
      let next: Set<string> | null = null
      for (const key of collapsedKeys) {
        if (prev.has(key)) continue
        next ??= new Set(prev)
        next.add(key)
      }
      return next ?? prev
    })
  }, [collapsedKeys])

  return {
    registerRow,
    isCollapsed: (key) => collapsedKeys.has(key),
    isSkippable: (key) => skippableKeys.has(key),
    heightOf: (key) => heights.get(key),
    wasCollapsed: (key) => everCollapsed.has(key),
  }
}
