/**
 * 客户端 Agent Runtime API（全部经 agent-runtime:command，与 M08 Preload 审计一致）
 */
import { ipcRenderer } from 'electron'

function createEventListener(channel: string, callback: (...args: unknown[]) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]) => {
    callback(...args)
  }
  ipcRenderer.on(channel, listener)
  return () => {
    ipcRenderer.removeListener(channel, listener)
  }
}

const send = (command: unknown) => ipcRenderer.invoke('agent-runtime:command', command)

export const agentRuntimeApi = {
  getFeatureFlags: () => send({ type: 'runtime:featureFlags:get' }),
  setFeatureFlags: (flags: Record<string, boolean>) =>
    send({ type: 'runtime:featureFlags:set', flags }),
  isEnabled: () => send({ type: 'runtime:enabled' }),
  createInstance: (agentDef?: unknown) =>
    send({ type: 'agentInstance:create', agentDef }),
  createInstanceById: (agentId: string) =>
    send({ type: 'agentInstance:createById', agentId }),
  getDefinitionSyncStatus: () => send({ type: 'agentDefinition:syncStatus' }),
  syncUserAgentDefinitions: () => send({ type: 'agentDefinition:syncUserAgents' }),
  listCachedAgentDefinitions: () => send({ type: 'agentDefinition:cacheList' }),
  removeCachedAgentDefinition: (agentId: string) =>
    send({ type: 'agentDefinition:cacheRemove', agentId }),
  clearCachedAgentsOlderThan: (cutoffIso: string) =>
    send({ type: 'agentDefinition:cacheClearOlder', cutoffIso }),
  clearAllCachedAgentDefinitions: () =>
    send({ type: 'agentDefinition:cacheClearAll' }),
  refreshCachedAgentDefinition: (agentId: string) =>
    send({ type: 'agentDefinition:cacheRefresh', agentId }),
  prompt: (instanceId: string, message: string) =>
    send({ type: 'agentInstance:prompt', instanceId, message }),
  abort: (instanceId: string) =>
    send({ type: 'agentInstance:abort', instanceId }),
  destroy: (instanceId: string) =>
    send({ type: 'agentInstance:destroy', instanceId }),
  getInstances: () => send({ type: 'agentInstance:list' }),
  getLifecycleSnapshot: (definitionId: string) =>
    send({ type: 'agentInstance:lifecycleSnapshot', definitionId }),
  onEvent: (callback: (event: unknown) => void) => {
    const listenerCountBefore = ipcRenderer.listenerCount('agent-runtime:event')
    console.log('[Preload] onEvent 注册 agent-runtime:event, 注册前监听器数量:', listenerCountBefore, new Error('stack').stack?.split('\n').slice(1, 4).join(' | '))
    const unsub = createEventListener('agent-runtime:event', (evt: unknown) => {
      const listenerCount = ipcRenderer.listenerCount('agent-runtime:event')
      const evtType = evt && typeof evt === 'object' && 'type' in evt ? (evt as { type: string }).type : 'unknown'
      if (evtType === 'conversation:message:new' || evtType === 'agent:idle' || evtType === 'agent:turn:start') {
        console.log(`[Preload] onEvent 分发 type=${evtType} 当前监听器数量:`, listenerCount)
      }
      callback(evt)
    })
    return () => {
      console.log('[Preload] onEvent 注销 agent-runtime:event')
      unsub()
    }
  },
  sendCommand: send,
  onEventType: (eventType: string, handler: (event: unknown) => void) => {
    const listenerCountBefore = ipcRenderer.listenerCount('agent-runtime:event')
    console.log('[Preload] onEventType 注册 agent-runtime:event, eventType:', eventType, '注册前监听器数量:', listenerCountBefore, new Error('stack').stack?.split('\n').slice(1, 4).join(' | '))
    const listener = (_ipcEvt: Electron.IpcRendererEvent, evt: unknown) => {
      if (evt && typeof evt === 'object' && 'type' in evt && (evt as { type: string }).type === eventType) {
        handler(evt)
      }
    }
    ipcRenderer.on('agent-runtime:event', listener)
    return () => {
      console.log('[Preload] onEventType 注销 agent-runtime:event, eventType:', eventType)
      ipcRenderer.removeListener('agent-runtime:event', listener)
    }
  },
  isAvailable: () =>
    send({ type: 'runtime:ping' }).then(() => true).catch(() => false),
  getLocalStorageStats: () => send({ type: 'storage:stats' }),
  exportLocalDataJSONL: () => send({ type: 'storage:exportJsonl' }),
  clearMalformedMessages: () => send({ type: 'storage:clearMalformed' }),
  listDatabaseBackups: () => send({ type: 'storage:listBackups' }),
  createDatabaseBackup: () => send({ type: 'storage:createBackup' }),
  restoreDatabaseFromBackup: (backupFileName: string) =>
    send({ type: 'storage:restoreBackup', backupFileName }),
  restoreDatabaseFromLatestBackup: () => send({ type: 'storage:restoreLatestBackup' }),
  deleteDatabaseBackup: (backupFileName: string) =>
    send({ type: 'storage:deleteBackup', backupFileName }),
}
