/**
 * 插件依赖（反检测浏览器）启动预安装默认配置。
 */

/** 默认启动时自动下载 CloakBrowser（设为 0 可跳过） */
export const DEFAULT_LUMII_CLOAK_BROWSER_BOOTSTRAP = '1'

/**
 * 写入插件预安装相关环境变量默认值（仅当用户未配置时生效）。
 * 应在主进程尽早调用，早于启动预安装逻辑。
 */
export function applyPluginBootstrapEnvDefaults(): void {
  if (
    process.env.LUMII_CLOAK_BROWSER_BOOTSTRAP === undefined
    || process.env.LUMII_CLOAK_BROWSER_BOOTSTRAP === ''
  ) {
    process.env.LUMII_CLOAK_BROWSER_BOOTSTRAP = DEFAULT_LUMII_CLOAK_BROWSER_BOOTSTRAP
  }
}

/**
 * 是否启用 CloakBrowser 启动预下载（国内镜像）。
 */
export function isCloakBrowserBootstrapEnabled(): boolean {
  return process.env.LUMII_SKIP_PLUGIN_BOOTSTRAP !== '1'
    && process.env.LUMII_CLOAK_BROWSER_BOOTSTRAP !== '0'
}
