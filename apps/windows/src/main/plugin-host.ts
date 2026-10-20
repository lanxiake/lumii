import { PluginHost, type LoggerSink } from '@mtbot/plugin-core'

import { helloExtension } from './extensions/hello'

/**
 * 主进程扩展宿主。
 *
 * P0 只挂一个 hello 示例，验证内核在真实启动路径里可用；后续内置扩展
 * （云同步、语音、录屏……）按 `extensions/<id>.ts` 逐个注册进来。
 *
 * 注意：这里**不做**权限与隔离——自用客户端，扩展与主进程同权限，
 * 这是 docs/design/工程基建/2026-10-19-Lumii插件化关键决策记录.md 里 D1/D2 的选择。
 */
export function createPluginHost(loggerSink: LoggerSink): PluginHost {
  const host = new PluginHost({ loggerSink })
  host.register(helloExtension)
  return host
}
