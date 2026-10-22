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
import { skillEvolutionExtension } from './extensions/skill-evolution'

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
  skillEvolutionExtension,
]

/**
 * 接线全部在 `apply(ctx)` 里、因此**可以在运行期启停**的内置插件。
 *
 * 判据不是「这个插件有没有 apply」，而是：禁用时它的功能是不是真的消失。
 * 没进这张表的内置插件，设置页的开关仍会要求重启——它们的初始化散在核心启动路径上
 * （渠道适配器要先建登录服务、语音的 ONNX 顺序闸不可逆等）。
 *
 * 迁移一个插件 = 把接线搬进 apply（`ctx.registerIpc` / `ctx.effect`），然后加到这里。
 */
export const HOT_SWAPPABLE_BUILTINS: ReadonlySet<string> = new Set([
  'com.lumii.vcs',
  'com.lumii.selection',
  'com.lumii.file-preview',
  'com.lumii.dashboard-feed',
  'com.lumii.relay',
  'com.lumii.browser',
  'com.lumii.pet',
  'com.lumii.voice',
])

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
    // 与其让 manifest 写一个不存在的路径，不如如实放开这条规则。
    validateManifest(extension.manifest, { appVersion, builtin: true })
    host.register(extension.definition)
  }

  const disabled = new Set([...disabledIds].filter((id) => !permanentlyDisabled.has(id)))
  return { host, disabled, eventBus: host.eventBus }
}
