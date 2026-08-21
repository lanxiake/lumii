/**
 * IPC handlers 聚合注册入口
 *
 * 将各个模块的 IPC handlers 统一注册
 */
import type { BrowserWindow } from 'electron'
import type { ConfigManager } from '../config-manager'
import type { DirectoryManager } from '../directory-manager'
import type { SystemService } from '../system-service'
import type { ClientSkillRuntime } from '../skill-runtime'
import type { SkillWatcher } from '../skill-watcher'
import type { TrayManager } from '../tray-manager'
import type { WeixinLoginService } from '../weixin-login-service'
import type { WecomLoginService } from '../wecom-login-service'
import type { FeishuLoginService } from '../feishu-login-service'
import type { ChannelHub } from '../channel/channel-hub-bootstrap'
import type { AgentRuntimeBridge } from '../agent-runtime'

import {
  setWorkspaceIpcDeps,
  registerWorkspaceIpcHandlers
} from './workspace-ipc'
import {
  setVcsIpcDeps,
  registerVcsIpcHandlers
} from './vcs-ipc'
import {
  setWindowIpcDeps,
  registerWindowIpcHandlers
} from './window-ipc'
import {
  setChannelIpcDeps,
  registerChannelIpcHandlers
} from './channel-ipc'
import {
  setFileSystemIpcDeps,
  registerFileSystemIpcHandlers,
  registerAppQuitHandler
} from './file-system-ipc'
import {
  setDialogClipboardIpcDeps,
  registerDialogClipboardIpcHandlers
} from './dialog-clipboard-ipc'
import {
  setSkillsIpcDeps,
  registerSkillsIpcHandlers
} from './skills-ipc'
import {
  setApiIpcDeps,
  registerApiIpcHandlers
} from './api-ipc'
import {
  setSettingsIpcDeps,
  registerSettingsIpcHandlers
} from './settings-ipc'

export interface IpcHandlersDeps {
  getMainWindow: () => BrowserWindow | null
  getConfigManager: () => ConfigManager | null
  getDirectoryManager: () => DirectoryManager
  getSystemService: () => SystemService | null
  getSkillRuntime: () => ClientSkillRuntime | null
  getSkillWatcher: () => SkillWatcher | null
  getTrayManager: () => TrayManager | null
  getWeixinLoginService: () => WeixinLoginService | null
  getWecomLoginService: () => WecomLoginService | null
  getFeishuLoginService: () => FeishuLoginService | null
  getChannelHub: () => ChannelHub | null
  getAgentRuntimeBridge: () => AgentRuntimeBridge | null
  getWorkspaceDir: () => string
  reapplyCodingDevAcpEnv: () => void
  setMemoryInjectionSettings: (settings: {
    injectPersonalMemory?: boolean
    injectWorkMemory?: boolean
  }) => void
  isQuittingGetter: () => boolean
  setIsQuitting: (value: boolean) => void
  log: {
    info: (...args: unknown[]) => void
    warn: (...args: unknown[]) => void
    error: (...args: unknown[]) => void
  }
}

export function registerAllIpcHandlers(deps: IpcHandlersDeps): void {
  // 设置各模块的依赖
  setWorkspaceIpcDeps({
    getMainWindow: deps.getMainWindow,
    getConfigManager: deps.getConfigManager,
    getDirectoryManager: deps.getDirectoryManager,
    reapplyCodingDevAcpEnv: deps.reapplyCodingDevAcpEnv,
  })

  setVcsIpcDeps({
    getWorkspaceDir: deps.getWorkspaceDir,
    log: deps.log,
  })

  setWindowIpcDeps({
    getMainWindow: deps.getMainWindow,
    getTrayManager: deps.getTrayManager,
    log: deps.log,
  })

  setChannelIpcDeps({
    getWeixinLoginService: deps.getWeixinLoginService,
    getWecomLoginService: deps.getWecomLoginService,
    getFeishuLoginService: deps.getFeishuLoginService,
    getChannelHub: deps.getChannelHub,
  })

  setFileSystemIpcDeps({
    getSystemService: deps.getSystemService,
    log: deps.log,
  })

  setDialogClipboardIpcDeps({
    getMainWindow: deps.getMainWindow,
  })

  setSkillsIpcDeps({
    getSkillRuntime: deps.getSkillRuntime,
    getSkillWatcher: deps.getSkillWatcher,
    getWorkspaceDir: deps.getWorkspaceDir,
    log: deps.log,
  })

  setApiIpcDeps({
    getAgentRuntimeBridge: deps.getAgentRuntimeBridge,
    log: deps.log,
  })

  setSettingsIpcDeps({
    setMemoryInjectionSettings: deps.setMemoryInjectionSettings,
  })

  // 注册所有 IPC handlers
  registerWorkspaceIpcHandlers()
  registerVcsIpcHandlers()
  registerWindowIpcHandlers()
  registerChannelIpcHandlers()
  registerFileSystemIpcHandlers()
  registerDialogClipboardIpcHandlers()
  registerSkillsIpcHandlers()
  registerApiIpcHandlers()
  registerSettingsIpcHandlers()
  registerAppQuitHandler(deps.isQuittingGetter, deps.setIsQuitting)
}
