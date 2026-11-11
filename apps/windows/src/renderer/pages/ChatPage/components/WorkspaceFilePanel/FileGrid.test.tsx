/**
 * FileGrid 的外部定位（用户报：列表（树）能定位，网格不能）。
 *
 * 树靠 revealToken 反复展开同一路径；网格之前只依赖 selectedPath 变化，
 * 用户手动走进别的目录后再定位同一个文件时不会切回去。这里钉住这条。
 */
import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'

vi.mock('../../../../services/file-service', () => ({
  listDirectory: vi.fn(),
}))
vi.mock('../../../../services/app-service', () => ({
  showItemInFolder: vi.fn(async () => undefined),
}))

import { FileGrid } from './FileGrid'
import { listDirectory } from '../../../../services/file-service'

const listDirectoryMock = vi.mocked(listDirectory)

function entry(dir: string, name: string, isDirectory = false) {
  return {
    name,
    path: `${dir}/${name}`,
    isDirectory,
    size: 1,
    modifiedAt: new Date(),
    createdAt: new Date(),
  }
}

describe('FileGrid · 外部定位', () => {
  beforeEach(() => {
    listDirectoryMock.mockReset()
    listDirectoryMock.mockImplementation(async (dir: string) => {
      if (dir.endsWith('/outputs')) return [entry(dir, 'cover.png')]
      if (dir.endsWith('/docs')) return [entry(dir, 'readme.md')]
      return [entry(dir, 'outputs', true), entry(dir, 'docs', true)]
    })
    // jsdom 没有 scrollIntoView
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('有 selectedPath 时切到它所在目录', async () => {
    render(
      <FileGrid
        rootPath="E:/ws"
        selectedPath="E:/ws/outputs/cover.png"
        onOpenFile={vi.fn()}
      />,
    )
    expect(await screen.findByText('cover.png')).toBeInTheDocument()
  })

  it('同一路径再次定位（token 变化）也切回该目录', async () => {
    const props = { rootPath: 'E:/ws', selectedPath: 'E:/ws/docs/readme.md', onOpenFile: () => {} }
    const { rerender } = render(<FileGrid {...props} revealToken={1} />)
    expect(await screen.findByText('readme.md')).toBeInTheDocument()

    // 用户手动离开：回上级再进 outputs
    fireEvent.click(screen.getByRole('button', { name: '返回上一级' }))
    fireEvent.click(await screen.findByRole('button', { name: /outputs/ }))
    expect(await screen.findByText('cover.png')).toBeInTheDocument()

    // 再定位同一个文件：只有 token 变，路径没变
    rerender(<FileGrid {...props} revealToken={2} />)
    expect(await screen.findByText('readme.md')).toBeInTheDocument()
  })

  it('定位目标是文件夹时进入该目录', async () => {
    render(
      <FileGrid rootPath="E:/ws" selectedPath="E:/ws/outputs" revealToken={1} onOpenFile={vi.fn()} />,
    )
    expect(await screen.findByText('cover.png')).toBeInTheDocument()
  })
})
