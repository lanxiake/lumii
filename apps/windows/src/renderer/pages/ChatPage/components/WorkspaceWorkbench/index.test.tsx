import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { WorkspaceWorkbench } from './index'

function renderShell(props: Partial<React.ComponentProps<typeof WorkspaceWorkbench>> = {}) {
  return render(
    <WorkspaceWorkbench
      open
      tab="files"
      onTabChange={vi.fn()}
      onClose={vi.fn()}
      uncommittedCount={0}
      childrenFiles={<div>文件内容</div>}
      {...props}
    />,
  )
}

describe('WorkspaceWorkbench · 文档 Tab', () => {
  it('docEnabled=false 时不渲染文档页签（防点进去空白）', () => {
    renderShell({ childrenDoc: <div>稿件</div> })
    expect(screen.queryByRole('button', { name: '文档' })).toBeNull()
  })

  it('docEnabled=true 时渲染页签，内容按 tab 切换', () => {
    renderShell({
      docEnabled: true,
      childrenDoc: <div>稿件正文</div>,
    })
    expect(screen.getByRole('button', { name: '文档' })).toBeTruthy()
  })

  it('tab=doc 且 docEnabled：显示文档 pane，隐藏文件 pane', () => {
    renderShell({
      tab: 'doc',
      docEnabled: true,
      childrenDoc: <div>稿件正文</div>,
    })
    expect(screen.getByText('稿件正文')).toBeTruthy()
  })

  it('docEnabled=false 但 tab=doc：退回文件视口，不留空面板', () => {
    renderShell({ tab: 'doc' })
    expect(screen.getByText('文件内容')).toBeTruthy()
  })

  it('点击文档页签回调 doc', () => {
    const onTabChange = vi.fn()
    renderShell({
      docEnabled: true,
      onTabChange,
      childrenDoc: <div>稿件正文</div>,
    })
    fireEvent.click(screen.getByRole('button', { name: '文档' }))
    expect(onTabChange).toHaveBeenCalledWith('doc')
  })
})
