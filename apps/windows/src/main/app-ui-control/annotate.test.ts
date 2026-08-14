import { describe, expect, it } from 'vitest'
import type { AppUiRef } from './types'
import {
  BADGE_HEIGHT,
  BADGE_MIN_WIDTH,
  buildAnnotateOverlays,
  annotateSnapshot,
} from './annotate'

const sampleRefs: AppUiRef[] = [
  { ref: 'e1', role: 'button', name: '发送', x: 10, y: 20, w: 80, h: 32 },
  { ref: 'e12', role: 'link', name: '设置', x: 200, y: 50, w: 60, h: 24 },
]

describe('buildAnnotateOverlays', () => {
  it('为每个 ref 返回左上角坐标与提取后的 label', () => {
    const overlays = buildAnnotateOverlays(sampleRefs)

    expect(overlays).toHaveLength(2)
    expect(overlays[0]).toMatchObject({
      ref: 'e1',
      label: '1',
      left: 10,
      top: 20,
      height: BADGE_HEIGHT,
    })
    expect(overlays[0]!.width).toBeGreaterThanOrEqual(BADGE_MIN_WIDTH)

    expect(overlays[1]).toMatchObject({
      ref: 'e12',
      label: '12',
      left: 200,
      top: 50,
      height: BADGE_HEIGHT,
    })
    expect(overlays[1]!.width).toBeGreaterThan(overlays[0]!.width)
  })

  it('非 eN 格式 ref 保留原 label', () => {
    const overlays = buildAnnotateOverlays([
      { ref: 'custom', role: 'button', name: 'x', x: 0, y: 0, w: 1, h: 1 },
    ])
    expect(overlays[0]?.label).toBe('custom')
  })

  it('空 refs 返回空数组', () => {
    expect(buildAnnotateOverlays([])).toEqual([])
  })
})

describe('annotateSnapshot', () => {
  it('无 refs 时原样返回 buffer', async () => {
    const input = Buffer.from('fake-jpeg')
    const output = await annotateSnapshot(input, [])
    expect(output).toBe(input)
  })
})
