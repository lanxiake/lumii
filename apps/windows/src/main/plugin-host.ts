import {
  PluginHost,
  validateManifest,
  type LoggerSink,
  type LumiiPluginManifest,
  type PluginDefinition,
} from '@mtbot/plugin-core'

import type { MainEvents } from './kernel/events'
import { createIpcRegistry } from './kernel/ipc-registry'
import { helloExtension } from './extensions/hello'
import { eventLoggerExtension } from './extensions/event-logger'
import { updaterExtension } from './extensions/updater'
import { voiceExtension } from './extensions/voice'
import { petExtension } from './extensions/pet'
import { relayExtension } from './extensions/relay'
import { browserExtension } from './extensions/browser'
import { channelWeixinExtension } from './extensions/channel-weixin'
import { channelWecomExtension } from './extensions/channel-wecom'
import { channelFeishuExtension } from './extensions/channel-feishu'
import { channelQbotExtension } from './extensions/channel-qbot'
import { dashboardFeedExtension } from './extensions/dashboard-feed'
import { filePreviewExtension } from './extensions/file-preview'
import { usageExtension } from './extensions/usage'
import { vcsExtension } from './extensions/vcs'
import { selectionExtension } from './extensions/selection'

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
export const BUILTIN_EXTENSIONS: BuiltinExtension[] = [
  helloExtension,
  eventLoggerExtension,
  // perf 已拆为官方外部扩展（官方扩展试点）：代码不再进主 bundle，见 official-extensions.ts
  updaterExtension,
  // cloud-sync / screen-record 已拆为官方外部扩展：代码不再进主 bundle，见 official-extensions.ts
  voiceExtension,
  petExtension,
  relayExtension,
  browserExtension,
  channelWeixinExtension,
  channelWecomExtension,
  channelFeishuExtension,
  channelQbotExtension,
  dashboardFeedExtension,
  filePreviewExtension,
  usageExtension,
  vcsExtension,
  selectionExtension,
]

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
): { host: PluginHost<MainEvents>; skipped: string[]; eventBus: PluginHost<MainEvents>['eventBus'] } {
  const ipcRegistry = createIpcRegistry()
  const host = new PluginHost<MainEvents>({ loggerSink, ipcRegistry })
  const skipped: string[] = []

  for (const extension of BUILTIN_EXTENSIONS) {
    // 清单在注册前校验：id 格式、engines、kind 与入口一致性。
    // builtin=true 是因为内置扩展静态 import 进 bundle，没有可加载的入口文件，
    // 与其让 manifest 写一个不存在的路径，不如如实放开这条规则。
    validateManifest(extension.manifest, { appVersion, builtin: true })

    if (disabledIds.has(extension.manifest.id)) {
      skipped.push(extension.manifest.id)
      continue
    }
    host.register(extension.definition)
  }

  return { host, skipped, eventBus: host.eventBus }
}
