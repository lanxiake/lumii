/**
 * streamFn 工厂 — 产出本地直连 streamFn
 *
 * 设计依据: .qoder/design/client-agent-runtime/2026-06-26-agent-standalone-v2-design.md §2.2 / §4b
 */

import type { StreamFn } from "@mariozechner/pi-agent-core";
import {
  createDirectStreamFn,
  type DirectStreamCredentials,
} from "../llm/direct-stream.js";
import type {
  ResolvedModel,
  StreamFnContext,
  StreamFnFactory,
} from "./types.js";

/** direct 工厂的宿主注入配置（本地 / 自定义 provider 凭据） */
export interface DirectStreamFnFactoryConfig {
  /**
   * 按 provider 来源解析直连凭据（host 本地持有，永不下发客户端）。
   */
  readonly resolveCredentials: (resolved: ResolvedModel) => DirectStreamCredentials;
  /** 脱敏日志 */
  readonly log?: (msg: string) => void;
}

/**
 * 创建直连 streamFn 工厂（pi-ai streamSimple 直连本地 / 自定义 provider）。
 *
 * 凭据按 resolved 来源解析（host 本地持有），注入 createDirectStreamFn。
 */
export function createDirectStreamFnFactory(
  config: DirectStreamFnFactoryConfig,
): StreamFnFactory {
  return {
    create(resolved: ResolvedModel, _ctx: StreamFnContext): StreamFn {
      return createDirectStreamFn({
        credentials: config.resolveCredentials(resolved),
        log: config.log,
      });
    },
  };
}

/**
 * 顶层 streamFn 工厂：产出直连 streamFn。
 */
export function createStreamFnFactory(config: DirectStreamFnFactoryConfig): StreamFnFactory {
  return createDirectStreamFnFactory(config);
}
