/**
 * ActivityFold 组件测试
 *
 * 覆盖「执行过程」折叠块的展开/收起交互；
 * 重点回归：展开体底部必须提供收起按钮——长工具轨迹读到底后就地收起，
 * 不必再滑回顶部点头部按钮。
 */
import { describe, it, expect } from 'vitest'
import { render, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ActivityFold } from '../../renderer/pages/ChatPage/components/ActivityFold'

function renderFold() {
  return render(
    <ActivityFold summary="💭 思考 · 读取 2 个文件" isStreaming={false}>
      <div>MARKER_FOLD_BODY</div>
    </ActivityFold>,
  )
}

describe('ActivityFold', () => {
  it('默认折叠不渲染正文，点击头部展开', () => {
    const { getByRole, container } = renderFold()
    expect(container.textContent).not.toContain('MARKER_FOLD_BODY')

    fireEvent.click(getByRole('button', { name: /执行过程/ }))
    expect(container.textContent).toContain('MARKER_FOLD_BODY')
  })

  it('展开体末尾提供底部收起按钮，点击即收起', () => {
    const { getByRole, container } = renderFold()
    fireEvent.click(getByRole('button', { name: /执行过程/ }))
    expect(container.textContent).toContain('MARKER_FOLD_BODY')

    // 可见名精确为「收起」的是底部按钮（头部按钮名含「执行过程」与摘要，不会精确相等）
    fireEvent.click(getByRole('button', { name: '收起' }))
    expect(container.textContent).not.toContain('MARKER_FOLD_BODY')
  })
})
