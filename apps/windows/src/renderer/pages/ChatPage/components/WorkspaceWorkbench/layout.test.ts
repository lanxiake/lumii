import { describe, expect, it } from 'vitest'
import {
  CHAT_MIN_REMAIN,
  WORKBENCH_WIDTH_MIN,
  hashWorkspaceDir,
  isCompactWidth,
  railWidthFor,
  isInspectorInline,
  INSPECTOR_WIDTH,
  resolveWidth,
} from './layout'

describe('resolveWidth', () => {
  it('三档：半 480 / 宽 860 / 满 = 可用宽度', () => {
    expect(resolveWidth('half', undefined, 1200)).toBe(480)
    expect(resolveWidth('wide', undefined, 1200)).toBe(860)
    expect(resolveWidth('full', undefined, 1200)).toBe(1200)
  })

  it('可用宽度不够时夹到 min，不会挤出对话区下限', () => {
    expect(resolveWidth('wide', undefined, 700)).toBe(700)
    expect(resolveWidth('full', undefined, 300)).toBe(300)
    expect(resolveWidth('half', undefined, 100)).toBe(WORKBENCH_WIDTH_MIN)
    expect(resolveWidth('custom', 100, 1200)).toBe(WORKBENCH_WIDTH_MIN)
    expect(resolveWidth('custom', 9999, 1000)).toBe(1000)
  })

  it('custom 用拖拽宽度，缺省回落半档', () => {
    expect(resolveWidth('custom', 620, 1200)).toBe(620)
    expect(resolveWidth('custom', undefined, 1200)).toBe(480)
  })
})

describe('断点与 rail 宽度', () => {
  it('<560 单栏，rail 220；否则 260', () => {
    expect(isCompactWidth(480)).toBe(true)
    expect(isCompactWidth(560)).toBe(false)
    expect(railWidthFor(480)).toBe(220)
    expect(railWidthFor(860)).toBe(260)
  })

  it('inspector 只在 ≥900 时并排（更窄退浮层）', () => {
    expect(isInspectorInline(899)).toBe(false)
    expect(isInspectorInline(900)).toBe(true)
    expect(INSPECTOR_WIDTH).toBe(240)
  })

  it('对话区残留常量保持 280', () => {
    expect(CHAT_MIN_REMAIN).toBe(280)
  })
})

describe('hashWorkspaceDir', () => {
  it('不同工作区不同 key；大小写与分隔符归一', () => {
    expect(hashWorkspaceDir('E:/ws')).not.toBe(hashWorkspaceDir('E:/other'))
    expect(hashWorkspaceDir('E:\\WS')).toBe(hashWorkspaceDir('e:/ws'))
  })
})
