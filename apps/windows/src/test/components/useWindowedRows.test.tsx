/**
 * 消息列表窗口化渲染测试
 *
 * 覆盖两层：
 * - 决策纯函数（selectCollapsedKeys / selectSkippableKeys / prune*）：哪些行该占位、
 *   哪些不该，是这套机制全部的正确性所在
 * - useWindowedRows 接线（用假 IntersectionObserver/ResizeObserver 驱动）：测高 → 报告
 *   离屏 → 行折叠为等高占位；无观察器时退化为全量渲染
 *
 * 背景见 docs/plans/客户端优化/06-消息列表虚拟化.md。
 */
import { describe, it, expect, afterEach, vi } from 'vitest'
import { useState } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import {
  selectCollapsedKeys,
  selectSkippableKeys,
  pruneKeySet,
  pruneHeightMap,
  readEntryBlockSize,
  useWindowedRows,
  ROW_OVERSCAN_PX,
} from '../../renderer/pages/ChatPage/components/ChatContainer/use-windowed-rows'

// ---------------------------------------------------------------
// 决策纯函数
// ---------------------------------------------------------------

describe('selectCollapsedKeys', () => {
  const keys = ['a', 'b', 'c', 'd']
  const heights = new Map([['a', 100], ['b', 200], ['c', 300]])

  it('只占位「已测高 + 离屏 + 非 pinned」的行', () => {
    const collapsed = selectCollapsedKeys(keys, heights, new Set(['a', 'b', 'c', 'd']), new Set())
    expect([...collapsed]).toEqual(['a', 'b', 'c'])
  })

  it('未测过高度的行不占位 —— 占位高度无从取，替换会造成滚动跳动', () => {
    const collapsed = selectCollapsedKeys(keys, heights, new Set(['d']), new Set())
    expect(collapsed.size).toBe(0)
  })

  it('窗口带内的行不占位（无论是否测过高度）', () => {
    const collapsed = selectCollapsedKeys(keys, heights, new Set(['c']), new Set())
    expect([...collapsed]).toEqual(['c'])
    expect(collapsed.has('a')).toBe(false)
  })

  it('pinned 行永不占位（流式输出中的那条）', () => {
    const collapsed = selectCollapsedKeys(keys, heights, new Set(['a', 'b']), new Set(['a']))
    expect([...collapsed]).toEqual(['b'])
  })

  it('高度为 0 视作未测到', () => {
    const zero = new Map([['a', 0]])
    const collapsed = selectCollapsedKeys(['a'], zero, new Set(['a']), new Set())
    expect(collapsed.size).toBe(0)
  })
})

describe('selectSkippableKeys', () => {
  const keys = ['a', 'b', 'c']
  const heights = new Map([['a', 100], ['b', 200], ['c', 300]])
  /** 三个 key 都被看见过：把「seen」这个前置条件从多数用例里摘出去 */
  const allSeen = new Set(keys)

  it('只挑「在窗口带内 + 视口外 + 已测高」的行', () => {
    // 带外：a（该走占位）；视口外但在带内：b；视口内：c
    const skippable = selectSkippableKeys(keys, heights, new Set(['a']), new Set(['b']), allSeen)
    expect([...skippable]).toEqual(['b'])
  })

  it('视口内的行永不跳过 —— content-visibility 的 paint containment 会裁掉入场动画', () => {
    const skippable = selectSkippableKeys(keys, heights, new Set(), new Set(), allSeen)
    expect(skippable.size).toBe(0)
  })

  it('尚未收到视口 observer 报告的行不跳过（宁可不省，不可裁切）', () => {
    const skippable = selectSkippableKeys(keys, heights, new Set(), new Set(['c']), allSeen)
    expect(skippable.has('a')).toBe(false)
    expect(skippable.has('b')).toBe(false)
  })

  it('没被看见过的行不跳过 —— 跳过期间不跑动画，会把它推迟到用户滚到时才播', () => {
    // a/b/c 都在视口外，但只有 c 进过视口（seen）→ 只有 c 可跳过
    const skippable = selectSkippableKeys(keys, heights, new Set(), new Set(keys), new Set(['c']))
    expect([...skippable]).toEqual(['c'])
    expect(skippable.has('a')).toBe(false)
    expect(skippable.has('b')).toBe(false)
  })

  it('未测高的行不跳过', () => {
    const skippable = selectSkippableKeys(['d'], new Map(), new Set(), new Set(['d']), new Set(['d']))
    expect(skippable.size).toBe(0)
  })
})

