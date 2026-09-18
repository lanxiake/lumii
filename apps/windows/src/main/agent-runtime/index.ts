export { AgentRuntimeBridge, type AgentRuntimeBridgeConfig, type AgentLifecycleSnapshot } from './bridge'
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
