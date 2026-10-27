/**
 * ArtifactInspector：规格 + 全会话版本历史（主进程查询，失败回退台账）。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import '@testing-library/jest-dom'
import React from 'react'
import { ArtifactInspector } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/ArtifactInspector'
import type { Artifact, ArtifactVersion } from '../../renderer/pages/ChatPage/components/WorkspaceArtifactsPanel/ledger'

const ARTIFACT: Artifact = {
  path: 'outputs/pet/a.png',
  kind: 'image',
  role: 'deliverable',
  status: 'modified',
  timestamp: Date.parse('2026-01-01T10:30:00.000Z'),
  turnId: 'm2',
  meta: { width: 1024, height: 768, model: 'seedream', bytes: 2 * 1024 * 1024 },
  sourceTool: 'image_generate',
}

const LOADED_VERSIONS: ArtifactVersion[] = [
  { turnId: 'm1', timestamp: Date.parse('2026-01-01T10:00:00.000Z'), status: 'added' },
  { turnId: 'm2', timestamp: Date.parse('2026-01-01T10:30:00.000Z'), status: 'modified' },
]

function mockSendCommand(impl: (cmd: unknown) => Promise<unknown>) {
  const sendCommand = vi.fn(impl)
  ;(window.electronAPI as any).agentRuntime = { sendCommand }
  return sendCommand
}

function renderInspector(props: Partial<React.ComponentProps<typeof ArtifactInspector>> = {}) {
  return render(
    <ArtifactInspector
      artifact={ARTIFACT}
      sessionKey="conv-1"
      versions={LOADED_VERSIONS}
      onGoToTurn={vi.fn()}
      {...props}
    />,
  )
}

describe('ArtifactInspector', () => {
  beforeEach(() => {
    ;(window.electronAPI as any).agentRuntime = {}
  })

  it('展示规格与路径；版本来自主进程后会补全', async () => {
    const sendCommand = mockSendCommand(async () => ({
      versions: [
        { turnId: 'm0', timestamp: Date.parse('2026-01-01T09:00:00.000Z'), status: 'added' },
        ...LOADED_VERSIONS.map((v) => ({ ...v })),
      ],
      total: 3,
    }))
    renderInspector()

    expect(screen.getByText('1024×768')).toBeInTheDocument()
    expect(screen.getByText('seedream')).toBeInTheDocument()
    expect(screen.getByText('2.0 MB')).toBeInTheDocument()
    expect(screen.getByText('outputs/pet/a.png')).toBeInTheDocument()

    await waitFor(() => expect(screen.getByText('3 个')).toBeInTheDocument())
    expect(sendCommand).toHaveBeenCalledWith({
      type: 'artifact:history',
      sessionKey: 'conv-1',
      path: 'outputs/pet/a.png',
    })
    // 主进程结果到位后不该再提示「只含已加载的消息」
    expect(screen.queryByText(/只含已加载的消息/)).toBeNull()
  })

  it('主进程返回前先用台账版本顶上，并明示只含已加载部分', () => {
    mockSendCommand(() => new Promise(() => {}))
    renderInspector()
    expect(screen.getByText('2 个')).toBeInTheDocument()
    expect(screen.getByText(/只含已加载的消息/)).toBeInTheDocument()
  })

  it('查询失败回退台账并显示错误，不炸', async () => {
    mockSendCommand(() => Promise.reject(new Error('not_found: conversation')))
    renderInspector()
    await waitFor(() => expect(screen.getByText(/版本历史读取失败/)).toBeInTheDocument())
    expect(screen.getByText('2 个')).toBeInTheDocument()
  })

  it('点「回到消息」把 turnId 交给上层', async () => {
    mockSendCommand(async () => ({ versions: LOADED_VERSIONS, total: 2 }))
    const onGoToTurn = vi.fn()
    renderInspector({ onGoToTurn })

    await waitFor(() => expect(screen.getAllByText('回到消息')).toHaveLength(2))
    fireEvent.click(screen.getAllByText('回到消息')[1]!)
    expect(onGoToTurn).toHaveBeenCalledWith('m2')
  })

  it('没有历史时给一句人话，而不是空列表', async () => {
    mockSendCommand(async () => ({ versions: [], total: 0 }))
    renderInspector({ versions: [] })
    await waitFor(() => expect(screen.getByText(/没有记录到写入历史/)).toBeInTheDocument())
  })

  it('本地版本标注来源、可差异/预览；只有 turn 版能回到消息', async () => {
    const localId = 'local:edit-1'
    mockSendCommand(async () => ({
      versions: [
        {
          versionId: 'turn:m1',
          source: 'turn',
          turnId: 'm1',
          timestamp: Date.parse('2026-01-01T10:00:00.000Z'),
          status: 'added',
          content: { available: true, kind: 'git' },
        },
        {
          versionId: localId,
          source: 'local',
          timestamp: Date.parse('2026-01-01T10:05:00.000Z'),
          status: 'edited',
          content: { available: true, kind: 'store' },
        },
      ],
      total: 2,
    }))
    const onShowDiff = vi.fn()
    const onPreviewVersion = vi.fn()
    renderInspector({ onShowDiff, onPreviewVersion })

    await waitFor(() => expect(screen.getByText('本地')).toBeInTheDocument())
    expect(screen.getByText('本地编辑')).toBeInTheDocument()
    // 只有 turn 版有「回到消息」
    expect(screen.getAllByText('回到消息')).toHaveLength(1)

    fireEvent.click(screen.getByRole('button', { name: '差异' }))
    expect(onShowDiff).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: localId }),
      expect.objectContaining({ versionId: 'turn:m1' }),
    )

    fireEvent.click(screen.getAllByRole('button', { name: '预览' })[1]!)
    expect(onPreviewVersion).toHaveBeenCalledWith(expect.objectContaining({ versionId: localId }))
  })

  it('内容不可取的版本不显示差异/预览，只给「内容未保留」', async () => {
    mockSendCommand(async () => ({
      versions: [
        {
          versionId: 'turn:m1',
          source: 'turn',
          turnId: 'm1',
          timestamp: Date.parse('2026-01-01T10:00:00.000Z'),
          status: 'added',
          content: { available: false, reason: '该版本的原始文件未被保留（VCS 不含二进制）' },
        },
      ],
      total: 1,
    }))
    renderInspector()
    await waitFor(() => expect(screen.getByText('内容未保留')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '预览' })).toBeNull()
    expect(screen.queryByRole('button', { name: '差异' })).toBeNull()
  })
})
