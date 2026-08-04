export { AgentRuntimeBridge, type AgentRuntimeBridgeConfig, type AgentLifecycleSnapshot } from './bridge'
export {
  registerAgentRuntimeIPC,
  installAgentRuntimeCommandIpc,
  setAgentRuntimeBridgeForIpc,
  setWeixinBindingManagerForIpc,
  setAudioTranscribeCallback,
  setIpcMainWindow,
  getAcpBackendManager,
  getSessionKeyForInstance,
} from '../ipc/agent-runtime-ipc'
