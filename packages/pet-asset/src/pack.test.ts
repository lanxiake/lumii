import { describe, it, expect } from 'vitest'
import { buildAtlasIndex, planAtlasLayout } from './pack.js'
import { parseAtlasIndex, atlasFrameNames } from '@mtbot/pet-core'

const frames = [
  { name: 'idle_00', width: 48, height: 56 },
  { name: 'idle_01', width: 48, height: 56 },
  { name: 'eye_open', width: 48, height: 56 },
]

describe('planAtlasLayout', () => {
  it('统一格子尺寸，按行优先排布', () => {
    const l = planAtlasLayout(frames)
    expect(l.cols).toBe(3)
    expect(l.rows).toBe(1)
    expect(l.entries.map((e) => [e.name, e.x, e.y])).toEqual([
      ['idle_00', 0, 0],
      ['idle_01', 48, 0],
      ['eye_open', 96, 0],
    ])
  })

  it('超过每行上限时换行', () => {
    const many = Array.from({ length: 5 }, (_, i) => ({ name: `f${i}`, width: 10, height: 10 }))
    const l = planAtlasLayout(many, { maxCols: 2 })
    expect(l.cols).toBe(2)
    expect(l.rows).toBe(3)
    expect(l.entries.map((e) => [e.x, e.y])).toEqual([
      [0, 0],
      [10, 0],
      [0, 10],
      [10, 10],
      [0, 20],
    ])
  })

  it('尺寸不一时格子取最大值', () => {
    const l = planAtlasLayout([
      { name: 'a', width: 10, height: 10 },
      { name: 'b', width: 30, height: 20 },
    ])
    expect(l.width).toBe(60)
    expect(l.height).toBe(20)
    // 小图仍是自己的尺寸，只是占了一个大格子
    expect(l.entries[0]).toMatchObject({ w: 10, h: 10 })
  })

  it('padding 加在格间，不加在图集末尾', () => {
    const l = planAtlasLayout(
      [
        { name: 'a', width: 10, height: 10 },
        { name: 'b', width: 10, height: 10 },
      ],
      { padding: 2 },
    )
    // 两格 10 + 中间 2 = 22，末尾那 2 不该多出来
    expect(l.width).toBe(22)
    expect(l.entries[1].x).toBe(12)
  })

  it('空输入抛错', () => {
    expect(() => planAtlasLayout([])).toThrow()
  })
})

describe('buildAtlasIndex — 必须能被运行时解析器读回', () => {
  it('往返：解析出的条目名与矩形与输入一致', () => {
    const layout = planAtlasLayout(frames)
    const json = buildAtlasIndex(layout, 'atlas.png')

    const parsed = parseAtlasIndex(json)
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return

    expect(parsed.atlas.image).toBe('atlas.png')
    expect(parsed.atlas.size).toEqual({ w: layout.width, h: layout.height })
    expect(atlasFrameNames(parsed.atlas).sort()).toEqual(['eye_open', 'idle_00', 'idle_01'])

    const idle1 = parsed.atlas.frames.find((f) => f.name === 'idle_01')!
    expect(idle1).toMatchObject({ x: 48, y: 0, w: 48, h: 56 })
  })

  it('矩形不越出图集边界', () => {
    const layout = planAtlasLayout(frames, { maxCols: 2, padding: 1 })
    const json = buildAtlasIndex(layout, 'atlas.png')
    for (const e of Object.values(json.frames)) {
      expect(e.frame.x + e.frame.w).toBeLessThanOrEqual(layout.width)
      expect(e.frame.y + e.frame.h).toBeLessThanOrEqual(layout.height)
    }
  })

  it('条目名与输入一一对应，不重不漏', () => {
    const layout = planAtlasLayout(frames)
    const json = buildAtlasIndex(layout, 'atlas.png')
    expect(Object.keys(json.frames).sort()).toEqual(frames.map((f) => f.name).sort())
  })
})
