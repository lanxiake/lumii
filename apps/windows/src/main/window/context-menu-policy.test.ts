/**
 * 右键菜单让位策略测试
 *
 * 这里是纯函数，不碰 Electron —— 判据是「哪些情形该让位」，
 * 不是「Electron 的 params 长什么样」。
 */
import { describe, expect, it } from 'vitest'
import { shouldDeferToRenderer } from './context-menu-policy'

describe('shouldDeferToRenderer', () => {
  it('非可编辑 + 有选区 → 让位给渲染层自绘', () => {
    expect(shouldDeferToRenderer({ isEditable: false, selectionText: '一段选中文字' })).toBe(true)
  })

  it('可编辑区内一律不让位', () => {
    // 让掉的话输入框的剪切/粘贴会直接消失
    expect(shouldDeferToRenderer({ isEditable: true, selectionText: '一段选中文字' })).toBe(false)
  })

  it('可编辑但无选区也不让位', () => {
    expect(shouldDeferToRenderer({ isEditable: true, selectionText: '' })).toBe(false)
  })

  it('非可编辑但无选区 → 不让位', () => {
    expect(shouldDeferToRenderer({ isEditable: false, selectionText: '' })).toBe(false)
  })

  it('纯空白选区不让位（与渲染层的判空口径一致）', () => {
    expect(shouldDeferToRenderer({ isEditable: false, selectionText: '   \n\t ' })).toBe(false)
  })
})
