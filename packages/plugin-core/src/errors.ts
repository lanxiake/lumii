/**
 * plugin-core 的错误类型。
 *
 * 设计：错误必须自带 pluginId —— 多插件同进程运行时，光看 message 无法定位是谁。
 */

export class PluginError extends Error {
  constructor(
    readonly pluginId: string,
    message: string,
  ) {
    super(`[${pluginId}] ${message}`);
    this.name = "PluginError";
  }
}

export class DuplicateServiceError extends PluginError {
  constructor(pluginId: string, serviceKey: string) {
    super(pluginId, `service "${serviceKey}" 已被注册，不允许重复 provide`);
    this.name = "DuplicateServiceError";
  }
}

export class MissingServiceError extends PluginError {
  constructor(pluginId: string, serviceKey: string) {
    super(pluginId, `依赖的服务 "${serviceKey}" 不存在`);
    this.name = "MissingServiceError";
  }
}

export class ScopeAlreadyDisposedError extends PluginError {
  constructor(pluginId: string) {
    super(pluginId, "作用域已销毁，不能再注册 effect");
    this.name = "ScopeAlreadyDisposedError";
  }
}

export class PluginDependencyCycleError extends PluginError {
  constructor(pluginId: string, cycle: string[]) {
    super(pluginId, `插件依赖成环：${cycle.join(" -> ")}`);
    this.name = "PluginDependencyCycleError";
  }
}

/** manifest 校验失败。issues 是全部问题，不是第一个。 */
export class ManifestValidationError extends Error {
  constructor(readonly issues: string[]) {
    super(`manifest 校验失败：\n- ${issues.join("\n- ")}`);
    this.name = "ManifestValidationError";
  }
}
