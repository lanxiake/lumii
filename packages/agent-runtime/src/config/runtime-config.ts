/**
 * Agent Runtime 运行时配置
 */

import type { AgentRuntimeFeatureFlags } from "./feature-flags.js";
import type { ToolExecutionContext } from "../types/tool.js";

export interface AgentRuntimeConfig {
  /** Gateway URL (例如 "https://gw.mtbot.top" 或 "http://localhost:18789") */
  readonly gatewayUrl: string;

  /** 获取认证 Token 的异步函数 */
  readonly getAuthToken: () => Promise<string>;

  /** Feature Flags */
  readonly featureFlags: AgentRuntimeFeatureFlags;

  /** 工具执行上下文 — 由平台层注入 */
  readonly toolContext?: ToolExecutionContext;

  /** 默认工作目录 */
  readonly workingDirectory?: string;
}
