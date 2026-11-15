/**
 * rank 单测 —— 纯函数，无 DB 依赖，vitest 可跑。
 *
 * `now` 全部显式传入固定值（不读 Date.now()），故断言完全确定 ——
 * 与 `memory/scorer.ts` 的 `scoreMemory` 同一约定。
 */

import { describe, expect, it } from 'vitest'

import {
  BM25_SATURATION_K,
  DEFAULT_WEIGHTS,
  USAGE_BONUS_CAP,
  normalizeBm25,
  normalizeBm25One,
  pathDepth,
  rankCandidates,
  rootPriority,
  scoreCandidate,
  type RankCandidate,
} from './rank.js'

/** 固定的"现在"，供所有用例使用 */
const NOW = Date.parse('2026-11-15T12:00:00Z')
const DAY = 86_400_000

function cand(over: Partial<RankCandidate> & { id: number; name: string; path: string }): RankCandidate {
  return {
    isStart: false,
    root: 'c:\\proj',
    bm25: -1,
    usageCount: 0,
    usageLastUsed: 0,
    rootPriority: 0.5,
    literalMatch: true,
    ...over,
  }
}

describe('normalizeBm25', () => {
  it('饱和变换：单调递增，且保留相对差异（不拉满量程）', () => {
    const a = normalizeBm25One(-10)
    const b = normalizeBm25One(-5)
    const c = normalizeBm25One(-1)
    expect(a).toBeGreaterThan(b)
    expect(b).toBeGreaterThan(c)
    // 关键：不是 min-max，故两两差距远小于 1
    expect(a - b).toBeLessThan(0.2)
  })

  it('拐点处得 0.5', () => {
    expect(normalizeBm25One(-BM25_SATURATION_K)).toBeCloseTo(0.5, 10)
  })

  it('0 给 0', () => {
    expect(normalizeBm25One(0)).toBe(0)
  })

  it('null（LIKE 降级）给 0', () => {
    expect(normalizeBm25One(null)).toBe(0)
  })

  it('结果恒在 [0,1)', () => {
    for (const v of [-0.1, -1, -10, -1000, 0]) {
      const r = normalizeBm25One(v)
      expect(r).toBeGreaterThanOrEqual(0)
      expect(r).toBeLessThan(1)
    }
  })

  it('批量版本与逐条一致', () => {
    const vals = [-10, null, -5, 0]
    expect(normalizeBm25(vals)).toEqual(vals.map(normalizeBm25One))
  })

  it('空数组不炸', () => {
    expect(normalizeBm25([])).toEqual([])
  })
})

describe('rootPriority', () => {
  it('开始菜单最高', () => {
    expect(rootPriority('c:\\programdata\\microsoft\\windows\\start menu\\programs\\x.lnk')).toBe(1)
  })

  it('桌面次之', () => {
    expect(rootPriority('c:\\users\\a\\desktop\\x.txt')).toBe(0.9)
  })

  it('大小写不敏感', () => {
    expect(rootPriority('C:\\Users\\A\\Desktop\\x.txt')).toBe(0.9)
  })

  it('普通路径用默认值', () => {
    expect(rootPriority('e:\\my-project\\src\\a.ts')).toBe(0.5)
  })
})

describe('pathDepth', () => {
  it('不含盘符段', () => {
    expect(pathDepth('c:\\a')).toBe(1)
    expect(pathDepth('c:\\a\\b')).toBe(2)
  })

  it('根目录深度为 0（不与 c:\\a 撞值）', () => {
    expect(pathDepth('c:\\')).toBe(0)
  })

  it('大小写盘符都识别', () => {
    expect(pathDepth('D:\\x\\y')).toBe(2)
  })
})

