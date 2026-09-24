export { AgentRuntimeBridge } from './bridge'
export {
  installAgentRuntimeCommandIpc,
  setAgentRuntimeBridgeForIpc,
  setWeixinBindingManagerForIpc,
  setAudioTranscribeCallback,
  setIpcMainWindow,
  getAgentRuntimeBridge,
  getAcpBackendManager,
  invalidateAgentInstancesForProviderChange,
} from '../ipc/agent-runtime-ipc'
