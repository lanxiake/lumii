/**
 * `@mtbot/plugin-core` — 插件内核。
 *
 * 只做四件事：服务容器、作用域、事件、加载顺序。
 * 不含任何 Lumii 业务逻辑，不依赖 electron / DOM。
 */

// 服务与日志
export { createServiceKey, createPluginLogger, type ServiceKey, type PluginLogger, type LoggerSink } from "./types.js";

// 错误
export {
  PluginError,
  DuplicateServiceError,
  MissingServiceError,
  ScopeAlreadyDisposedError,
  PluginDependencyCycleError,
  ManifestValidationError,
} from "./errors.js";

// 作用域
export { PluginScope, type DisposeResult } from "./scope.js";

// 事件
export { EventBus, type EventMap, type Listener, type WaterfallListener, type EventBusOptions } from "./events.js";

// 上下文
export {
  ServiceContainer,
  createPluginContext,
  type PluginContext,
  type ContextDeps,
} from "./context.js";

// 清单
export {
  validateManifest,
  type LumiiPluginManifest,
  type PluginContributions,
  type ActivationEvent,
  type ValidateManifestOptions,
} from "./manifest.js";

// 加载
export {
  PluginHost,
  definePlugin,
  type PluginDefinition,
  type LoadedPlugin,
  type PluginState,
  type StartReport,
  type PluginHostOptions,
} from "./loader.js";