describe('scoreCandidate', () => {
  it('bm25 权重生效：更相关分更高', () => {
    const c = cand({ id: 1, name: 'a.txt', path: 'c:\\a.txt' })
    const low = scoreCandidate(c, '设计', 0.2, NOW)
    const high = scoreCandidate(c, '设计', 0.9, NOW)
    expect(high).toBeGreaterThan(low)
  })

  it('文件名前缀命中 > 仅包含 > 都不命中', () => {
    const prefix = cand({ id: 1, name: '设计文档.docx', path: 'c:\\设计文档.docx' })
    const contains = cand({ id: 2, name: '项目设计文档.docx', path: 'c:\\项目设计文档.docx' })
    const none = cand({ id: 3, name: 'unrelated.txt', path: 'c:\\unrelated.txt' })
    const sp = scoreCandidate(prefix, '设计', 0.5, NOW)
    const sc = scoreCandidate(contains, '设计', 0.5, NOW)
    const sn = scoreCandidate(none, '设计', 0.5, NOW)
    expect(sp).toBeGreaterThan(sc)
    expect(sc).toBeGreaterThan(sn)
  })

  it('大小写不敏感地判定前缀', () => {
    const c = cand({ id: 1, name: 'README.md', path: 'c:\\README.md' })
    const withPrefix = scoreCandidate(c, 'readme', 0.5, NOW)
    const withoutPrefix = scoreCandidate(c, 'xxxxxx', 0.5, NOW)
    expect(withPrefix).toBeGreaterThan(withoutPrefix)
  })

  it('使用频次：随次数增长，且按参考次数归一后封顶', () => {
    const p = { name: 'a.txt', path: 'c:\\a.txt' }
    const at = (count: number): number => scoreCandidate(cand({ id: 1, ...p, usageCount: count }), 'q', 0, NOW)
    expect(at(10)).toBeGreaterThan(at(1))
    expect(at(100)).toBeGreaterThan(at(10))
    // 参考次数（20）之后不再增长
    expect(at(20)).toBeCloseTo(at(1000), 10)
    expect(at(20) - at(0)).toBeCloseTo(USAGE_BONUS_CAP, 10)
  })

  it('最近使用：刚用过有加成，超过半衰期归零', () => {
    const p = { name: 'a.txt', path: 'c:\\a.txt' }
    const fresh = scoreCandidate(cand({ id: 1, ...p, usageLastUsed: NOW - DAY }), 'q', 0, NOW)
    const stale = scoreCandidate(cand({ id: 2, ...p, usageLastUsed: NOW - 60 * DAY }), 'q', 0, NOW)
    const never = scoreCandidate(cand({ id: 3, ...p, usageLastUsed: 0 }), 'q', 0, NOW)
    expect(fresh).toBeGreaterThan(stale)
    expect(stale).toBeCloseTo(never, 10)
  })

  it('根优先级：开始菜单 > 普通目录', () => {
    const menu = scoreCandidate(
      cand({ id: 1, name: 'a.lnk', path: 'c:\\x\\start menu\\a.lnk', isStart: true, rootPriority: 1 }),
      'q',
      0,
      NOW,
    )
    const plain = scoreCandidate(cand({ id: 2, name: 'a.lnk', path: 'c:\\x\\a.lnk', rootPriority: 0.5 }), 'q', 0, NOW)
    expect(menu).toBeGreaterThan(plain)
  })

  it('深度惩罚：只惩罚超过 3 层以后的部分', () => {
    const shallow = scoreCandidate(cand({ id: 1, name: 'a.txt', path: 'c:\\a\\b\\c.txt' }), 'q', 0, NOW)
    const deep = scoreCandidate(cand({ id: 2, name: 'a.txt', path: 'c:\\a\\b\\c\\d\\e\\f\\a.txt' }), 'q', 0, NOW)
    expect(deep).toBeLessThan(shallow)
    // 3 层以内不罚
    const d2 = scoreCandidate(cand({ id: 3, name: 'a.txt', path: 'c:\\a\\b.txt' }), 'q', 0, NOW)
    const d3 = scoreCandidate(cand({ id: 4, name: 'a.txt', path: 'c:\\a\\b\\c.txt' }), 'q', 0, NOW)
    expect(d2).toBeCloseTo(d3, 10)
  })

  it('空查询不加前缀/包含分（避免空串 startsWith 恒真把所有条目都加成）', () => {
    const c = cand({ id: 1, name: 'a.txt', path: 'c:\\a.txt' })
    const withEmpty = scoreCandidate(c, '', 0.5, NOW)
    const noMatch = scoreCandidate(c, 'zzzz', 0.5, NOW)
    expect(withEmpty).toBe(noMatch)
  })

  it('查询词与文件名完全无关时不加 name 分', () => {
    const c = cand({ id: 1, name: 'a.txt', path: 'c:\\a.txt' })
    const s = scoreCandidate(c, 'zzzz', 0.5, NOW)
    expect(s).toBeCloseTo(DEFAULT_WEIGHTS.bm25 * 0.5 + DEFAULT_WEIGHTS.root * 0.5, 10)
  })
})