describe('prune 系列保持引用稳定', () => {
  it('无残留时返回原集合（下游 memo 才不会被打穿）', () => {
    const prev = new Set(['a', 'b'])
    expect(pruneKeySet(prev, new Set(['a', 'b', 'c']))).toBe(prev)
  })

  it('有残留时剔除并返回新集合', () => {
    const prev = new Set(['a', 'b'])
    const next = pruneKeySet(prev, new Set(['a']))
    expect(next).not.toBe(prev)
    expect([...next]).toEqual(['a'])
  })

  it('高度表同样：无残留返回原 Map，有残留剔除', () => {
    const prev = new Map([['a', 1], ['b', 2]])
    expect(pruneHeightMap(prev, new Set(['a', 'b']))).toBe(prev)
    const next = pruneHeightMap(prev, new Set(['b']))
    expect(next).not.toBe(prev)
    expect([...next.keys()]).toEqual(['b'])
  })
})

describe('readEntryBlockSize', () => {
  it('优先用 borderBoxSize 的块轴尺寸', () => {
    const entry = {
      borderBoxSize: [{ blockSize: 321.4, inlineSize: 800 }],
      contentRect: { height: 300 },
    } as unknown as ResizeObserverEntry
    expect(readEntryBlockSize(entry)).toBe(321.4)
  })

  it('borderBoxSize 缺失/为 0 时退化到 contentRect', () => {
    expect(
      readEntryBlockSize({ contentRect: { height: 250 } } as unknown as ResizeObserverEntry),
    ).toBe(250)
    expect(
      readEntryBlockSize({
        borderBoxSize: [{ blockSize: 0, inlineSize: 0 }],
        contentRect: { height: 250 },
      } as unknown as ResizeObserverEntry),
    ).toBe(250)
  })
})

// ---------------------------------------------------------------
// 接线：假观察器
// ---------------------------------------------------------------

type IOCallback = (entries: IntersectionObserverEntry[], observer: IntersectionObserver) => void

/** 假 IntersectionObserver：记录回调与 rootMargin，可手动投喂可见性 */
class FakeIntersectionObserver {
  static instances: FakeIntersectionObserver[] = []
  static reset() {
    FakeIntersectionObserver.instances = []
  }
  /** 按 rootMargin 取某个实例：窗口带 observer 用 2000px，视口 observer 用 0px */
  static byMargin(margin: string): FakeIntersectionObserver {
    const hit = FakeIntersectionObserver.instances.find((i) => i.options?.rootMargin === margin)
    if (!hit) throw new Error(`未找到 rootMargin=${margin} 的 observer（现有 ${FakeIntersectionObserver.instances.length} 个）`)
    return hit
  }

  readonly targets = new Set<Element>()
  constructor(
    private readonly callback: IOCallback,
    readonly options?: IntersectionObserverInit,
  ) {
    FakeIntersectionObserver.instances.push(this)
  }
  observe(el: Element) {
    this.targets.add(el)
  }
  unobserve(el: Element) {
    this.targets.delete(el)
  }
  disconnect() {
    this.targets.clear()
  }
  takeRecords(): IntersectionObserverEntry[] {
    return []
  }
  /** 投喂一批可见性变化 */
  emit(isIntersecting: boolean, elements: Element[]) {
    const entries = elements.map(
      (target) => ({ target, isIntersecting, intersectionRatio: isIntersecting ? 1 : 0 }) as IntersectionObserverEntry,
    )
    this.callback(entries, this as unknown as IntersectionObserver)
  }
}

/** 假 ResizeObserver：可手动投喂尺寸 */
class FakeResizeObserver {
  static instances: FakeResizeObserver[] = []
  static reset() {
    FakeResizeObserver.instances = []
  }
  static get current(): FakeResizeObserver {
    const hit = FakeResizeObserver.instances[0]
    if (!hit) throw new Error('未创建 ResizeObserver')
    return hit
  }

