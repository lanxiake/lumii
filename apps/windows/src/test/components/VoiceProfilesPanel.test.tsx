/**
 * VoiceProfilesPanel：固定朗读稿展示与转写解析
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import '@testing-library/jest-dom'
import { VoiceProfilesPanel } from '../../renderer/pages/SettingsPage/components/VoiceProfilesPanel'
import { CLONE_REF_PROMPT_ZH } from '../../renderer/pages/SettingsPage/components/VoiceProfilesPanel/clone-ref-prompt'

describe('VoiceProfilesPanel', () => {
  beforeEach(() => {
    ;(window as any).electronAPI = {
      voice: {
        sendCommand: vi.fn(async (cmd: { type: string }) => {
          if (cmd.type === 'voice:profiles:list') return []
          return { ok: true }
        }),
      },
      dialog: { showOpenDialog: vi.fn() },
    }
  })

  it('渲染固定朗读稿', async () => {
    render(
      <VoiceProfilesPanel
        onSelectProfile={vi.fn()}
        saveVoiceConfig={vi.fn(async () => undefined)}
      />,
    )
    expect(await screen.findByText(CLONE_REF_PROMPT_ZH)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '开始录制' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: '选择参考音频' })).toBeInTheDocument()
  })
})
