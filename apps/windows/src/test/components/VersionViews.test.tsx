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
        result={{ ok: true, insertions: 0, deletions: 0, hunks: [] }}
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
