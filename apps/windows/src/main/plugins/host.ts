import {
  PluginHost,
  validateManifest,
  type LoggerSink,
} from '@mtbot/plugin-core'

import type { MainEvents } from '../kernel/events'
import { createIpcRegistry } from '../kernel/ipc-registry'
import { BUILTIN_EXTENSIONS } from './registry'

/**
 * 主进程扩展宿主。
 *
 * 注意：这里**不做**权限与隔离——自用客户端，扩展与主进程同权限，
 * 见 docs/design/工程基建/2026-10-19-Lumii插件化关键决策记录.md 的 D1/D2。
 */
export function createPluginHost(
  loggerSink: LoggerSink,
  disabledIds: ReadonlySet<string> = new Set(),
  appVersion?: string,
): { host: PluginHost<MainEvents>; disabled: ReadonlySet<string>; eventBus: PluginHost<MainEvents>['eventBus'] } {
  const ipcRegistry = createIpcRegistry()
  const host = new PluginHost<MainEvents>({ loggerSink, ipcRegistry })

  // 禁用的插件**也要注册**，只是启动时不激活（`host.start({ exclude })`）：
  // 这是运行时启用的前提——用户在设置页打开开关时只需要 `host.activate(id)`，
  // 不必重新 register（register 之后 id 就重复了）。
  const permanentlyDisabled = new Set(
    BUILTIN_EXTENSIONS.filter((e) => e.manifest.disabled).map((e) => e.manifest.id),
  )

  for (const extension of BUILTIN_EXTENSIONS) {
    // 清单在注册前校验：id 格式、engines、kind 与入口一致性。
    // builtin=true 是因为内置扩展静态 import 进 bundle，没有可加载的入口文件，
    // 与其让 manifest 写一个不存在的入口文件，不如如实放开这条规则。
    validateManifest(extension.manifest, { appVersion, builtin: true })
    host.register(extension.definition)
  }

  // `manifest.disabled`（如 skill-evolution）是「代码留着但别跑」：它们不进激活名单，
  // 但也没有「用户关掉」这回事，所以 UI 那边单列（见 control.ts 的 list）。
  const disabled = new Set([...disabledIds, ...permanentlyDisabled])
  return { host, disabled, eventBus: host.eventBus }
}
