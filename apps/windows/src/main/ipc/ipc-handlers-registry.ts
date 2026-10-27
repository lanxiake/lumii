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
import type { QbotLoginService } from '../qbot-login-service'
import type { ChannelHub } from '../channel/channel-hub-bootstrap'
import type { AgentRuntimeBridge } from '../agent-runtime'

import {
  setWorkspaceIpcDeps,
  registerWorkspaceIpcHandlers
} from './workspace-ipc'
import {
  setArtifactIpcDeps,
  registerArtifactIpcHandlers,
} from './artifact-ipc'
import {
  setWindowIpcDeps,
  registerWindowIpcHandlers,
  showDesktopTaskNotification
} from './window-ipc'
import { setNotificationDispatchDeps } from '../notification-dispatch'
import {
  setChannelIpcDeps,
  registerChannelIpcHandlers
} from './channel-ipc'
import {
  setFileSystemIpcDeps,
  registerFileSystemIpcHandlers,
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
import { registerUserGuidesIpcHandlers } from './user-guides-ipc'
import { registerNetIpcHandlers } from './net-ipc'

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
  getQbotLoginService: () => QbotLoginService | null
  getChannelHub: () => ChannelHub | null
  getAgentRuntimeBridge: () => AgentRuntimeBridge | null
  getWorkspaceDir: () => string
  reapplyCodingDevAcpEnv: () => void
  setMemoryInjectionSettings: (settings: {
    injectPersonalMemory?: boolean
    injectWorkMemory?: boolean
  }) => void
  pluginEventBus?: import('@mtbot/plugin-core').EventBus<import('../kernel/events').MainEvents> | null
  log: {
    debug: (...args: unknown[]) => void
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
    pluginEventBus: deps.pluginEventBus,
  })

  // VCS / 划词的 IPC 现在由各自插件在 apply() 里装（通道挂在插件作用域上，
  // 停用即摘）——这里不再接线，也不再看启动快照。

  setWindowIpcDeps({
    getMainWindow: deps.getMainWindow,
    getTrayManager: deps.getTrayManager,
    log: deps.log,
  })

  setChannelIpcDeps({
    getWeixinLoginService: deps.getWeixinLoginService,
    getWecomLoginService: deps.getWecomLoginService,
    getFeishuLoginService: deps.getFeishuLoginService,
    getQbotLoginService: deps.getQbotLoginService,
    getChannelHub: deps.getChannelHub,
    getAgentRuntimeBridge: deps.getAgentRuntimeBridge,
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
    getConfigManager: deps.getConfigManager,
    log: deps.log,
  })

  setSettingsIpcDeps({
    setMemoryInjectionSettings: deps.setMemoryInjectionSettings,
  })

  setArtifactIpcDeps({
    getWorkspaceDir: deps.getWorkspaceDir,
    getMainWindow: deps.getMainWindow,
    log: deps.log,
  })

  // 通知唯一出口：策略/免打扰/去重都在 dispatch 里判
  setNotificationDispatchDeps({
    getPrefs: () => deps.getConfigManager()?.getAppConfig().notifications,
    isWindowFocused: () => deps.getMainWindow()?.isFocused() ?? false,
    notify: showDesktopTaskNotification,
    log: deps.log,
  })

  // 注册所有 IPC handlers
  registerWorkspaceIpcHandlers()
  registerArtifactIpcHandlers()
  registerWindowIpcHandlers()
  registerChannelIpcHandlers()
  registerFileSystemIpcHandlers()
  registerDialogClipboardIpcHandlers()
  registerSkillsIpcHandlers()
  registerApiIpcHandlers()
  registerSettingsIpcHandlers()
  registerUserGuidesIpcHandlers()
  registerNetIpcHandlers()
}
