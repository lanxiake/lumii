/**
 * 字幕样式 → ASS force_style 转换单测
 */
import { describe, expect, it } from 'vitest'
import { SCREEN_RECORD_SUBTITLE_STYLE_DEFAULTS } from '../../shared/screen-record'
import { buildSubtitleForceStyle, hexToAssColor, normalizeSubtitleStyle } from './subtitle-style'

describe('hexToAssColor', () => {
  it('#RRGGBB 转为 ASS 的 &H00BBGGRR', () => {
    expect(hexToAssColor('#FFFFFF')).toBe('&H00FFFFFF')
    expect(hexToAssColor('#000000')).toBe('&H00000000')
    // 红 #FF0000 在 ASS 里是 BGR 排列
    expect(hexToAssColor('#FF0000')).toBe('&H000000FF')
    expect(hexToAssColor('#FFCC00')).toBe('&H0000CCFF')
  })

  it('非法值回退为白色', () => {
    expect(hexToAssColor('not-a-color')).toBe('&H00FFFFFF')
  })
})

describe('normalizeSubtitleStyle', () => {
  it('缺省时补全默认值', () => {
    expect(normalizeSubtitleStyle(undefined)).toEqual(SCREEN_RECORD_SUBTITLE_STYLE_DEFAULTS)
  })

  it('字号被夹到合法区间', () => {
    expect(normalizeSubtitleStyle({ fontSize: 2 }).fontSize).toBe(10)
    expect(normalizeSubtitleStyle({ fontSize: 999 }).fontSize).toBe(120)
  })
})

describe('buildSubtitleForceStyle', () => {
  it('包含字号与颜色，便于 libass 覆盖 SRT 默认样式', () => {
    const style = buildSubtitleForceStyle({
      fontSize: 40,
      primaryColor: '#FFCC00',
      outline: 3,
    })

    expect(style).toContain('FontName=Microsoft YaHei')
    expect(style).toContain('FontSize=40')
    expect(style).toContain('PrimaryColour=&H0000CCFF')
    expect(style).toContain('OutlineColour=&H00000000')
    expect(style).toContain('Outline=3')
    // 逗号分隔且不含单引号，避免破坏 -vf 参数
    expect(style).not.toContain("'")
  })
})
