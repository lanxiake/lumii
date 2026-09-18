export { AgentRuntimeBridge, type AgentRuntimeBridgeConfig, type AgentLifecycleSnapshot } from './bridge'
export { resolvePalaceBackend, type PalaceBackend } from './palace-backend'
export {
  installAgentRuntimeCommandIpc,
  setAgentRuntimeBridgeForIpc,
  setWeixinBindingManagerForIpc,
  setAudioTranscribeCallback,
  setIpcMainWindow,
  getAgentRuntimeBridge,
  getAcpBackendManager,
  getSessionKeyForInstance,
  invalidateAgentInstancesForProviderChange,
} from '../ipc/agent-runtime-ipc'
