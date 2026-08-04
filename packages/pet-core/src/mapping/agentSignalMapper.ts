/**
 * agentSignalMapper — Agent 语义信号 → PetEvent（pet-core，纯函数）
 *
 * 各端事件协议不同（kids-mobile 的 MobileNodeEvent、Windows 的 pet-bus 事件），
 * 故 pet-core 不直接依赖任一端协议类型，而是定义**归一语义信号** AgentSignal，
 * 各端 adapter 把自己的事件转成 AgentSignal 后交给本函数映射为 PetEvent 驱动状态机。
 *
 * 错误分流：仅网络类错误映射为 NETWORK_ERROR（可 RETRY 自愈），其余错误返回 null，
 * 由 UI 用宠物语气提示，不强制切状态机。
 */

import type { PetEvent } from "../state/petStateMachine.js";

/** 归一的 Agent 语义信号（各端 adapter 产出） */
export type AgentSignal =
  | { readonly kind: "delta" }
  | { readonly kind: "final" }
  | { readonly kind: "safety_blocked" }
  | { readonly kind: "error"; readonly code?: string }
  | { readonly kind: "tts_failed" }
  /** 不驱动状态机的信号（由 UI 单独消费），各端可统一透传为 noop */
  | { readonly kind: "noop" };

/** 判定为网络类错误的 code（大小写不敏感，含常见 errno 与业务分类） */
const NETWORK_ERROR_CODES: ReadonlySet<string> = new Set([
  "econn",
  "econnrefused",
  "econnreset",
  "etimedout",
  "enetunreach",
  "enotfound",
  "network_error",
  "gateway_timeout",
  "stream_error",
]);

/** code 是否属于网络类错误 */
export function isNetworkErrorCode(code?: string): boolean {
  if (!code) return false;
  return NETWORK_ERROR_CODES.has(code.toLowerCase());
}

/**
 * 将归一语义信号映射为状态机事件；不驱动状态机的信号返回 null。
 */
export function mapAgentSignalToPetEvent(signal: AgentSignal): PetEvent | null {
  switch (signal.kind) {
    case "delta":
      return { type: "AGENT_DELTA" };
    case "final":
      return { type: "AGENT_FINAL" };
    case "safety_blocked":
      return { type: "SAFETY_BLOCKED" };
    case "tts_failed":
      return { type: "TTS_FAILED" };
    case "error":
      return isNetworkErrorCode(signal.code) ? { type: "NETWORK_ERROR" } : null;
    case "noop":
      return null;
    default:
      return null;
  }
}
