export {
  createGatewayStreamFn,
  DEFAULT_GATEWAY_STREAM_PATH,
  gatewayErrorFromHttpResponse,
  type AssistantMessageWithLlmError,
  type GatewayLlmErrorDetail,
  type GatewayStreamConfig,
  type GatewayStreamDiagnostic,
  type StreamMetadata,
} from "./gateway-stream.js";
export { ModelRouter } from "./model-router.js";
export {
  createDirectStreamFn,
  type DirectStreamCredentials,
  type CreateDirectStreamFnOptions,
} from "./direct-stream.js";
