import { PluginHost, type LoggerSink, type LumiiPluginManifest, type PluginDefinition } from '@mtbot/plugin-core'

import type { MainEvents } from './kernel/events'
import { helloExtension } from './extensions/hello'
import { perfExtension } from './extensions/perf'
import { updaterExtension } from './extensions/updater'

/**
 * 内置扩展的统一定义。
 *
 * manifest 现在只被日志和将来的 UI/守卫使用（不读磁盘）；它存在的意义是
 * 「同一份描述既能被人看，也能被机器校验」，而不是再维护一份清单。
 */
export interface BuiltinExtension {
  manifest: LumiiPluginManifest
  definition: PluginDefinition<MainEvents>
}

/** 内置扩展清单。新增一个功能 = 加一行 import + 一行条目。 */
export const BUILTIN_EXTENSIONS: BuiltinExtension[] = [helloExtension, perfExtension, updaterExtension]

/**
 * 主进程扩展宿主。
 *
 * 注意：这里**不做**权限与隔离——自用客户端，扩展与主进程同权限，
 * 见 docs/design/工程基建/2026-10-19-Lumii插件化关键决策记录.md 的 D1/D2。
 */
export function createPluginHost(
  loggerSink: LoggerSink,
  disabledIds: ReadonlySet<string> = new Set(),
): { host: PluginHost<MainEvents>; skipped: string[] } {
  const host = new PluginHost<MainEvents>({ loggerSink })
  const skipped: string[] = []

  for (const extension of BUILTIN_EXTENSIONS) {
    if (disabledIds.has(extension.manifest.id)) {
      skipped.push(extension.manifest.id)
      continue
    }
    host.register(extension.definition)
  }

  return { host, skipped }
}