  readonly targets = new Set<Element>()
  constructor(private readonly callback: ResizeObserverCallback) {
    FakeResizeObserver.instances.push(this)
  }
  observe(el: Element) {
    this.targets.add(el)
  }
  unobserve(el: Element) {
    this.targets.delete(el)
  }
  disconnect() {
    this.targets.clear()
  }
  /** 投喂一批实测尺寸 */
  emit(sizes: Array<{ target: Element; height: number }>) {
    const entries = sizes.map(
      ({ target, height }) =>
        ({
          target,
          borderBoxSize: [{ blockSize: height, inlineSize: 800 }],
          contentRect: { height },
        }) as unknown as ResizeObserverEntry,
    )
    this.callback(entries, this as unknown as ResizeObserver)
  }
}

/** 测试宿主：把 hook 的判定直接渲染成可断言的 DOM */
function Harness({ keys, pinned = [] }: { keys: string[]; pinned?: string[] }) {
  const [root, setRoot] = useState<HTMLDivElement | null>(null)
  const windowed = useWindowedRows({
    scrollRoot: root,
    keys,
    pinnedKeys: new Set(pinned),
  })
  return (
    <div ref={setRoot} data-testid="root">
      {keys.map((key) => {
        const collapsed = windowed.isCollapsed(key)
        const skippable = !collapsed && windowed.isSkippable(key)
        return (
          <div
            key={key}
            ref={windowed.registerRow(key)}
            data-testid={`row-${key}`}
            data-collapsed={collapsed ? 'true' : 'false'}
            data-skippable={skippable ? 'true' : 'false'}
            style={collapsed ? { height: windowed.heightOf(key) } : undefined}
          >
            {collapsed ? null : <span data-testid={`body-${key}`}>{key}</span>}
          </div>
        )
      })}
    </div>
  )
}

/** 让所有行进入窗口带 + 视口（模拟"都在屏幕上"的初始状态） */
function markAllVisible(keys: string[]) {
  const els = keys.map((k) => screen.getByTestId(`row-${k}`))
  act(() => {
    FakeIntersectionObserver.byMargin('0px').emit(true, els)
    FakeIntersectionObserver.byMargin(`${ROW_OVERSCAN_PX}px 0px`).emit(true, els)
  })
}

function measure(sizes: Array<[string, number]>) {
  act(() => {
    FakeResizeObserver.current.emit(sizes.map(([key, height]) => ({ target: screen.getByTestId(`row-${key}`), height })))
  })
}

