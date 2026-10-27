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

/** 文本产物：逐行差异/预览只对文本开放（图片/PPT 的版本对照在 T6） */
const DOC_ARTIFACT: Artifact = {
  ...ARTIFACT,
  path: 'outputs/pet/doc.md',
  kind: 'doc',
  meta: { words: 120 },
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
    renderInspector({ artifact: DOC_ARTIFACT, onShowDiff, onPreviewVersion })

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

describe('ArtifactInspector · 图片可复现参数（T5）', () => {
  const PROMPT_ARTIFACT: Artifact = {
    ...ARTIFACT,
    meta: {
      width: 1024,
      height: 1024,
      model: 'nano-banana-2',
      prompt: '猫（模型改写）',
      sourcePrompt: '一只趴在桌上的猫',
      params: { steps: 20, ratio: '1:1', hd: false },
    },
    derivedFrom: 'outputs/pet/cover.png',
  }

  beforeEach(() => {
    ;(window.electronAPI as any).agentRuntime = {}
  })

  it('原始提示词与改写后提示词分开标注；params 以 chip 展示', () => {
    render(
      <ArtifactInspector
        artifact={PROMPT_ARTIFACT}
        sessionKey="conv-1"
        versions={[]}
        onGoToTurn={vi.fn()}
      />,
    )
    expect(screen.getByText('原始提示词')).toBeInTheDocument()
    expect(screen.getByText('一只趴在桌上的猫')).toBeInTheDocument()
    expect(screen.getByText('改写后提示词（模型）')).toBeInTheDocument()
    expect(screen.getByText('猫（模型改写）')).toBeInTheDocument()
    expect(screen.getByText('steps: 20')).toBeInTheDocument()
    expect(screen.getByText('ratio: 1:1')).toBeInTheDocument()
    expect(screen.getByText('hd: false')).toBeInTheDocument()
    expect(screen.getByText('变体 · 来自 cover.png')).toBeInTheDocument()
    // 不提供本机没有的 seed 选项，只说明事实
    expect(screen.getByText(/不支持 seed/)).toBeInTheDocument()
    expect(screen.queryByText(/换 seed/)).toBeNull()
  })

  it('提示词可复制到剪贴板，并给出「已复制」反馈', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    ;(window.electronAPI as any).clipboard = { writeText }
    render(
      <ArtifactInspector
        artifact={PROMPT_ARTIFACT}
        sessionKey="conv-1"
        versions={[]}
        onGoToTurn={vi.fn()}
      />,
    )
    const copyButtons = screen.getAllByRole('button', { name: '复制' })
    expect(copyButtons).toHaveLength(2)
    fireEvent.click(copyButtons[0]!)
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('一只趴在桌上的猫'))
    expect(screen.getByRole('button', { name: '已复制' })).toBeInTheDocument()

    // 一键复制全部复现参数：尺寸/模型/两段提示词
    fireEvent.click(screen.getByRole('button', { name: '复制全部参数' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledTimes(2))
    const block = writeText.mock.calls[1]![0] as string
    expect(block).toContain('尺寸：1024×1024')
    expect(block).toContain('模型：nano-banana-2')
    expect(block).toContain('原始提示词：一只趴在桌上的猫')
    expect(block).toContain('改写后提示词（模型）：猫（模型改写）')
    expect(screen.getByRole('button', { name: '已复制全部参数' })).toBeInTheDocument()
  })

  it('模型没有改写时两段提示词相同，只显示一段', () => {
    render(
      <ArtifactInspector
        artifact={{
          ...ARTIFACT,
          meta: { model: 'm', sourcePrompt: '同一段', prompt: '同一段' },
        }}
        sessionKey="conv-1"
        versions={[]}
        onGoToTurn={vi.fn()}
      />,
    )
    expect(screen.getByText('原始提示词')).toBeInTheDocument()
    expect(screen.queryByText('改写后提示词（模型）')).toBeNull()
    expect(screen.getAllByText('同一段')).toHaveLength(1)
  })

  it('没有提示词/派生来源时不显示这些块', () => {
    render(
      <ArtifactInspector
        artifact={ARTIFACT}
        sessionKey="conv-1"
        versions={[]}
        onGoToTurn={vi.fn()}
      />,
    )
    expect(screen.queryByText('原始提示词')).toBeNull()
    expect(screen.queryByText(/不支持 seed/)).toBeNull()
    expect(screen.queryByText(/变体 · 来自/)).toBeNull()
  })
})

describe('ArtifactInspector · 以此为准（T6）', () => {
  beforeEach(() => {
    ;(window.electronAPI as any).agentRuntime = {}
  })

  it('内容可取的版本给「以此为准」，点击把该版交给上层', async () => {
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
          versionId: 'local:edit-1',
          source: 'local',
          timestamp: Date.parse('2026-01-01T10:05:00.000Z'),
          status: 'edited',
          content: { available: true, kind: 'store' },
        },
      ],
      total: 2,
    }))
    const onPinVersion = vi.fn()
    renderInspector({ artifact: DOC_ARTIFACT, onPinVersion })
    await waitFor(() => expect(screen.getAllByRole('button', { name: '以此为准' })).toHaveLength(2))
    fireEvent.click(screen.getAllByRole('button', { name: '以此为准' })[1]!)
    expect(onPinVersion).toHaveBeenCalledWith(
      expect.objectContaining({ versionId: 'local:edit-1' }),
    )
  })

  it('已选定：徽标 + 取消按钮 + 「已选定 1（当前 2）」', async () => {
    mockSendCommand(async () => ({
      versions: [
        {
          versionId: 'turn:m1',
          source: 'turn',
          turnId: 'm1',
          timestamp: Date.parse('2026-01-01T10:00:00.000Z'),
          status: 'added',
          content: { available: true, kind: 'git' },
          pinned: { pinId: 'pin-1', at: Date.parse('2026-01-01T10:02:00.000Z'), bytes: 2048 },
        },
        {
          versionId: 'local:edit-1',
          source: 'local',
          timestamp: Date.parse('2026-01-01T10:05:00.000Z'),
          status: 'edited',
          content: { available: true, kind: 'store' },
        },
      ],
      total: 2,
    }))
    const onUnpinVersion = vi.fn()
    const onPinVersion = vi.fn()
    renderInspector({ artifact: DOC_ARTIFACT, onPinVersion, onUnpinVersion })
    await waitFor(() => expect(screen.getByText(/已选定 1（当前 2）/)).toBeInTheDocument())
    expect(screen.getByText('已选定')).toBeInTheDocument()
    // 已选定的那一行不再给「以此为准」
    expect(screen.getAllByRole('button', { name: '以此为准' })).toHaveLength(1)
    fireEvent.click(screen.getByRole('button', { name: '取消' }))
    expect(onUnpinVersion).toHaveBeenCalledWith(
      expect.objectContaining({ pinned: expect.objectContaining({ pinId: 'pin-1' }) }),
    )
  })

  it('没有固化回调时不出现「以此为准」/「取消」', async () => {
    mockSendCommand(async () => ({
      versions: [
        {
          versionId: 'turn:m1',
          source: 'turn',
          turnId: 'm1',
          timestamp: Date.parse('2026-01-01T10:00:00.000Z'),
          status: 'added',
          content: { available: true, kind: 'git' },
          pinned: { pinId: 'pin-1', at: 1, bytes: 1 },
        },
      ],
      total: 1,
    }))
    renderInspector({ artifact: DOC_ARTIFACT })
    await waitFor(() => expect(screen.getByText('已选定')).toBeInTheDocument())
    expect(screen.queryByRole('button', { name: '取消' })).toBeNull()
    expect(screen.queryByRole('button', { name: '以此为准' })).toBeNull()
  })
})
