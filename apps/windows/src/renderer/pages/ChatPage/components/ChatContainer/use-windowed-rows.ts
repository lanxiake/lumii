/**
 * 消息列表的窗口化渲染（自实现虚拟化）
 *
 * 背景（2026-09-15，perf 日志实证，见 docs/plans/客户端优化/06-消息列表虚拟化.md）：
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
 * 2. **占位高度 === 实测高度**。替换前后行高一致，滚动位置不变。
 * 3. **两个判定都只信「明确报告为不可见」**。observer 尚未报告的 key 一律当作可见
 *    （两个 hidden 集合都从空开始、只被 `isIntersecting === false` 写入）——否则行会在
 *    首帧、测高与观察回调之间的窗口里被误判离屏，造成闪烁。
 * 4. **B 只加在真正视口外的行上**。`content-visibility` 会无条件施加 `contain: paint`，
 *    把子元素溢出裁掉；而 `.message` 的入场动画正是 `translateY(20px)` 的溢出，
 *    可见行加 B 会被切掉一截。
 *
 * 无 observer 时（jsdom）两条手段都不启用，退化为全量渲染 —— 既有测试不受影响。
 * 被占位过的行重新挂载时会补 `no-enter`（见 wasCollapsed）：用户已经看过的内容
 * 不该在滚回来时再弹一次入场动画。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

/** 视口上下各外扩多少像素内的行保持真实挂载 */
export const ROW_OVERSCAN_PX = 2000

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
 * 三个条件缺一不可：
 * - **确实在视口外**：见文件头不变式 4 关于 contain: paint 裁切的说明；
 * - **在窗口带内**：带外的行已经走占位，不需要这种「轻量」手段；
 * - **已经被看见过**：跳过期间不跑动画，若让「挂载时就在屏外」的行（前插的历史页）
 *   跳过，它的入场动画会推迟到用户滚到它时才播 —— 表现为滚上去时消息逐条弹入。
 *   只对已经滚过去看过的行动手，既避开这个坑，也让「跳过」始终是纯优化。
 */
export function selectSkippableKeys(
  keys: readonly string[],
  heights: ReadonlyMap<string, number>,
  bandHidden: ReadonlySet<string>,
  viewportHidden: ReadonlySet<string>,
  seen: ReadonlySet<string>,
): Set<string> {
  const skippable = new Set<string>()
  for (const key of keys) {
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
): ReadonlySet<string> {
  let next: Set<string> | null = null
  for (const entry of entries) {
    const key = (entry.target as HTMLElement).dataset.rowKey
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

  const enabled =
    scrollRoot !== null &&
    typeof IntersectionObserver !== 'undefined' &&
    typeof ResizeObserver !== 'undefined'

  const handleBandIntersect = useCallback(
    (entries: IntersectionObserverEntry[]) => setBandHidden((prev) => applyHidden(prev, entries)),
    [],
  )
  /**
   * 视口 observer 兼两职：既维护「视口外」集合，也把进入过视口的 key 记进 seen。
   * 两个 setState 在同一个回调里，React 会批处理成一次渲染。
   */
  const handleViewportIntersect = useCallback((entries: IntersectionObserverEntry[]) => {
    setViewportHidden((prev) => applyHidden(prev, entries))
    setSeenKeys((prev) => {
      let next: Set<string> | null = null
      for (const entry of entries) {
        if (!entry.isIntersecting) continue
        const key = (entry.target as HTMLElement).dataset.rowKey
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
        if (!key) continue
        const height = Math.round(readEntryBlockSize(entry))
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
  }, [keys])

  const collapsedKeys = useMemo(
    () => selectCollapsedKeys(keys, heights, bandHidden, pinnedKeys),
    [keys, heights, bandHidden, pinnedKeys],
  )

  const skippableKeys = useMemo(
    () => selectSkippableKeys(keys, heights, bandHidden, viewportHidden, seenKeys),
    [keys, heights, bandHidden, viewportHidden, seenKeys],
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
