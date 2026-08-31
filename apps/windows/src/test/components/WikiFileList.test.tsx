/**
 * WikiFileList：行内容、media 芯片筛选、操作回调
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WikiFileList } from '../../renderer/pages/MemoriesPage/components/WikiFileList'
import type { WikiSourceListItem } from '../../renderer/hooks/business/useWikiPage'

function makeItem(overrides: Partial<WikiSourceListItem> = {}): WikiSourceListItem {
  return {
    id: 's1',
    title: '会议纪要.docx',
    sourcePath: 'C:/files/会议纪要.docx',
    mediaType: 'document',
    topicCategory: '做事记录',
    topicSubtopic: '会议聊天记录',
    updatedAt: Date.now(),
    useCount: 0,
    ...overrides,
  }
}

const noop = () => undefined

describe('WikiFileList', () => {
  it('行显示文件名与相对时间，操作回调带上该行数据', () => {
    const onOpen = vi.fn()
    const onMove = vi.fn()
    const onPark = vi.fn()
    const item = makeItem()
    render(
      <WikiFileList items={[item]} emptyHint="空" onOpen={onOpen} onPreview={vi.fn()} onMove={onMove} onPark={onPark} />,
    )

    const row = screen.getByText('会议纪要.docx').closest('.wiki-file-list-item')
    expect(row).toHaveTextContent('刚刚')

    fireEvent.click(screen.getByRole('button', { name: /打开/ }))
    fireEvent.click(screen.getByRole('button', { name: /移动/ }))
    fireEvent.click(screen.getByRole('button', { name: /存到临时存放/ }))

    expect(onOpen).toHaveBeenCalledWith(item)
    expect(onMove).toHaveBeenCalledWith(item)
    expect(onPark).toHaveBeenCalledWith(item)
  })

  it('音视频芯片同时覆盖 audio 与 video', () => {
    const items = [
      makeItem({ id: 'a', title: '录音.m4a', mediaType: 'audio' }),
      makeItem({ id: 'v', title: '录屏.mp4', mediaType: 'video' }),
      makeItem({ id: 'd', title: '文档.docx', mediaType: 'document' }),
      makeItem({ id: 'i', title: '截图.png', mediaType: 'image' }),
    ]
    render(<WikiFileList items={items} emptyHint="空" onOpen={noop} onPreview={noop} onMove={noop} />)

    fireEvent.click(screen.getByRole('button', { name: '音视频' }))
    expect(screen.getByText('录音.m4a')).toBeInTheDocument()
    expect(screen.getByText('录屏.mp4')).toBeInTheDocument()
    expect(screen.queryByText('文档.docx')).not.toBeInTheDocument()
    expect(screen.queryByText('截图.png')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '图片' }))
    expect(screen.getByText('截图.png')).toBeInTheDocument()
    expect(screen.queryByText('录音.m4a')).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '全部' }))
    expect(screen.getByText('文档.docx')).toBeInTheDocument()
    expect(screen.getByText('录音.m4a')).toBeInTheDocument()
  })

  it('showTopic 打开时显示大类 / 小类，未分类显示为收件箱', () => {
    render(
      <WikiFileList
        items={[makeItem(), makeItem({ id: 'u', title: '未分类.pdf', topicCategory: null, topicSubtopic: null })]}
        emptyHint="空"
        showTopic
        onOpen={noop}
        onMove={noop}
      />,
    )

    expect(screen.getByText('工作 / 会议聊天记录')).toBeInTheDocument()
    expect(screen.getByText('收件箱')).toBeInTheDocument()
  })

  it('临时存放形态用移出并隐藏存到临时存放', () => {
    render(
      <WikiFileList
        items={[makeItem()]}
        emptyHint="空"
        moveLabel="移出"
        showParkAction={false}
        onOpen={noop}
        onMove={noop}
      />,
    )

    expect(screen.getByRole('button', { name: /移出/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /存到临时存放/ })).not.toBeInTheDocument()
  })

  it('空列表显示传入的空状态文案', () => {
    render(<WikiFileList items={[]} emptyHint="这个小类下还没有文件" onOpen={noop} onPreview={noop} onMove={noop} />)
    expect(screen.getByText('这个小类下还没有文件')).toBeInTheDocument()
  })
})

describe('WikiFileList 多选（二期）', () => {
  const a = makeItem({ id: 'a', title: '调研A.pdf' })
  const b = makeItem({ id: 'b', title: '调研B.pdf' })

  it('不传 selectable 时不渲染复选框（保持一期行为）', () => {
    render(<WikiFileList items={[a]} emptyHint="空" onOpen={noop} onPreview={noop} onMove={noop} />)
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
  })

  it('selectable 时每行一个复选框，勾选回调带行 id', () => {
    const onToggleSelect = vi.fn()
    render(
      <WikiFileList
        items={[a, b]} emptyHint="空" selectable selectedIds={new Set()}
        onToggleSelect={onToggleSelect} onOpen={noop} onPreview={noop} onMove={noop}
      />,
    )
    fireEvent.click(screen.getByLabelText('选择 调研A.pdf'))
    expect(onToggleSelect).toHaveBeenCalledWith('a')
  })

  it('已选行呈选中态，未选行不选中', () => {
    render(
      <WikiFileList
        items={[a, b]} emptyHint="空" selectable selectedIds={new Set(['a'])}
        onToggleSelect={noop} onOpen={noop} onPreview={noop} onMove={noop}
      />,
    )
    expect(screen.getByLabelText('选择 调研A.pdf')).toBeChecked()
    expect(screen.getByLabelText('选择 调研B.pdf')).not.toBeChecked()
  })

  it('全选框在全选时选中，点击走 onToggleSelectAll', () => {
    const onToggleSelectAll = vi.fn()
    render(
      <WikiFileList
        items={[a, b]} emptyHint="空" selectable selectedIds={new Set(['a', 'b'])}
        onToggleSelect={noop} onToggleSelectAll={onToggleSelectAll} onOpen={noop} onPreview={noop} onMove={noop}
      />,
    )
    const selectAll = screen.getByLabelText('全选')
    expect(selectAll).toBeChecked()
    fireEvent.click(selectAll)
    expect(onToggleSelectAll).toHaveBeenCalled()
  })

  it('列表为空时不渲染全选框', () => {
    render(
      <WikiFileList
        items={[]} emptyHint="空" selectable selectedIds={new Set()}
        onToggleSelect={noop} onOpen={noop} onPreview={noop} onMove={noop}
      />,
    )
    expect(screen.queryByLabelText('全选')).not.toBeInTheDocument()
  })
})
