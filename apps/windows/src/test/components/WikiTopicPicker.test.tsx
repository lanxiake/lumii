/**
 * WikiTopicPicker：左栏分区 + 小类两级选择，回调传旧大类真名
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import {
  WikiTopicPicker,
  WIKI_TOPIC_PICKER_ACTIVE_SECTIONS,
} from '../../renderer/pages/MemoriesPage/components/WikiTopicPicker'
import type { WikiTopicTree } from '../../renderer/hooks/business/useWikiPage'

const TREE: WikiTopicTree = {
  version: 1,
  categories: [
    { name: '做事记录', subtopics: ['项目/任务资料', '会议聊天记录'] },
    { name: '学习资料', subtopics: ['调研搜集材料'] },
    { name: '计划与复盘', subtopics: ['目标规划方案'] },
    { name: '证件凭据', subtopics: ['合同协议文件', '证件扫描副本'] },
    { name: '模板参考', subtopics: ['各类文档模板'] },
    { name: '随笔创作', subtopics: ['灵感随手记录'] },
    { name: '临时存放', subtopics: ['杂项'] },
  ],
}

describe('WikiTopicPicker', () => {
  it('第一步显示四个活跃分区，不含待整理与临时存放', () => {
    render(
      <WikiTopicPicker
        open
        tree={TREE}
        sections={WIKI_TOPIC_PICKER_ACTIVE_SECTIONS}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    )

    for (const label of ['工作', '学习', '生活', '收藏']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument()
    }
    expect(screen.queryByRole('button', { name: '收件箱' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '临时存放' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '做事记录' })).not.toBeInTheDocument()
  })

  it('选「生活」后合并展示计划与复盘与证件凭据的小类', () => {
    render(
      <WikiTopicPicker
        open
        tree={TREE}
        sections={WIKI_TOPIC_PICKER_ACTIVE_SECTIONS}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '生活' }))
    expect(screen.getByRole('button', { name: '目标规划方案' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '合同协议文件' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: '项目/任务资料' })).not.toBeInTheDocument()
  })

  it('确认时回传小类真实所属的旧大类', () => {
    const onConfirm = vi.fn()
    render(
      <WikiTopicPicker
        open
        tree={TREE}
        sections={WIKI_TOPIC_PICKER_ACTIVE_SECTIONS}
        onCancel={() => undefined}
        onConfirm={onConfirm}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '生活' }))
    fireEvent.click(screen.getByRole('button', { name: '目标规划方案' }))
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))

    expect(onConfirm).toHaveBeenCalledWith('计划与复盘', '目标规划方案')
  })

  it('选「收藏」回传模板参考', () => {
    const onConfirm = vi.fn()
    render(
      <WikiTopicPicker
        open
        tree={TREE}
        sections={WIKI_TOPIC_PICKER_ACTIVE_SECTIONS}
        onCancel={() => undefined}
        onConfirm={onConfirm}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '收藏' }))
    fireEvent.click(screen.getByRole('button', { name: '各类文档模板' }))
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))

    expect(onConfirm).toHaveBeenCalledWith('模板参考', '各类文档模板')
  })

  it('已归档分区无小类，确定走 onConfirmArchive', () => {
    const onConfirmArchive = vi.fn()
    const onConfirm = vi.fn()
    render(
      <WikiTopicPicker
        open
        tree={TREE}
        onCancel={() => undefined}
        onConfirm={onConfirm}
        onConfirmArchive={onConfirmArchive}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '已归档' }))
    fireEvent.click(screen.getByRole('button', { name: '确认归档' }))
    expect(onConfirmArchive).toHaveBeenCalled()
    expect(onConfirm).not.toHaveBeenCalled()
  })

  it('未选满两级时禁用确认', () => {
    render(
      <WikiTopicPicker
        open
        tree={TREE}
        sections={WIKI_TOPIC_PICKER_ACTIVE_SECTIONS}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    )

    expect(screen.getByRole('button', { name: '确认归档' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '工作' }))
    expect(screen.getByRole('button', { name: '确认归档' })).toBeDisabled()
    fireEvent.click(screen.getByRole('button', { name: '项目/任务资料' }))
    expect(screen.getByRole('button', { name: '确认归档' })).toBeEnabled()
  })

  it('切换分区时清空已选小类，避免跨分区误提交', () => {
    render(
      <WikiTopicPicker
        open
        tree={TREE}
        sections={WIKI_TOPIC_PICKER_ACTIVE_SECTIONS}
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '工作' }))
    fireEvent.click(screen.getByRole('button', { name: '会议聊天记录' }))
    fireEvent.click(screen.getByRole('button', { name: '生活' }))

    expect(screen.getByRole('button', { name: '确认归档' })).toBeDisabled()
    expect(screen.queryByRole('button', { name: '会议聊天记录' })).not.toBeInTheDocument()
  })
})
