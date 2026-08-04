/**
 * agent-host 协议子模块 — barrel
 *
 * 复用现有网关帧模型（RequestFrame/ResponseFrame/EventFrame，见 schema/frames.ts）：
 * - 客户端 → host：method 承载在 RequestFrame.method，参数承载在 RequestFrame.params
 * - host → 客户端：协议事件承载在 EventFrame.payload（payload.event 判别）
 *
 * 本模块只新增 agent-host **专属** 的 params / events / methods 类型，
 * 经 src/gateway/protocol/index.ts 与 @mtbot/protocol 再导出。
 *
 * 输入 params 属不可信 stdio 输入 → 提供 AJV 校验器；
 * 输出 events 由 host 产出 → 仅静态类型，无需校验。
 *
 * 设计依据: .qoder/design/client-agent-runtime/2026-06-26-agent-standalone-v2-design.md §3 / §4c
 * 计划依据: .qoder/plan/2026-06-26-plan-B-agent-host.md §B0
 */

import AjvPkg from "ajv";

import {
  SessionCreateParamsSchema,
  SessionPromptParamsSchema,
  SessionSteerParamsSchema,
  SessionControlParamsSchema,
  PermissionRespondParamsSchema,
  type SessionCreateParams,
  type SessionPromptParams,
  type SessionSteerParams,
  type SessionControlParams,
  type PermissionRespondParams,
} from "./params.js";

// ── 类型再导出 ────────────────────────────────────────────────────────────────

export type {
  ProviderSourceDto,
  ModelOverrideDto,
  ConfigOverrideDto,
  SessionCreateParams,
  PromptImage,
  SessionPromptParams,
  SessionSteerParams,
  SessionControlParams,
  SessionAbortParams,
  SessionResumeParams,
  SessionDestroyParams,
  PermissionDecisionDto,
  PermissionRespondParams,
} from "./params.js";

export {
  ProviderSourceSchema,
  ModelOverrideSchema,
  ConfigOverrideSchema,
  SessionCreateParamsSchema,
  PromptImageSchema,
  SessionPromptParamsSchema,
  SessionSteerParamsSchema,
  SessionControlParamsSchema,
  PermissionDecisionSchema,
  PermissionRespondParamsSchema,
} from "./params.js";

export {
  PROTOCOL_EVENTS,
  type ProtocolEventName,
  type ProtocolUsage,
  type ProtocolInjectedMemory,
  type ProtocolStopReason,
  type RunStartedEvent,
  type RunFinishedEvent,
  type RunErrorEvent,
  type TextStartEvent,
  type TextDeltaEvent,
  type TextEndEvent,
  type ToolStartEvent,
  type ToolArgsEvent,
  type ToolResultEvent,
  type ToolEndEvent,
  type StateDeltaEvent,
  type StateSnapshotEvent,
  type InterruptPermissionEvent,
  type TaskSpawnedEvent,
  type TaskProgressEvent,
  type TaskCompletedEvent,
  type AgentWaitingEvent,
  type ProtocolEvent,
} from "./events.js";

export {
  AGENT_HOST_METHODS,
  type AgentHostMethod,
  type SessionCreateResult,
} from "./methods.js";

// ── AJV 校验器（不可信 stdio 输入）─────────────────────────────────────────────

const ajv = new (AjvPkg as unknown as new (opts?: object) => import("ajv").default)({
  allErrors: true,
  strict: false,
  removeAdditional: false,
});

export const validateSessionCreateParams =
  ajv.compile<SessionCreateParams>(SessionCreateParamsSchema);
export const validateSessionPromptParams =
  ajv.compile<SessionPromptParams>(SessionPromptParamsSchema);
export const validateSessionSteerParams =
  ajv.compile<SessionSteerParams>(SessionSteerParamsSchema);
export const validateSessionControlParams =
  ajv.compile<SessionControlParams>(SessionControlParamsSchema);
export const validatePermissionRespondParams =
  ajv.compile<PermissionRespondParams>(PermissionRespondParamsSchema);
