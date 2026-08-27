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
      <WikiFileList items={[item]} emptyHint="空" onOpen={onOpen} onMove={onMove} onPark={onPark} />,
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
    render(<WikiFileList items={items} emptyHint="空" onOpen={noop} onMove={noop} />)

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

  it('showTopic 打开时显示大类 / 小类，待补分显示为待补分', () => {
    render(
      <WikiFileList
        items={[makeItem(), makeItem({ id: 'u', title: '未分类.pdf', topicCategory: null, topicSubtopic: null })]}
        emptyHint="空"
        showTopic
        onOpen={noop}
        onMove={noop}
      />,
    )

    expect(screen.getByText('做事记录 / 会议聊天记录')).toBeInTheDocument()
    expect(screen.getByText('待补分')).toBeInTheDocument()
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
    render(<WikiFileList items={[]} emptyHint="这个小类下还没有文件" onOpen={noop} onMove={noop} />)
    expect(screen.getByText('这个小类下还没有文件')).toBeInTheDocument()
  })
})
