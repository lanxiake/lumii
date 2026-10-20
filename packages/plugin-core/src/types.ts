/**
 * 服务标识与日志。
 *
 * 服务 key 用「带品牌类型的字符串」而不是 Symbol：
 * - 跨 bundle / 跨进程（IPC 与 manifest）都能用；
 * - 日志与调试可读；
 * - 品牌类型 `__service` 让编译器知道这个 key 对应哪个类型。
 *
 * 类型的来源是「一处集中声明」而不是 declaration merging：
 *
 * ```ts
 * export const S = {
 *   tools: createServiceKey<ToolRegistry>("tools"),
 *   llm: createServiceKey<LlmRegistry>("llm"),
 * }
 * ```
 */

export type ServiceKey<T = unknown> = string & { readonly __service?: T };

/**
 * 声明一个服务 key。
 *
 * 品牌字段是可选的，所以裸字符串也能当 key 用（`ctx.require("tools")` 可编译），
 * 但那样推不出类型；正式代码请走集中的 key 表。
 */
export function createServiceKey<T>(name: string): ServiceKey<T> {
  return name as ServiceKey<T>;
}

export interface PluginLogger {
  debug(message: string, data?: unknown): void;
  info(message: string, data?: unknown): void;
  warn(message: string, data?: unknown): void;
  error(message: string, data?: unknown): void;
}

export interface LoggerSink {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

/** 带 `[plugin:<id>]` 前缀的 logger；默认落到 console，可注入仓库既有 logger。 */
export function createPluginLogger(pluginId: string, sink?: LoggerSink): PluginLogger {
  const prefix = `[plugin:${pluginId}]`;
  const out: LoggerSink = sink ?? {
    debug: (m) => console.debug(m),
    info: (m) => console.info(m),
    warn: (m) => console.warn(m),
    error: (m) => console.error(m),
  };
  const fmt = (message: string, data?: unknown): string =>
    data === undefined ? `${prefix} ${message}` : `${prefix} ${message} ${safeStringify(data)}`;

  return {
    debug: (m, d) => out.debug(fmt(m, d)),
    info: (m, d) => out.info(fmt(m, d)),
    warn: (m, d) => out.warn(fmt(m, d)),
    error: (m, d) => out.error(fmt(m, d)),
  };
}

function safeStringify(data: unknown): string {
  try {
    return JSON.stringify(data);
  } catch {
    return String(data);
  }
}
