export { AgentRuntimeBridge, type AgentRuntimeBridgeConfig } from './bridge'
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
