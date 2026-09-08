/**
 * 文件预览内容缩放工具测试
 */
import { describe, expect, it } from 'vitest'
import {
  buildZoomedSrcDoc,
  clampZoom,
  ZOOM_MAX,
  ZOOM_MIN,
  ZOOM_STEP,
} from './zoom-utils'

describe('clampZoom', () => {
  it('按 0.1 步进取整，消除浮点误差', () => {
    expect(clampZoom(1)).toBe(1)
    expect(clampZoom(1.26)).toBe(1.3)
    expect(clampZoom(0.99)).toBe(1)
    expect(clampZoom(1.5 + ZOOM_STEP)).toBe(1.6)
  })

  it('收敛到上下限', () => {
    expect(clampZoom(0.2)).toBe(ZOOM_MIN)
    expect(clampZoom(9)).toBe(ZOOM_MAX)
  })
})

describe('buildZoomedSrcDoc', () => {
  it('zoom=1 时原样返回，不注入样式', () => {
    expect(buildZoomedSrcDoc('<svg>', 1)).toBe('<svg>')
  })

  it('zoom≠1 时在开头注入 body zoom 样式', () => {
    expect(buildZoomedSrcDoc('<svg>', 1.5)).toBe('<style>body{zoom:1.5}</style><svg>')
    expect(buildZoomedSrcDoc('body { color: red }', 0.8)).toBe(
      '<style>body{zoom:0.8}</style>body { color: red }',
    )
  })
})