describe('useWindowedRows 接线', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    FakeIntersectionObserver.reset()
    FakeResizeObserver.reset()
  })

  it('离屏且已测高的行折叠为等高占位，窗口带内的行保持不变', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    render(<Harness keys={['a', 'b', 'c']} />)

    markAllVisible(['a', 'b', 'c'])
    measure([['a', 120], ['b', 240], ['c', 360]])
    // 初始：全部真实挂载
    expect(screen.getByTestId('body-a')).toBeInTheDocument()

    // a 滚出窗口带（c 留在视口内）→ 只有 a 折叠
    act(() => {
      FakeIntersectionObserver.byMargin(`${ROW_OVERSCAN_PX}px 0px`).emit(false, [screen.getByTestId('row-a')])
    })

    expect(screen.getByTestId('row-a').dataset.collapsed).toBe('true')
    expect(screen.queryByTestId('body-a')).not.toBeInTheDocument()
    // 占位高度必须是实测值，否则 scrollHeight 变化会把滚动位置顶掉
    expect(screen.getByTestId('row-a').style.height).toBe('120px')
    expect(screen.getByTestId('body-b')).toBeInTheDocument()
    expect(screen.getByTestId('body-c')).toBeInTheDocument()
  })

  it('未测高的行即使离屏也不折叠', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    render(<Harness keys={['a']} />)

    markAllVisible(['a'])
    act(() => {
      FakeIntersectionObserver.byMargin(`${ROW_OVERSCAN_PX}px 0px`).emit(false, [screen.getByTestId('row-a')])
    })

    expect(screen.getByTestId('row-a').dataset.collapsed).toBe('false')
    expect(screen.getByTestId('body-a')).toBeInTheDocument()
  })

  it('pinned 行（流式输出）即使离屏且已测高也不折叠', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    render(<Harness keys={['a', 'b']} pinned={['a']} />)

    markAllVisible(['a', 'b'])
    measure([['a', 120], ['b', 240]])
    act(() => {
      FakeIntersectionObserver.byMargin(`${ROW_OVERSCAN_PX}px 0px`).emit(false, [
        screen.getByTestId('row-a'),
        screen.getByTestId('row-b'),
      ])
    })

    expect(screen.getByTestId('row-a').dataset.collapsed).toBe('false')
    expect(screen.getByTestId('row-b').dataset.collapsed).toBe('true')
  })

  it('行滚回窗口带后重新挂载真实内容', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    render(<Harness keys={['a']} />)

    markAllVisible(['a'])
    measure([['a', 120]])
    act(() => {
      FakeIntersectionObserver.byMargin(`${ROW_OVERSCAN_PX}px 0px`).emit(false, [screen.getByTestId('row-a')])
    })
    expect(screen.getByTestId('row-a').dataset.collapsed).toBe('true')

    act(() => {
      FakeIntersectionObserver.byMargin(`${ROW_OVERSCAN_PX}px 0px`).emit(true, [screen.getByTestId('row-a')])
    })
    expect(screen.getByTestId('row-a').dataset.collapsed).toBe('false')
    expect(screen.getByTestId('body-a')).toBeInTheDocument()
  })

  it('无 IntersectionObserver（jsdom 默认）时退化为全量渲染', () => {
    // 不 stub 任何观察器：hook 应整块不启用
    render(<Harness keys={['a', 'b']} />)
    expect(screen.getByTestId('body-a')).toBeInTheDocument()
    expect(screen.getByTestId('body-b')).toBeInTheDocument()
    expect(screen.getByTestId('row-a').dataset.collapsed).toBe('false')
  })

  it('两个观察器都挂在滚动容器上，且窗口带 observer 带 overscan', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    render(<Harness keys={['a']} />)

    const root = screen.getByTestId('root')
    const band = FakeIntersectionObserver.byMargin(`${ROW_OVERSCAN_PX}px 0px`)
    const view = FakeIntersectionObserver.byMargin('0px')
    expect(band.options?.root).toBe(root)
    expect(view.options?.root).toBe(root)
    expect(band.targets.has(screen.getByTestId('row-a'))).toBe(true)
    expect(view.targets.has(screen.getByTestId('row-a'))).toBe(true)
    expect(FakeResizeObserver.current.targets.has(screen.getByTestId('row-a'))).toBe(true)
  })

  it('视口外但仍在窗口带内的行被标记可跳过（content-visibility）', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    render(<Harness keys={['a']} />)

    // 先全部可见并测高（进过视口 → 满足 seen 前置）
    markAllVisible(['a'])
    measure([['a', 120]])

    // 仅视口 observer 报告不可见（仍在 ±2000px 带内）
    act(() => {
      FakeIntersectionObserver.byMargin('0px').emit(false, [screen.getByTestId('row-a')])
    })
    // 未折叠（还在带内），但判定为可跳过 —— 由 ChatContainer 加 class
    expect(screen.getByTestId('row-a').dataset.collapsed).toBe('false')
    expect(screen.getByTestId('row-a').dataset.skippable).toBe('true')
  })

  it('从未进过视口的行不给 content-visibility（跳过期间不跑动画，否则滚到才播）', () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver)
    vi.stubGlobal('ResizeObserver', FakeResizeObserver)
    render(<Harness keys={['a']} />)

    // 只测高，不报告「可见过」——模拟挂载时就在屏外的前插历史页
    measure([['a', 120]])
    act(() => {
      FakeIntersectionObserver.byMargin('0px').emit(false, [screen.getByTestId('row-a')])
    })

    expect(screen.getByTestId('row-a').dataset.skippable).toBe('false')
  })
})
