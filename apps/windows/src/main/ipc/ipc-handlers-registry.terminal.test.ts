/**
 * 回归：工作台「新建终端」依赖主进程注册 terminal:*；
 * 漏挂 registerTerminalIpcHandlers 会直接变成
 * Error: No handler registered for 'terminal:create'。
 */
/** @vitest-environment node */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  BrowserWindow: {},
}))

vi.mock('./workspace-ipc', () => ({
  setWorkspaceIpcDeps: vi.fn(),
  registerWorkspaceIpcHandlers: vi.fn(),
}))
vi.mock('./artifact-ipc', () => ({
  setArtifactIpcDeps: vi.fn(),
  registerArtifactIpcHandlers: vi.fn(),
}))
vi.mock('./window-ipc', () => ({
  setWindowIpcDeps: vi.fn(),
  registerWindowIpcHandlers: vi.fn(),
  showDesktopTaskNotification: vi.fn(),
}))
vi.mock('./channel-ipc', () => ({
  setChannelIpcDeps: vi.fn(),
  registerChannelIpcHandlers: vi.fn(),
}))
vi.mock('./file-system-ipc', () => ({
  setFileSystemIpcDeps: vi.fn(),
  registerFileSystemIpcHandlers: vi.fn(),
}))
vi.mock('./dialog-clipboard-ipc', () => ({
  setDialogClipboardIpcDeps: vi.fn(),
  registerDialogClipboardIpcHandlers: vi.fn(),
}))
vi.mock('./skills-ipc', () => ({
  setSkillsIpcDeps: vi.fn(),
  registerSkillsIpcHandlers: vi.fn(),
}))
vi.mock('./api-ipc', () => ({
  setApiIpcDeps: vi.fn(),
  registerApiIpcHandlers: vi.fn(),
}))
vi.mock('./settings-ipc', () => ({
  setSettingsIpcDeps: vi.fn(),
  registerSettingsIpcHandlers: vi.fn(),
}))
vi.mock('./user-guides-ipc', () => ({
  registerUserGuidesIpcHandlers: vi.fn(),
}))
vi.mock('./net-ipc', () => ({
  registerNetIpcHandlers: vi.fn(),
}))
vi.mock('./terminal-ipc', () => ({
  registerTerminalIpcHandlers: vi.fn(),
  disposeTerminals: vi.fn(),
}))
vi.mock('../notification-dispatch', () => ({
  setNotificationDispatchDeps: vi.fn(),
}))
vi.mock('../storage-cleanup-prefs', () => ({
  setStorageCleanupPrefsProvider: vi.fn(),
}))
vi.mock('../single-turn-llm', () => ({
  SingleTurnLlmService: vi.fn(),
}))

import { registerAllIpcHandlers } from './ipc-handlers-registry'
import { registerTerminalIpcHandlers } from './terminal-ipc'

/** 构造注册入口所需的最小依赖桩 */
function makeDeps() {
  return {
    getMainWindow: () => null,
    getConfigManager: () => null,
    getDirectoryManager: () => ({}) as never,
    getSystemService: () => null,
    getSkillRuntime: () => null,
    getSkillWatcher: () => null,
    getTrayManager: () => null,
    getWeixinLoginService: () => null,
    getWecomLoginService: () => null,
    getFeishuLoginService: () => null,
    getQbotLoginService: () => null,
    getChannelHub: () => null,
    getAgentRuntimeBridge: () => null,
    getWorkspaceDir: () => '',
    reapplyCodingDevAcpEnv: () => undefined,
    setMemoryInjectionSettings: () => undefined,
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  }
}

describe('registerAllIpcHandlers · 本地终端', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('启动时注册 terminal IPC（含 terminal:create）', () => {
    registerAllIpcHandlers(makeDeps())
    expect(registerTerminalIpcHandlers).toHaveBeenCalledTimes(1)
    expect(registerTerminalIpcHandlers).toHaveBeenCalledWith(expect.any(Function))
  })
})
