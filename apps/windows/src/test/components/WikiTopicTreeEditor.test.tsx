/**
 * 主题树编辑器：逐条 mutate、删除去向、不列临时存放
 * 计划：docs/plans/记忆重构/2026-08-27-wiki-topic-hierarchy-p2-implementation.md Task 3
 */

import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WikiTopicTreeEditor } from '../../renderer/pages/MemoriesPage/components/WikiTopicTreeEditor'
import { topicCountKey } from '../../renderer/pages/MemoriesPage/components/WikiLeftNav'
import type { WikiTopicTree } from '../../renderer/hooks/business/useWikiPage'

const TREE: WikiTopicTree = {
  version: 1,
  categories: [
    { name: '做事记录', subtopics: ['项目/任务资料', '会议聊天记录', '汇报总结文稿'] },
    { name: '学习资料', subtopics: ['课堂&课程笔记', '读书摘抄整理'] },
  ],
}

/** 行内输入：改值后回车提交 */
function typeAndEnter(input: HTMLElement, value: string): void {
  fireEvent.change(input, { target: { value } })
  fireEvent.keyDown(input, { key: 'Enter' })
}

function baseProps() {
  return {
    open: true,
    tree: TREE,
    topicCounts: {} as Record<string, number>,
    onMutate: vi.fn().mockResolvedValue({ ok: true, tree: TREE, movedCount: 0 }),
    onClose: vi.fn(),
  }
}

describe('WikiTopicTreeEditor', () => {
  it('渲染大类与选中大类的小类，不列出临时存放', () => {
    render(<WikiTopicTreeEditor {...baseProps()} />)
    expect(screen.getByText('做事记录')).toBeInTheDocument()
    expect(screen.getByText('项目/任务资料')).toBeInTheDocument()
    expect(screen.queryByText('临时存放')).not.toBeInTheDocument()
  })

  it('切换大类后右列显示该大类的小类', () => {
    render(<WikiTopicTreeEditor {...baseProps()} />)
    const buttons = screen.getAllByRole('button')
    const learning = buttons.find((btn) => btn.textContent?.includes('学习资料'))!
    fireEvent.click(learning)
    expect(screen.getByText('课堂&课程笔记')).toBeInTheDocument()
    expect(screen.queryByText('会议聊天记录')).not.toBeInTheDocument()
  })

  it('添加小类后立刻发出 addSubtopic mutation', async () => {
    const props = baseProps()
    render(<WikiTopicTreeEditor {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /添加小类/ }))
    typeAndEnter(screen.getByLabelText('新小类名称'), '客户往来函件')
    expect(props.onMutate).toHaveBeenCalledWith({
      op: 'addSubtopic',
      category: '做事记录',
      name: '客户往来函件',
    })
  })

  it('添加大类后发出 addCategory mutation', async () => {
    const props = baseProps()
    render(<WikiTopicTreeEditor {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /添加大类/ }))
    typeAndEnter(screen.getByLabelText('新大类名称'), '外部协作')
    expect(props.onMutate).toHaveBeenCalledWith({ op: 'addCategory', name: '外部协作' })
  })

  it('行内重命名小类，Esc 取消不提交', async () => {
    const props = baseProps()
    render(<WikiTopicTreeEditor {...props} />)
    fireEvent.click(screen.getByLabelText('重命名小类 会议聊天记录'))
    const input = screen.getByLabelText('小类名称')
    fireEvent.change(input, { target: { value: '会议纪要' } })
    fireEvent.keyDown(input, { key: 'Escape' })
    expect(props.onMutate).not.toHaveBeenCalled()

    fireEvent.click(screen.getByLabelText('重命名小类 会议聊天记录'))
    typeAndEnter(screen.getByLabelText('小类名称'), '会议纪要')
    expect(props.onMutate).toHaveBeenCalledWith({
      op: 'renameSubtopic',
      category: '做事记录',
      from: '会议聊天记录',
      to: '会议纪要',
    })
  })

  it('无文件的小类可直接删除，不弹去向框', async () => {
    const props = baseProps()
    render(<WikiTopicTreeEditor {...props} />)
    fireEvent.click(screen.getByLabelText('删除小类 会议聊天记录'))
    expect(props.onMutate).toHaveBeenCalledWith({
      op: 'deleteSubtopic',
      category: '做事记录',
      name: '会议聊天记录',
    })
  })

  it('删除有文件的小类先弹去向框，取消则不发 mutation', async () => {
    const props = baseProps()
    const topicCounts = { [topicCountKey('做事记录', '会议聊天记录')]: 3 }
    render(<WikiTopicTreeEditor {...props} topicCounts={topicCounts} />)
    fireEvent.click(screen.getByLabelText('删除小类 会议聊天记录'))
    expect(screen.getByText(/3 个文件/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(props.onMutate).not.toHaveBeenCalled()
  })

  it('选择移到临时存放后带 disposition 提交', async () => {
    const props = baseProps()
    const topicCounts = { [topicCountKey('做事记录', '会议聊天记录')]: 3 }
    render(<WikiTopicTreeEditor {...props} topicCounts={topicCounts} />)
    fireEvent.click(screen.getByLabelText('删除小类 会议聊天记录'))
    fireEvent.click(screen.getByRole('radio', { name: /移到临时存放/ }))
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    expect(props.onMutate).toHaveBeenCalledWith({
      op: 'deleteSubtopic',
      category: '做事记录',
      name: '会议聊天记录',
      disposition: { type: 'parking' },
    })
  })

  it('选择移到另一小类时带 move disposition，且不列被删节点自身', async () => {
    const props = baseProps()
    const topicCounts = { [topicCountKey('做事记录', '会议聊天记录')]: 2 }
    render(<WikiTopicTreeEditor {...props} topicCounts={topicCounts} />)
    fireEvent.click(screen.getByLabelText('删除小类 会议聊天记录'))
    fireEvent.click(screen.getByRole('radio', { name: /移到另一小类/ }))

    const select = screen.getByLabelText('选择去向小类')
    expect(select).not.toHaveTextContent('会议聊天记录')
    fireEvent.change(select, { target: { value: JSON.stringify(['做事记录', '汇报总结文稿']) } })
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    expect(props.onMutate).toHaveBeenCalledWith({
      op: 'deleteSubtopic',
      category: '做事记录',
      name: '会议聊天记录',
      disposition: { type: 'move', category: '做事记录', subtopic: '汇报总结文稿' },
    })
  })

  it('mutate 失败时显示后端中文错误', async () => {
    const props = baseProps()
    props.onMutate = vi.fn().mockResolvedValue({ ok: false, error: '大类「学习资料」已存在' })
    render(<WikiTopicTreeEditor {...props} />)
    fireEvent.click(screen.getByRole('button', { name: /添加大类/ }))
    typeAndEnter(screen.getByLabelText('新大类名称'), '学习资料')
    expect(await screen.findByText('大类「学习资料」已存在')).toBeInTheDocument()
  })

  it('open 为 false 时不渲染', () => {
    render(<WikiTopicTreeEditor {...baseProps()} open={false} />)
    expect(screen.queryByText('做事记录')).not.toBeInTheDocument()
  })
})
