import type { LumiiPluginManifest, PluginDefinition } from '@mtbot/plugin-core'

import type { MainEvents } from '../main/kernel/events'
import { helloExtension } from './builtin/hello'
import { eventLoggerExtension } from './builtin/event-logger'
import { updaterExtension } from './builtin/updater'
import { voiceExtension } from './builtin/voice'
import { petExtension } from './builtin/pet'
import { relayExtension } from './builtin/relay'
import { browserExtension } from './builtin/browser'
import { channelWeixinExtension } from './builtin/channel-weixin'
import { channelWecomExtension } from './builtin/channel-wecom'
import { channelFeishuExtension } from './builtin/channel-feishu'
import { channelQbotExtension } from './builtin/channel-qbot'
import { dashboardFeedExtension } from './builtin/dashboard-feed'
import { filePreviewExtension } from './builtin/file-preview'
import { usageExtension } from './builtin/usage'
import { vcsExtension } from './builtin/vcs'
import { selectionExtension } from './builtin/selection'
import { skillEvolutionExtension } from './builtin/skill-evolution'

/**
 * 内置扩展的统一定义。**这里是唯一的清单**：新增一个插件 = 建 `builtin/<name>/` 目录，
 * 在下面加一行 import + 一行条目。
 *
 * manifest 现在只被日志和将来的 UI/守卫使用（不读磁盘）；它存在的意义是
 * 「同一份描述既能被人看，也能被机器校验」，而不是再维护一份清单。
 */
export interface BuiltinExtension {
  manifest: LumiiPluginManifest
  definition: PluginDefinition<MainEvents>
  /**
   * 接线全部在 `apply(ctx)` 里、因此**可以在运行期启停**。
   *
   * 判据不是「这个插件有没有 apply」，而是：禁用时它的功能是不是真的消失。
   * 没标 hot 的，设置页的开关仍会要求重启——它们的初始化散在核心启动路径上。
   */
  hot?: boolean
}

export const BUILTIN_EXTENSIONS: BuiltinExtension[] = [
  { ...helloExtension, hot: false },
  { ...eventLoggerExtension, hot: false },
  // perf / cloud-sync / screen-record 是官方外部扩展，源码在 external-src/
  { ...updaterExtension, hot: false },
  { ...voiceExtension, hot: true },
  { ...petExtension, hot: true },
  { ...relayExtension, hot: true },
  { ...browserExtension, hot: true },
  { ...channelWeixinExtension, hot: true },
  { ...channelWecomExtension, hot: true },
  { ...channelFeishuExtension, hot: true },
  { ...channelQbotExtension, hot: true },
  { ...dashboardFeedExtension, hot: true },
  { ...filePreviewExtension, hot: true },
  { ...usageExtension, hot: false },
  { ...vcsExtension, hot: true },
  { ...selectionExtension, hot: true },
  { ...skillEvolutionExtension, hot: false },
]

/** 可由设置页即时启停的内置插件（由上面的 `hot` 标记派生，不再手工维护第二份清单）。 */
export const HOT_SWAPPABLE_BUILTINS: ReadonlySet<string> = new Set(
  BUILTIN_EXTENSIONS.filter((entry) => entry.hot).map((entry) => entry.manifest.id),
)
