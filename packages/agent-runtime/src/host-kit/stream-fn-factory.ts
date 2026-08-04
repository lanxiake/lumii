/**
 * streamFn 工厂 — 按 ResolvedModel.streamFnKind 产出对应 streamFn
 *
 * 设计依据: .qoder/design/client-agent-runtime/2026-06-26-agent-standalone-v2-design.md §2.2 / §4b
 *
 * 阶段 A 只实现 gateway 分支（包装现有 createGatewayStreamFn，逻辑搬运自
 * apps/windows bridge-instance-factory.ts 行 197-257，metadata / diagnostic
 * 回调改为按 StreamFnContext 注入）。
 * direct 分支阶段 B 接入（pi-ai streamProxy 直连本地 / 自定义 provider）。
 */

import type { Model } from "@mariozechner/pi-ai";
import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createGatewayStreamFn,
  DEFAULT_GATEWAY_STREAM_PATH,
  type StreamMetadata,
  type GatewayStreamDiagnostic,
} from "../llm/gateway-stream.js";
import {
  createDirectStreamFn,
  type DirectStreamCredentials,
} from "../llm/direct-stream.js";
import type {
  ResolvedModel,
  StreamFnContext,
  StreamFnFactory,
} from "./types.js";

/**
 * gateway 工厂的宿主注入配置。
 *
 * 凭据 / 端点 / 认证由宿主提供；动态元数据（thinking、channel 等）通过
 * getMetadataExtras 注入，host-kit 负责把 StreamFnContext 的基础字段
 * （sessionId/runId/purpose/agentId/agentName）填好。
 */
export interface GatewayStreamFnFactoryConfig {
  /** 网关基础 URL */
  readonly gatewayUrl: string;
  /** 流式端点路径，默认 {@link DEFAULT_GATEWAY_STREAM_PATH} */
  readonly streamPath?: string;
  /** 获取认证 Token */
  readonly getAuthToken: () => Promise<string>;
  /** 获取设备 ID（X-Device-Id 头） */
  readonly getDeviceId?: () => string | undefined;
  /** 脱敏日志 */
  readonly log?: (msg: string) => void;
  /** 宿主提供的动态元数据补充（thinking / channel 等），与 ctx 基础字段合并 */
  readonly getMetadataExtras?: (ctx: StreamFnContext) => Partial<StreamMetadata>;
  /** 重试 / 降级遥测（携带 ctx 便于宿主定向转发） */
  readonly onDiagnostic?: (ctx: StreamFnContext, info: GatewayStreamDiagnostic) => void;
  /** LLM 请求即将发出（fetch 前） */
  readonly onLlmRequestStart?: (ctx: StreamFnContext) => void;
  /** 首个文本 token 到达 */
  readonly onLlmFirstToken?: (ctx: StreamFnContext) => void;
  /** 对可重试 HTTP 错误尝试一次备用模型 */
  readonly retryWithFallback?: boolean;
  /** 主模型失败且可重试时返回备用模型 */
  readonly getFallbackModel?: (failed: Model<string>) => Model<string> | undefined;
}

/**
 * 创建 gateway 分支的 streamFn 工厂。
 *
 * 产出的 StreamFn 是 createGatewayStreamFn 的忠实包装：遵循 pi-agent-core 的
 * streamFn 契约，使用「调用时传入的模型」。模型权威来源由调用方决定——
 * - 宿主把 resolved.model 作为默认模型注入 registry.create，pi 即以此调用；
 * - Windows 现存的 per-session 覆盖包装器仍可在外层换模，零行为变化。
 *
 * resolved.model 在此仅作为 onDiagnostic / 日志的解析结果上下文，不强制覆盖
 * 调用时模型，避免破坏外层覆盖逻辑。
 */
export function createGatewayStreamFnFactory(
  config: GatewayStreamFnFactoryConfig,
): StreamFnFactory {
  return {
    create(_resolved: ResolvedModel, ctx: StreamFnContext): StreamFn {
      return createGatewayStreamFn({
        gatewayUrl: config.gatewayUrl,
        streamPath: config.streamPath ?? DEFAULT_GATEWAY_STREAM_PATH,
        getAuthToken: config.getAuthToken,
        getDeviceId: config.getDeviceId,
        log: config.log,
        getMetadata: () => ({
          sessionId: ctx.sessionKey,
          runId: ctx.runId,
          purpose: ctx.purpose,
          agentId: ctx.agentId,
          agentName: ctx.agentName,
          ...(config.getMetadataExtras?.(ctx) ?? {}),
        }),
        onDiagnostic: config.onDiagnostic
          ? (info) => config.onDiagnostic?.(ctx, info)
          : undefined,
        onLlmRequestStart: config.onLlmRequestStart
          ? () => config.onLlmRequestStart?.(ctx)
          : undefined,
        onLlmFirstToken: config.onLlmFirstToken
          ? () => config.onLlmFirstToken?.(ctx)
          : undefined,
        retryWithFallback: config.retryWithFallback,
        getFallbackModel: config.getFallbackModel,
      });
    },
  };
}

/** direct 工厂的宿主注入配置（本地 / 自定义 provider 凭据） */
export interface DirectStreamFnFactoryConfig {
  /**
   * 按 provider 来源解析直连凭据（host 本地，永不下发客户端）。
   * resolved.providerSource 为 "local" / "custom" 时调用。
   */
  readonly resolveCredentials: (resolved: ResolvedModel) => DirectStreamCredentials;
  /** 脱敏日志 */
  readonly log?: (msg: string) => void;
}

/**
 * 创建 direct 分支的 streamFn 工厂（pi-ai streamSimple 直连本地 / 自定义 provider）。
 *
 * 凭据按 resolved 来源解析（host 本地持有），注入 createDirectStreamFn。
 * 未提供配置时返回占位工厂（命中即抛错），保持阶段 A 行为。
 */
export function createDirectStreamFnFactory(
  config?: DirectStreamFnFactoryConfig,
): StreamFnFactory {
  return {
    create(resolved: ResolvedModel, _ctx: StreamFnContext): StreamFn {
      if (!config) {
        throw new Error("direct stream not configured (provide DirectStreamFnFactoryConfig)");
      }
      return createDirectStreamFn({
        credentials: config.resolveCredentials(resolved),
        log: config.log,
      });
    },
  };
}

/**
 * 顶层 streamFn 工厂：按 resolved.streamFnKind 分派到 gateway / direct。
 *
 * 宿主提供 gateway 配置；direct 配置可选（agent-host 阶段 B 接入，
 * Windows bridge 不传则 direct 命中即抛错，行为不变）。
 */
export function createStreamFnFactory(deps: {
  readonly gateway: GatewayStreamFnFactoryConfig;
  readonly direct?: DirectStreamFnFactoryConfig;
}): StreamFnFactory {
  const gateway = createGatewayStreamFnFactory(deps.gateway);
  const direct = createDirectStreamFnFactory(deps.direct);
  return {
    create(resolved: ResolvedModel, ctx: StreamFnContext): StreamFn {
      switch (resolved.streamFnKind) {
        case "gateway":
          return gateway.create(resolved, ctx);
        case "direct":
          return direct.create(resolved, ctx);
        default: {
          const exhaustive: never = resolved.streamFnKind;
          throw new Error(`unknown streamFnKind: ${String(exhaustive)}`);
        }
      }
    },
  };
}
