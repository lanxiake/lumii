/**
 * channel-policy-store — 渠道绑定级策略的落盘（主进程）
 *
 * 形状 `{ [channelType]: ChannelPolicy }`（定义在 `shared/channel-policy.ts`），
 * 落在 `~/.lumii/channel/channel-policies.json`。
 *
 * 为什么在这里而不是 `wechat-watch.json`：策略从「盯梢循环的内部配置」变成了**渠道的能力**
 * （飞书/QQ 一样要「这个人自动回、那个只提醒」），归属地就该跟 `channel-peers.json` 一起
 * 放在渠道层。旧 json 的 groups/blacklist 从此只在**首次播种**时读一次
 * （见 `wechat-watch-tick.ts` 的 `policyFromWatchConfig`），之后本文件是唯一真源。
 *
 * 同进程独占（主进程单例），所以只有「原子写」这一个并发问题：tmp + rename，
 * 免得盯梢那一拍读到半截文件。
 */

import fs from 'node:fs'
import path from 'node:path'
import { resolveWindowsClientDataRoot } from '../client-data-root'
import {
  DEFAULT_CHANNEL_POLICY,
  parseChannelPolicy,
  type ChannelPolicy,
} from '../../shared/channel-policy'

const log = {
  info: (...args: unknown[]) => console.log('[channel-policy-store]', ...args),
  warn: (...args: unknown[]) => console.warn('[channel-policy-store]', ...args),
}

export class ChannelPolicyStore {
  private cache: Map<string, ChannelPolicy> | null = null

  constructor(private readonly filePath: string) {}

  /** 读某个渠道的策略；没配过给默认（只提醒） */
  get(channelType: string): ChannelPolicy {
    const all = this.load()
    return all.get(channelType) ?? { ...DEFAULT_CHANNEL_POLICY, peers: [] }
  }

  /** 写某个渠道的策略（入口先收窄：坏值不进盘），返回落盘后的那份 */
  set(channelType: string, policy: ChannelPolicy): ChannelPolicy {
    const next = parseChannelPolicy(policy)
    const all = this.load()
    all.set(channelType, next)
    this.persist(all)
    return next
  }

  /**
   * 首次播种：**该渠道已有策略就什么都不做**。
   *
   * 迁移用（从 `wechat-watch.json` 把老策略搬过来）：用户之后在设置页改过，就绝不能再被
   * 旧文件覆盖回去。返回是否真的写了。
   */
  seedIfAbsent(channelType: string, policy: ChannelPolicy): boolean {
    const all = this.load()
    if (all.has(channelType)) return false
    all.set(channelType, parseChannelPolicy(policy))
    this.persist(all)
    log.info(`已为渠道 ${channelType} 播种策略（来自旧配置，之后改动以本文件为准）`)
    return true
  }

  private load(): Map<string, ChannelPolicy> {
    if (this.cache) return this.cache
    const map = new Map<string, ChannelPolicy>()
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'))
      if (parsed && typeof parsed === 'object') {
        for (const [channelType, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (!channelType || channelType.startsWith('_')) continue // `_hint` 之类的说明字段
          map.set(channelType, parseChannelPolicy(value))
        }
      }
    } catch {
      // 文件不存在/写坏都当空表：策略是"宽松配置"，读不到就退回默认，不能让渠道起不来
    }
    this.cache = map
    return map
  }

  private persist(all: Map<string, ChannelPolicy>): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const payload = JSON.stringify(Object.fromEntries(all), null, 2) + '\n'
      const tmp = `${this.filePath}.${process.pid}.tmp`
      fs.writeFileSync(tmp, payload, 'utf-8')
      fs.renameSync(tmp, this.filePath)
    } catch (err) {
      // 写盘失败不抛：内存里的那份仍然生效（本次运行内用户/盯梢看到的是一致的），
      // 只是重启会丢——记 warn 让人看得见
      log.warn(`策略写盘失败（本次运行内仍生效）：${this.filePath}`, err)
    }
  }
}

export function channelPolicyStorePath(): string {
  return path.join(resolveWindowsClientDataRoot(), 'channel', 'channel-policies.json')
}

let singleton: ChannelPolicyStore | null = null

/** 主进程单例（盯梢每拍同步读，别每拍碰磁盘） */
export function getChannelPolicyStore(): ChannelPolicyStore {
  if (!singleton) singleton = new ChannelPolicyStore(channelPolicyStorePath())
  return singleton
}