describe('rankCandidates', () => {
  it('相关度高的排前面', () => {
    const items = [
      cand({ id: 1, name: 'zzz', path: 'c:\\zzz', bm25: -0.5 }),
      cand({ id: 2, name: '设计文档', path: 'c:\\设计文档', bm25: -10 }),
    ]
    expect(rankCandidates(items, '设计', NOW).map((c) => c.id)).toEqual([2, 1])
  })

  it('使用历史能让"没那么相关"的排到前面（越用越准）', () => {
    const items = [
      cand({ id: 1, name: 'aaa设计', path: 'c:\\aaa设计', bm25: -10, usageCount: 0 }),
      cand({ id: 2, name: 'bbb设计', path: 'c:\\bbb设计', bm25: -5, usageCount: 50, usageLastUsed: NOW - DAY }),
    ]
    expect(rankCandidates(items, '设计', NOW)[0].id).toBe(2)
  })

  it('无使用历史时不会因"从未用过"而被压到后面', () => {
    const items = [
      cand({ id: 1, name: '设计文档', path: 'c:\\设计文档', bm25: -10 }),
      cand({ id: 2, name: '其他', path: 'c:\\其他', bm25: -1 }),
    ]
    expect(rankCandidates(items, '设计', NOW)[0].id).toBe(1)
  })

  it('同分时 Start Menu 优先', () => {
    const items = [
      cand({ id: 1, name: '相同', path: 'c:\\a\\相同', bm25: -1 }),
      cand({ id: 2, name: '相同', path: 'c:\\b\\相同', bm25: -1, isStart: true }),
    ]
    expect(rankCandidates(items, '相同', NOW)[0].id).toBe(2)
  })

  it('同分且同 isStart 时短路径优先', () => {
    const items = [
      cand({ id: 1, name: 'x', path: 'c:\\a\\b\\c\\d\\x', bm25: -1 }),
      cand({ id: 2, name: 'x', path: 'c:\\x', bm25: -1 }),
    ]
    expect(rankCandidates(items, 'x', NOW)[0].id).toBe(2)
  })

  it('全同分时输出确定（可复现，不依赖输入顺序）', () => {
    const mk = (): RankCandidate[] => [
      cand({ id: 1, name: 'x', path: 'c:\\b\\x', bm25: -1 }),
      cand({ id: 2, name: 'x', path: 'c:\\a\\x', bm25: -1 }),
    ]
    const a = rankCandidates(mk(), 'x', NOW).map((c) => c.id)
    const b = rankCandidates(mk().reverse(), 'x', NOW).map((c) => c.id)
    expect(a).toEqual(b)
  })

  it('空候选返回空', () => {
    expect(rankCandidates([], 'x', NOW)).toEqual([])
  })

  // ── 拼音前缀召回的副作用压制（2026-11-15 实测发现） ──
  it('字面命中硬性压过纯拼音命中，哪怕后者分数更高', () => {
    // 真实场景：查「文档」时，`我的设计稿`（首字母 wdsjg）以 `wd` 开头被拼音前缀召回，
    // 但名字里根本没有"文档"；`项目设计文档` 才是真命中。
    const items = [
      cand({
        id: 1,
        name: '我的设计稿.psd',
        path: 'c:\\我的设计稿.psd',
        bm25: -50, // 故意给更强的 bm25
        usageCount: 99, // 甚至用过很多次
        literalMatch: false,
      }),
      cand({
        id: 2,
        name: '项目设计文档.docx',
        path: 'c:\\项目设计文档.docx',
        bm25: -1,
        literalMatch: true,
      }),
    ]
    expect(rankCandidates(items, '文档', NOW)[0].id).toBe(2)
  })

  it('两者都是拼音命中时，分层不生效，正常比分数', () => {
    const items = [
      cand({ id: 1, name: '豆包.exe', path: 'c:\\豆包.exe', bm25: -5, literalMatch: false }),
      cand({ id: 2, name: '豆制品.txt', path: 'c:\\豆制品.txt', bm25: -1, literalMatch: false }),
    ]
    // 查 dou：两者都只靠拼音命中，bm25 更优的排前
    expect(rankCandidates(items, 'dou', NOW)[0].id).toBe(1)
  })

  it('不修改传入数组', () => {
    const items = [
      cand({ id: 1, name: 'b', path: 'c:\\b', bm25: -1 }),
      cand({ id: 2, name: 'a', path: 'c:\\a', bm25: -10 }),
    ]
    const before = items.map((c) => c.id)
    rankCandidates(items, 'a', NOW)
    expect(items.map((c) => c.id)).toEqual(before)
  })
})
