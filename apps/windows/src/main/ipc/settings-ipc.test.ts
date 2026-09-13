import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

import { registerSettingsIpcHandlers, setSettingsIpcDeps } from './settings-ipc'
import { ipcMain } from 'electron'

describe('Settings IPC 通道（提示词风格实验 P0-T4）', () => {
  const setMemory = vi.fn()
  const setPromptStyle = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    setSettingsIpcDeps({
      setMemoryInjectionSettings: setMemory,
      setPromptStyleSettings: setPromptStyle,
    })
    registerSettingsIpcHandlers()
  })

  const handlerFor = (channel: string) =>
    (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === channel)![1]

  it('注册 settings:updatePromptStyle 并转发 payload', async () => {
    const handler = handlerFor('settings:updatePromptStyle')
    await handler({}, { style: 'terse' })
    expect(setPromptStyle).toHaveBeenCalledWith({ style: 'terse' })
  })

  it('非对象 payload 被忽略', async () => {
    const handler = handlerFor('settings:updatePromptStyle')
    await handler({}, undefined)
    await handler({}, 'weird')
    expect(setPromptStyle).not.toHaveBeenCalled()
  })

  it('既有记忆注入通道不受影响', async () => {
    const handler = handlerFor('settings:updateMemoryInjection')
    await handler({}, { injectWorkMemory: false })
    expect(setMemory).toHaveBeenCalledWith({ injectWorkMemory: false })
  })
})
