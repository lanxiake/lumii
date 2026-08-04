/**
 * @mtbot/client-sdk — 跨平台（Node / 浏览器）共享的网关客户端原语。
 *
 * - request-registry: 请求-响应关联表（纯逻辑，无副作用）
 * - gateway-client: Gateway WebSocket 客户端（协议 v3 握手、重连、心跳）
 *
 * 传输层（Node `ws` vs 浏览器 `WebSocket`）通过 SocketFactory 注入，
 * 两端真实差异的部分保持在各 app 内，不强行抽象。
 */
export * from "./request-registry.js";
export * from "./gateway-client.js";
