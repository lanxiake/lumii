/**
 * 字幕导入解析单测
 */
import { describe, expect, it } from 'vitest'
import {
  computeContainedVideoBox,
  computePreviewFontPx,
  findActiveCue,
  parseImportLines,
} from './RecordingSubtitleEditor'

describe('parseImportLines', () => {
  it('解析秒|文本行', () => {
    expect(parseImportLines('0|开场\n1.5|下一句\nbad\n')).toEqual([
      { startMs: 0, text: '开场' },
      { startMs: 1500, text: '下一句' },
    ])
  })
})

describe('findActiveCue', () => {
  it('按当前播放时间返回需要叠加预览的字幕', () => {
    const cues = [
      { id: 'a', startMs: 0, endMs: 1000, text: '开场' },
      { id: 'b', startMs: 1500, endMs: 2500, text: '第二句' },
    ]

    expect(findActiveCue(cues, 1800)?.text).toBe('第二句')
    expect(findActiveCue(cues, 1200)).toBeUndefined()
  })
})

describe('computePreviewFontPx', () => {
  it('按 libass 的 PlayResY=288 基准换算，预览与成片一致', () => {
    // 288 高的播放器上，字号即为像素值
    expect(computePreviewFontPx(28, 288)).toBe(28)
    // 播放器高度翻倍，视觉字号同步翻倍
    expect(computePreviewFontPx(28, 576)).toBe(56)
  })

  it('播放器尚未布局（高度为 0）时回退到字号本身，避免字幕消失', () => {
    expect(computePreviewFontPx(28, 0)).toBe(28)
  })
})

describe('computeContainedVideoBox', () => {
  it('宽屏视频放进高容器时，上下留黑边', () => {
    // 16:9 视频放进 400x400 容器：实际画面 400x225，垂直居中
    expect(computeContainedVideoBox(400, 400, 1920, 1080)).toEqual({
      width: 400,
      height: 225,
      offsetX: 0,
      offsetY: 87.5,
    })
  })

  it('元素或视频尺寸未知时返回元素尺寸本身', () => {
    expect(computeContainedVideoBox(400, 300, 0, 0)).toEqual({
      width: 400,
      height: 300,
      offsetX: 0,
      offsetY: 0,
    })
  })
})
