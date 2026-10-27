/**
 * 版本对照 / 只读预览：diff 行、不可取原因、CRLF 行尾、关闭回调。
 */
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import {
  VersionDiffView,
  VersionTextView,
} from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/VersionViews'

describe('VersionDiffView', () => {
  it('展示 ± 统计与 hunk；CRLF 行尾不显示', () => {
    const onClose = vi.fn()
    render(
      <VersionDiffView
        path="outputs/x/doc.md"
        fromLabel="Agent 10:00"
        toLabel="本地 10:05"
        result={{
          ok: true,
          kind: 'text',
          insertions: 1,
          deletions: 1,
          hunks: [
            {
              oldStart: 1,
              oldLines: 1,
              newStart: 1,
              newLines: 1,
              lines: ['-旧\r', '+新\r'],
            },
          ],
        }}
        onClose={onClose}
      />,
    )
    expect(screen.getByText('+1')).toBeInTheDocument()
    expect(screen.getByText('−1')).toBeInTheDocument()
    expect(screen.getByText('-旧')).toBeInTheDocument()
    expect(screen.getByText('+新')).toBeInTheDocument()
    expect(screen.queryByText('-旧\r')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: '关闭' }))
    expect(onClose).toHaveBeenCalled()
  })

  it('内容不可取时显示原因', () => {
    render(
      <VersionDiffView
        path="outputs/x/pic.png"
        fromLabel="Agent 10:00"
        toLabel="Agent 10:05"
        result={{ ok: false, reason: '该版本的原始文件未被保留（VCS 不含二进制）' }}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText(/VCS 不含二进制/)).toBeInTheDocument()
  })

  it('两版相同给一句人话', () => {
    render(
      <VersionDiffView
        path="outputs/x/doc.md"
        fromLabel="a"
        toLabel="b"
        result={{ ok: true, kind: 'text', insertions: 0, deletions: 0, hunks: [] }}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('两版内容相同。')).toBeInTheDocument()
  })
})

describe('VersionTextView', () => {
  it('展示内容与近似提示', () => {
    render(
      <VersionTextView
        path="outputs/x/doc.md"
        label="Agent 10:00"
        text={'# doc\n\nbody\n'}
        approximate
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText(/快照可能包含后续改动/)).toBeInTheDocument()
    expect(screen.getByText(/# doc/)).toBeInTheDocument()
  })
})

describe('VersionDiffView · 图片与 PPT（T6）', () => {
  it('图片：两侧用物化副本的 media URL 并标出版本', () => {
    render(
      <VersionDiffView
        path="outputs/x/cover.png"
        fromLabel="本地 10:00"
        toLabel="Agent 10:05"
        result={{
          ok: true,
          kind: 'image',
          from: { path: '.lumii/exports/versions/aaa/cover.png', label: '本地 10:00' },
          to: { path: '.lumii/exports/versions/bbb/cover.png', label: 'Agent 10:05' },
        }}
        toAbsolutePath={(rel) => `/ws/${rel}`}
        onClose={vi.fn()}
      />,
    )
    const images = screen.getAllByRole('img')
    expect(images).toHaveLength(2)
    expect(decodeURIComponent(images[0]!.getAttribute('src')!)).toContain(
      '/ws/.lumii/exports/versions/aaa/cover.png',
    )
    expect(decodeURIComponent(images[1]!.getAttribute('src')!)).toContain(
      '/ws/.lumii/exports/versions/bbb/cover.png',
    )
    expect(screen.getByText('本地 10:00')).toBeInTheDocument()
    expect(screen.getByText('Agent 10:05')).toBeInTheDocument()
  })

  it('PPT：只列有变化的页，显示页码/标题与逐页统计', () => {
    render(
      <VersionDiffView
        path="outputs/x/deck.pptx"
        fromLabel="本地 10:00"
        toLabel="Agent 10:05"
        result={{
          ok: true,
          kind: 'slides',
          fromLabel: '本地 10:00',
          toLabel: 'Agent 10:05',
          totalPages: 3,
          pages: [
            {
              index: 1,
              title: '第二页',
              insertions: 1,
              deletions: 2,
              hunks: [
                {
                  oldStart: 1,
                  oldLines: 2,
                  newStart: 1,
                  newLines: 1,
                  lines: ['-旧要点 A', '-旧要点 B', '+新要点 A'],
                },
              ],
            },
          ],
        }}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('第 2 页 · 第二页')).toBeInTheDocument()
    expect(screen.getByText(/共 3 页/)).toBeInTheDocument()
    // 顶部汇总与逐页统计都有（两处）
    expect(screen.getAllByText('+1').length).toBeGreaterThan(0)
    expect(screen.getAllByText('−2').length).toBeGreaterThan(0)
    expect(screen.getByText(/新要点 A/)).toBeInTheDocument()
  })

  it('PPT 各页文本相同时给一句人话', () => {
    render(
      <VersionDiffView
        path="outputs/x/deck.pptx"
        fromLabel="a"
        toLabel="b"
        result={{
          ok: true,
          kind: 'slides',
          fromLabel: 'a',
          toLabel: 'b',
          totalPages: 2,
          pages: [],
        }}
        onClose={vi.fn()}
      />,
    )
    expect(screen.getByText('两版各页文本相同。')).toBeInTheDocument()
  })
})
