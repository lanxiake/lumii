import { describe, expect, it } from 'vitest'

import { isExtensionActive, setActiveExtensionIds } from './active'

/**
 * 这个门决定「禁用插件后功能到底关没关」。两种错法代价不同：
 * - 快照没写时当禁用 → 启动早期的消费方悄悄把功能关掉，症状是「功能没了」
 * - 快照写了却当启用 → 禁用无效（改之前就是这个问题）
 */
describe('isExtensionActive', () => {
  it('快照还没写：一律当作启用（fail-open）', () => {
    // 用没见过的 id，避开同文件里别的用例写过的快照
    expect(isExtensionActive('never-registered@test')).toBe(true)
  })

  it('写了快照之后：不在集合里就是禁用', () => {
    setActiveExtensionIds(new Set(['com.lumii.vcs']))
    expect(isExtensionActive('com.lumii.vcs')).toBe(true)
    expect(isExtensionActive('com.lumii.relay')).toBe(false)
  })
})
