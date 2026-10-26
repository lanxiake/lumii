/**
 * ArtifactCard 组件测试
 * 验证：视频/PPT 按需请求缩略图、同路径不重复请求、失败回退占位、小图直读原图。
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import '@testing-library/jest-dom'
import { ArtifactCard } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/ArtifactCard'
import type { Artifact } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/ledger'

function makeArtifact(overrides: Partial<Artifact>): Artifact {
  return {
    path: 'outputs/x/a.pptx',
    kind: 'slides',
    role: 'deliverable',
    status: 'added',
    timestamp: Date.now(),
    turnId: 't1',
    ...overrides,
  }
}

function mockThumb(impl: (path: string) => unknown) {
  const thumb = vi.fn(impl)
  ;(window.electronAPI as any).artifact = { thumb }
  return thumb
}

describe('ArtifactCard 缩略图', () => {
  beforeEach(() => {
    ;(window.electronAPI as any).artifact = {}
  })

  it('PPT 请求页数并显示为副标题', async () => {
    const thumb = mockThumb(() => Promise.resolve({ ok: true, meta: { pages: 12 } }))
    render(
      <ArtifactCard
        artifact={makeArtifact({})}
        absolutePath="/ws/outputs/x/a.pptx"
        onSelect={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText('12 页')).toBeInTheDocument())
    expect(thumb).toHaveBeenCalledWith('outputs/x/a.pptx')
  })

  it('视频首帧：拿到 url 才换成图片，并要求播放角标', async () => {
    const thumb = mockThumb(() =>
      Promise.resolve({ ok: true, url: 'lumii-local://media/?path=thumb.jpg' }),
    )
    const { container } = render(
      <ArtifactCard
        artifact={makeArtifact({ path: 'outputs/x/clip.mp4', kind: 'video' })}
        absolutePath="/ws/outputs/x/clip.mp4"
        onSelect={vi.fn()}
      />,
    )
    expect(screen.getByText('MP4')).toBeInTheDocument()
    await waitFor(() => expect(container.querySelector('img')).not.toBeNull())
    expect(container.querySelector('img')?.getAttribute('src')).toContain('thumb.jpg')
    expect(screen.getByText('▶')).toBeInTheDocument()
    expect(thumb).toHaveBeenCalledTimes(1)
  })

  it('缩略图失败回退扩展名占位，不抛', async () => {
    mockThumb(() => Promise.resolve({ ok: false, error: '抽帧失败' }))
    const { container } = render(
      <ArtifactCard
        artifact={makeArtifact({ path: 'outputs/x/bad.mp4', kind: 'video' })}
        absolutePath="/ws/outputs/x/bad.mp4"
        onSelect={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText('MP4')).toBeInTheDocument())
    expect(container.querySelector('img')).toBeNull()
  })

  it('小于 2048px 的图片直读原图，不发 IPC', () => {
    const thumb = mockThumb(() => Promise.resolve({ ok: true }))
    const { container } = render(
      <ArtifactCard
        artifact={makeArtifact({
          path: 'outputs/x/a.png',
          kind: 'image',
          meta: { width: 512, height: 512 },
        })}
        absolutePath="/ws/outputs/x/a.png"
        onSelect={vi.fn()}
      />,
    )
    expect(container.querySelector('img')?.getAttribute('src')).toContain('lumii-local://media')
    expect(thumb).not.toHaveBeenCalled()
  })

  it('大图走缩略图', async () => {
    const thumb = mockThumb(() =>
      Promise.resolve({ ok: true, url: 'lumii-local://media/?path=big.webp', meta: { width: 256 } }),
    )
    const { container } = render(
      <ArtifactCard
        artifact={makeArtifact({
          path: 'outputs/x/big.png',
          kind: 'image',
          meta: { width: 4096, height: 4096 },
        })}
        absolutePath="/ws/outputs/x/big.png"
        onSelect={vi.fn()}
      />,
    )
    await waitFor(() =>
      expect(container.querySelector('img')?.getAttribute('src')).toContain('big.webp'),
    )
    expect(thumb).toHaveBeenCalledWith('outputs/x/big.png')
  })

  it('大图缩略失败回退原图（不留在占位）', async () => {
    mockThumb(() => Promise.resolve({ ok: false, error: 'sharp 失败' }))
    const { container } = render(
      <ArtifactCard
        artifact={makeArtifact({
          path: 'outputs/x/huge.png',
          kind: 'image',
          meta: { width: 4096, height: 4096 },
        })}
        absolutePath="/ws/outputs/x/huge.png"
        onSelect={vi.fn()}
      />,
    )
    await waitFor(() =>
      expect(container.querySelector('img')?.getAttribute('src')).toContain('lumii-local://media'),
    )
  })

  it('无 meta 的图片也走缩略图（fileChanges 派生的产出）', async () => {
    const thumb = mockThumb(() =>
      Promise.resolve({ ok: true, url: 'lumii-local://media/?path=gen.webp' }),
    )
    const { container } = render(
      <ArtifactCard
        artifact={makeArtifact({ path: 'outputs/x/gen.png', kind: 'image' })}
        absolutePath="/ws/outputs/x/gen.png"
        onSelect={vi.fn()}
      />,
    )
    // 先直读原图（不闪占位），缩略回来再换成 256px 版本
    expect(container.querySelector('img')?.getAttribute('src')).toContain('lumii-local://media')
    await waitFor(() =>
      expect(container.querySelector('img')?.getAttribute('src')).toContain('gen.webp'),
    )
    expect(thumb).toHaveBeenCalledWith('outputs/x/gen.png')
  })

  it('同一路径换版本（timestamp 变）会重新取，且中间不留旧图', async () => {
    const thumb = mockThumb((p: string) =>
      Promise.resolve({ ok: true, url: `lumii-local://media/?path=${p}-v.png` }),
    )
    const artifact = makeArtifact({ path: 'outputs/x/v.png', kind: 'image', timestamp: 1 })
    const { container, rerender } = render(
      <ArtifactCard artifact={artifact} absolutePath="/ws/outputs/x/v.png" onSelect={vi.fn()} />,
    )
    await waitFor(() => expect(thumb).toHaveBeenCalledTimes(1))

    // 同 props 重渲染不应再请求
    rerender(
      <ArtifactCard artifact={artifact} absolutePath="/ws/outputs/x/v.png" onSelect={vi.fn()} />,
    )
    expect(thumb).toHaveBeenCalledTimes(1)

    rerender(
      <ArtifactCard
        artifact={{ ...artifact, timestamp: 2 }}
        absolutePath="/ws/outputs/x/v.png"
        onSelect={vi.fn()}
      />,
    )
    await waitFor(() => expect(thumb).toHaveBeenCalledTimes(2))
    await waitFor(() =>
      expect(container.querySelector('img')?.getAttribute('src')).toContain('v.png-v.png'),
    )
  })

  it('IPC reject 不冒到界面，回退占位', async () => {
    mockThumb(() => Promise.reject(new Error('channel closed')))
    const { container } = render(
      <ArtifactCard
        artifact={makeArtifact({ path: 'outputs/x/bad.mp4', kind: 'video' })}
        absolutePath="/ws/outputs/x/bad.mp4"
        onSelect={vi.fn()}
      />,
    )
    await waitFor(() => expect(screen.getByText('MP4')).toBeInTheDocument())
    expect(container.querySelector('img')).toBeNull()
  })
})
