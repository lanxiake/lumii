/**
 * 本地终端 IPC：确认 create/write/resize/kill 四个通道都挂上。
 */
/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
}))

vi.mock('../terminal/terminal-service', () => ({
  createTerminal: vi.fn(() => ({ id: 'term-1', pty: { pid: 42 } })),
  killAllTerminals: vi.fn(),
  killTerminal: vi.fn(),
  readTerminalTail: vi.fn(() => ''),
  resizeTerminal: vi.fn(() => true),
  writeTerminal: vi.fn(() => true),
}))

import { ipcMain } from 'electron'
import { disposeTerminals, registerTerminalIpcHandlers } from './terminal-ipc'
import { killAllTerminals } from '../terminal/terminal-service'

describe('registerTerminalIpcHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    registerTerminalIpcHandlers(() => [])
  })

  /** 取出已注册的 channel 名列表 */
  function registeredChannels(): string[] {
    return (ipcMain.handle as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[0] as string)
  }

  it('注册 terminal:create / write / resize / kill', () => {
    expect(registeredChannels()).toEqual(
      expect.arrayContaining([
        'terminal:create',
        'terminal:write',
        'terminal:resize',
        'terminal:kill',
      ]),
    )
  })
})

describe('disposeTerminals', () => {
  it('退出时杀掉全部终端会话', () => {
    disposeTerminals()
    expect(killAllTerminals).toHaveBeenCalledTimes(1)
  })
})
