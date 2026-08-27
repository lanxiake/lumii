/**
 * WikiTopicPicker：两级选择、临时存放不可选、回调传两段中文
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WikiTopicPicker } from '../../renderer/pages/MemoriesPage/components/WikiTopicPicker'
import type { WikiTopicTree } from '../../renderer/hooks/business/useWikiPage'

const TREE: WikiTopicTree = {
  version: 1,
  categories: [
    { name: '做事记录', subtopics: ['项目/任务资料', '会议聊天记录'] },
    { name: '证件凭据', subtopics: ['合同协议文件', '证件扫描副本'] },
    { name: '临时存放', subtopics: ['杂项'] },
  ],
}

describe('WikiTopicPicker', () => {
  it('选大类后才出现对应小类，确认回调收到两段中文', () => {
    const onConfirm = vi.fn()
    render(
      <WikiTopicPicker open tree={TREE} onCancel={() => undefined} onConfirm={onConfirm} />,
    )

    expect(screen.queryByRole('button', { name: '合同协议文件' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '证件凭据' }))
    expect(screen.getByRole('button', { name: '合同协议文件' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '会议聊天记录' })).not.toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: '合同协议文件' }))
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))

    expect(onConfirm).toHaveBeenCalledWith('证件凭据', '合同协议文件')
  })

  it('不列出临时存放，也没有自由输入框', () => {
    render(
      <WikiTopicPicker open tree={TREE} onCancel={() => undefined} onConfirm={() => undefined} />,
    )

    expect(screen.queryByRole('button', { name: '临时存放' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
  })

  it('未选满两级时禁用确认', () => {
    render(
      <WikiTopicPicker open tree={TREE} onCancel={() => undefined} onConfirm={() => undefined} />,
    )

    expect(screen.getByRole('button', { name: '确认归档' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '做事记录' }))
    expect(screen.getByRole('button', { name: '确认归档' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '项目/任务资料' }))
    expect(screen.getByRole('button', { name: '确认归档' })).toBeEnabled()
  })

  it('切换大类时清空已选小类，避免跨大类误提交', () => {
    const onConfirm = vi.fn()
    render(
      <WikiTopicPicker open tree={TREE} onCancel={() => undefined} onConfirm={onConfirm} />,
    )

    fireEvent.click(screen.getByRole('button', { name: '做事记录' }))
    fireEvent.click(screen.getByRole('button', { name: '会议聊天记录' }))
    fireEvent.click(screen.getByRole('button', { name: '证件凭据' }))

    expect(screen.getByRole('button', { name: '确认归档' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '会议聊天记录' })).not.toBeInTheDocument()
  })
})
