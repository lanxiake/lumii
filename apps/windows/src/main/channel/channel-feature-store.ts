/**
 * channel-feature-store — 渠道实验性功能开关（主进程）
 *
 * 设计依据：docs/design/2026-09-09-user-presence-channel-design.md §5.4（P2 跨渠道连续性）
 *
 * 跨渠道接续是实验性行为（会主动向用户发一条询问），必须可关。
 * 同步读写（数据量极小）+ 模块级缓存，渠道 adapter 可直接同步读，
 * 不走 localStorage：渠道消息按 webhook/长连接时序到达，与窗口存活无关。
 */

import { app } from 'electron'
import { join } from 'node:path'
import fs from 'node:fs'

const log = {
  info: (...args: unknown[]) => console.log('[channel-feature-store]', ...args),
  warn: (...args: unknown[]) => console.warn('[channel-feature-store]', ...args),
}

export interface ChannelFeatureSettings {
  /** 跨渠道会话接续询问（§5.4）：默认关（实验性，会主动发询问消息） */
  crossChannelContinuityEnabled: boolean
}

export const DEFAULT_CHANNEL_FEATURES: ChannelFeatureSettings = {
  crossChannelContinuityEnabled: false,
}

let cache: ChannelFeatureSettings | null = null

function storePath(): string {
  return join(app.getPath('userData'), 'channel-features.json')
}

/** 读取存储（带内存缓存 + 默认值容错） */
function load(): ChannelFeatureSettings {
  if (cache) return cache
  try {
    const raw = fs.readFileSync(storePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<ChannelFeatureSettings>
    cache = { ...DEFAULT_CHANNEL_FEATURES, ...parsed }
  } catch {
    cache = { ...DEFAULT_CHANNEL_FEATURES }
  }
  return cache
}

/** 读取渠道功能开关。同步，adapter 内可直接调用 */
export function getChannelFeatures(): ChannelFeatureSettings {
  return { ...load() }
}

/** 合并写入渠道功能开关（patch），返回合并后的完整设置 */
export function setChannelFeatures(
  patch: Partial<ChannelFeatureSettings>,
): ChannelFeatureSettings {
  const merged: ChannelFeatureSettings = { ...load(), ...patch }
  cache = merged
  try {
    fs.writeFileSync(storePath(), JSON.stringify(merged, null, 2), 'utf-8')
  } catch (err) {
    log.warn(`[setChannelFeatures] 写入失败: ${err instanceof Error ? err.message : err}`)
  }
  log.info(`[setChannelFeatures] 已更新: ${JSON.stringify(patch)}`)
  return merged
}
