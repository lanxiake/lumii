import { describe, it, expect } from 'vitest'
import { resolveToolLoadout, applyToolLoadout } from './tool-loadout'

const tool = (name: string) => ({ name })

/** 造 n 个工具，第 i 个的最后使用时间为 `base - i`（即 all[0] 最新） */
function toolsWithHistory(names: readonly string[], now = 1_000_000): Map<string, number> {
  return new Map(names.map((n, i) => [n, now - i]))
}

describe('resolveToolLoadout', () => {
  it('冷启动（无任何历史）回落全量，deferred 为空 —— C8', () => {
    const all = [tool('a'), tool('b'), tool('c')]
    const out = resolveToolLoadout({ all, lastUsed: new Map(), pinned: ['tool_search'], limit: 20 })
    expect(out.loaded.map((t) => t.name)).toEqual(['a', 'b', 'c'])
    expect(out.deferred).toEqual([])
  })

  it('有历史但当前工具全无记录时也回落全量（表里只剩已删除工具）', () => {
    const all = [tool('a'), tool('b')]
    const stale = new Map([['已被删掉的工具', 999]])
    const out = resolveToolLoadout({ all, lastUsed: stale, pinned: [], limit: 1 })
    expect(out.loaded.map((t) => t.name)).toEqual(['a', 'b'])
  })

  it('历史条数少但确实有 → 照常裁（稳定用少量工具的渠道正是最好的折叠对象）', () => {
    // 「历史少」不等于「不能裁」：一个只用 12 个工具的渠道，保留 12、折掉 138 是对的。
    // 拦这类渠道是过度保守——数据够不够老由宿主按天数判，不在这里按条数判。
    const all = Array.from({ length: 30 }, (_, i) => tool(`t${i}`))
    const lastUsed = new Map([
      ['t0', 300],
      ['t1', 200],
      ['t2', 100],
    ])
    const out = resolveToolLoadout({ all, lastUsed, pinned: [], limit: 2 })
    expect(out.loaded.map((t) => t.name)).toEqual(['t0', 't1'])
    expect(out.deferred).toHaveLength(28)
  })

  it('pinned 恒在，且不占 limit 名额', () => {
    const names = ['t1', 't2', 't3', 't4']
    const all = [...names.map(tool), tool('tool_search'), tool('task_complete')]
    const out = resolveToolLoadout({
      all,
      lastUsed: toolsWithHistory(names),
      pinned: ['tool_search', 'task_complete'],
      limit: 1,
    })
    // 名额 1 → 只带最新的 t1；两个 pinned 不占名额
    expect(out.loaded.map((t) => t.name)).toEqual(['tool_search', 'task_complete', 't1'])
    expect(out.deferred.map((t) => t.name)).toEqual(['t2', 't3', 't4'])
  })

  it('N=20 边界：恰好 20 个非 pinned 时全常驻，第 21 个进 deferred', () => {
    const names = Array.from({ length: 25 }, (_, i) => `t${String(i).padStart(2, '0')}`)
    const all = names.map(tool)
    const out = resolveToolLoadout({
      all,
      lastUsed: toolsWithHistory(names),
      pinned: ['tool_search'],
      limit: 20,
    })
    expect(out.loaded).toHaveLength(20)
    expect(out.deferred).toHaveLength(5)
    // t19 是第 20 个（index 19），t20 是第一个被折叠的
    expect(out.loaded.some((t) => t.name === 't19')).toBe(true)
    expect(out.deferred.map((t) => t.name)).toEqual(['t20', 't21', 't22', 't23', 't24'])
  })

  it('按最后使用时间降序，不按次数（频率已被回放证伪）', () => {
    const all = [tool('old'), tool('recent')]
    const lastUsed = new Map([
      ['old', 100],
      ['recent', 200],
    ])
    const out = resolveToolLoadout({ all, lastUsed, pinned: [], limit: 1 })
    expect(out.loaded.map((t) => t.name)).toEqual(['recent'])
  })

  it('总名额超过候选数时全部常驻', () => {
    const all = [tool('a'), tool('b')]
    const out = resolveToolLoadout({
      all,
      lastUsed: toolsWithHistory(['a', 'b']),
      pinned: [],
      limit: 50,
    })
    expect(out.deferred).toEqual([])
  })

  it('limit=0 时只留 pinned（回滚档）', () => {
    const all = [tool('a'), tool('b'), tool('tool_search')]
    const out = resolveToolLoadout({
      all,
      lastUsed: toolsWithHistory(['a', 'b']),
      pinned: ['tool_search'],
      limit: 0,
    })
    expect(out.loaded.map((t) => t.name)).toEqual(['tool_search'])
    expect(out.deferred).toHaveLength(2)
  })
})

describe('applyToolLoadout', () => {
  const pool = [tool('tool_search'), tool('bash'), tool('file_read'), tool('rare_tool')]

  it('折叠名单把工具从加载集移出，并单独返回（供 tool_search 检索）', () => {
    const out = applyToolLoadout({
      allowedTools: [tool('bash'), tool('rare_tool')],
      deferred: [tool('rare_tool')],
      pool,
    })
    expect(out.loadedTools.map((t) => t.name)).toEqual(['bash'])
    expect(out.deferredTools.map((t) => t.name)).toEqual(['rare_tool'])
  })

  it('deferred 为 null（未裁 / fail-open）时不移出任何工具，但 ensure 仍生效', () => {
    // ensure 无条件生效：只要该 Agent 开了裁剪特性，tool_search 就恒在——
    // 这时的 deferred 为空、搜不到东西，但保持「开了就有出口」的一致性，避免
    // 后续某轮突然开始裁时模型手里没有出口。
    const out = applyToolLoadout({ allowedTools: [tool('bash')], deferred: null, pool, ensure: ['tool_search'] })
    expect(out.loadedTools.map((t) => t.name)).toEqual(['bash', 'tool_search'])
    expect(out.deferredTools).toEqual([])
  })

  it('tool_search 不在白名单里时从 pool 补回 —— 否则折叠等于删除（本机多数 Agent 白名单没有它）', () => {
    const out = applyToolLoadout({
      allowedTools: [tool('bash'), tool('rare_tool')],
      deferred: [tool('rare_tool')],
      pool,
      ensure: ['tool_search'],
    })
    expect(out.loadedTools.map((t) => t.name)).toEqual(['bash', 'tool_search'])
  })
})
