import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

import { registerSettingsIpcHandlers, setSettingsIpcDeps } from './settings-ipc'
import { ipcMain } from 'electron'

describe('Settings IPC 通道（记忆注入；提示词风格已插件化）', () => {
  const setMemory = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    setSettingsIpcDeps({
      setMemoryInjectionSettings: setMemory,
    })
    registerSettingsIpcHandlers()
  })

  const handlerFor = (channel: string) =>
    (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.find((c) => c[0] === channel)![1]

  it('既有记忆注入通道不受影响', async () => {
    const handler = handlerFor('settings:updateMemoryInjection')
    await handler({}, { injectWorkMemory: false })
    expect(setMemory).toHaveBeenCalledWith({ injectWorkMemory: false })
  })
})
