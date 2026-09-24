/**
 * 系统是否要求「减少动效」（`prefers-reduced-motion: reduce`）。
 *
 * 设计依据：宠物智能化设计 §8.7 无障碍表。语义是**区分两类动作**：
 * 装饰性的关掉（待机随机轮播那种"为了丰富而丰富"的），状态表达的留着
 * （走动/坐下的举止变化——那本身就是在传达"它现在怎么样"，关掉等于把信息也关掉）。
 *
 * ## 为什么是订阅而不是读一次
 *
 * 用户可以在应用运行期间改这个系统设置（Windows 的"动画效果"开关），
 * 而宠物窗是**常驻**的——读一次的实现要等到下次重启才生效，
 * 用户看到的是"我明明关了动效它还在动"。`matchMedia` 的 `change` 事件
 * 在 Chromium 里会跟着系统设置走，订阅它没有额外成本。
 */

import { useEffect, useState } from 'react'

/** 媒体查询串。抽出来是为了测试与阅读时不用在代码里找字面量 */
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)'

/** 读一次当前值；环境不支持 `matchMedia`（单测 / 老内核）时按"未要求"处理 */
export function prefersReducedMotionNow(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false
  try {
    return window.matchMedia(REDUCED_MOTION_QUERY).matches
  } catch {
    return false
  }
}

export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => prefersReducedMotionNow())

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    let mql: MediaQueryList
    try {
      mql = window.matchMedia(REDUCED_MOTION_QUERY)
    } catch {
      return
    }
    // 挂载与查询之间有窗口期（设置在这期间被改过），先对齐一次再订阅
    setReduced(mql.matches)
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    mql.addEventListener('change', onChange)
    return () => mql.removeEventListener('change', onChange)
  }, [])

  return reduced
}
