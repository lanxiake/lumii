export {
  createGatewayStreamFn,
  DEFAULT_GATEWAY_STREAM_PATH,
  gatewayErrorFromHttpResponse,
  type AssistantMessageWithLlmError,
  type GatewayStreamConfig,
  type GatewayStreamDiagnostic,
  type StreamMetadata,
} from "./gateway-stream.js";
export {
  describeLlmError,
  inferHttpStatusFromMessage,
  isRetryableHttpStatus,
  llmErrorCodeFromHttpStatus,
  normalizeLlmError,
  type GatewayLlmErrorDetail,
  type LlmErrorDetail,
  type NormalizeLlmErrorOptions,
} from "./llm-error.js";
export { ModelRouter } from "./model-router.js";
export {
  createDirectStreamFn,
  type DirectStreamCredentials,
  type CreateDirectStreamFnOptions,
} from "./direct-stream.js";
