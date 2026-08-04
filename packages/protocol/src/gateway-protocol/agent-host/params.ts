/**
 * agent-host 输入参数契约（客户端 → host，method params）
 *
 * 复用现有网关帧模型：这些 params 承载在 `RequestFrame.params` 里，
 * 经 stdio 从客户端传入 host，属**不可信输入**，必须 TypeBox + AJV 校验。
 *
 * 设计依据: .qoder/design/client-agent-runtime/2026-06-26-agent-standalone-v2-design.md §3.2 / §4c.3
 * 计划依据: .qoder/plan/2026-06-26-plan-B-agent-host.md §B0
 *
 * 安全不变量（§四）：客户端 override 只能选「用哪个 model / 开哪些工具」，
 * **不能携带或读取 API key / baseURL**——故 ModelOverride / ConfigOverride 不含凭据字段。
 */

import { Type, type Static } from "@sinclair/typebox";
import { NonEmptyString } from "../schema/primitives.js";

// ── provider 来源（与 host-kit ProviderSource 对齐）──────────────────────────

/** provider 来源：云端（默认）/ 本地 / 自定义 */
export const ProviderSourceSchema = Type.Union(
  [Type.Literal("cloud"), Type.Literal("local"), Type.Literal("custom")],
  { default: "cloud" },
);
export type ProviderSourceDto = Static<typeof ProviderSourceSchema>;

// ── 模型覆盖（仅选择，不含凭据）───────────────────────────────────────────────

/**
 * 客户端可下发的模型覆盖：只能「选模型 / 选 provider 来源」，
 * 不接受 apiKey / baseUrl 等敏感字段（凭据只在 host）。
 */
export const ModelOverrideSchema = Type.Object(
  {
    /** 显式模型 id 或 "providerKey/modelId" */
    modelRef: Type.Optional(NonEmptyString),
    /** 指定 provider 来源（须为 host 已配置的来源） */
    providerSource: Type.Optional(ProviderSourceSchema),
  },
  { additionalProperties: false },
);
export type ModelOverrideDto = Static<typeof ModelOverrideSchema>;

// ── 配置覆盖（session 级）─────────────────────────────────────────────────────

/**
 * 客户端会话级配置覆盖：合并到 host 默认之上。
 * 允许选模型 / 开关部分工具 / thinking 偏好；禁止注入凭据。
 */
export const ConfigOverrideSchema = Type.Object(
  {
    /** 模型覆盖（透传给 ConfigProvider.resolveModel） */
    model: Type.Optional(ModelOverrideSchema),
    /** feature flags 覆盖（工具开关等，按 key 合并） */
    featureFlags: Type.Optional(Type.Record(NonEmptyString, Type.Boolean())),
    /** thinking 偏好（如 "off" / "low" / "high"） */
    thinkingLevel: Type.Optional(NonEmptyString),
  },
  { additionalProperties: false },
);
export type ConfigOverrideDto = Static<typeof ConfigOverrideSchema>;

// ── session.create ────────────────────────────────────────────────────────────

export const SessionCreateParamsSchema = Type.Object(
  {
    /** Agent 定义 id（决定人格 / 工具集 / 默认 purpose） */
    agentId: NonEmptyString,
    /** 会话 key（缺省由 host 生成，用于 storage 寻址 + resume） */
    sessionKey: Type.Optional(NonEmptyString),
    /** 用户 id（记忆作用域，可选） */
    userId: Type.Optional(NonEmptyString),
    /** 会话级配置覆盖 */
    configOverride: Type.Optional(ConfigOverrideSchema),
  },
  { additionalProperties: false },
);
export type SessionCreateParams = Static<typeof SessionCreateParamsSchema>;

// ── session.prompt ──────────────────────────────────────────────────────────

/** 单张图片输入（base64 单行传输，避免 stdio 粘包） */
export const PromptImageSchema = Type.Object(
  {
    /** base64 编码的图片数据（不含 data: 前缀） */
    base64: NonEmptyString,
    /** MIME 类型（如 image/png） */
    mimeType: NonEmptyString,
  },
  { additionalProperties: false },
);
export type PromptImage = Static<typeof PromptImageSchema>;

export const SessionPromptParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    /** 用户消息文本 */
    text: Type.String(),
    /** 可选图片（base64 单行） */
    images: Type.Optional(Type.Array(PromptImageSchema)),
  },
  { additionalProperties: false },
);
export type SessionPromptParams = Static<typeof SessionPromptParamsSchema>;

// ── session.steer（中途插话）────────────────────────────────────────────────

export const SessionSteerParamsSchema = Type.Object(
  {
    sessionId: NonEmptyString,
    text: Type.String(),
  },
  { additionalProperties: false },
);
export type SessionSteerParams = Static<typeof SessionSteerParamsSchema>;

// ── session.abort / resume / destroy（仅 sessionId）──────────────────────────

export const SessionControlParamsSchema = Type.Object(
  { sessionId: NonEmptyString },
  { additionalProperties: false },
);
export type SessionControlParams = Static<typeof SessionControlParamsSchema>;

// 语义别名（同 shape，便于调用方按方法名取类型）
export type SessionAbortParams = SessionControlParams;
export type SessionResumeParams = SessionControlParams;
export type SessionDestroyParams = SessionControlParams;

// ── permission.respond ────────────────────────────────────────────────────────

/** 权限决定（对齐 host-kit PermissionDecisionOutcome） */
export const PermissionDecisionSchema = Type.Union([
  Type.Literal("allow-once"),
  Type.Literal("allow-always"),
  Type.Literal("deny"),
]);
export type PermissionDecisionDto = Static<typeof PermissionDecisionSchema>;

export const PermissionRespondParamsSchema = Type.Object(
  {
    /** 与 interrupt.permission 事件的 requestId 配对 */
    requestId: NonEmptyString,
    decision: PermissionDecisionSchema,
  },
  { additionalProperties: false },
);
export type PermissionRespondParams = Static<typeof PermissionRespondParamsSchema>;
