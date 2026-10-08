/**
 * 渠道策略存储：**播种不许覆盖用户改过的**——这是迁移唯一的安全性要求
 * （旧 `wechat-watch.json` 那份策略只在第一次搬过来时读一次）。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_CHANNEL_POLICY } from '../../shared/channel-policy'
import { ChannelPolicyStore } from './channel-policy-store'

function tmpPath(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'chan-policy-')), 'channel-policies.json')
}

describe('ChannelPolicyStore', () => {
  it('没配过 → 默认（只提醒：不动对方，也不叫模型）', () => {
    expect(new ChannelPolicyStore(tmpPath()).get('pcwechat')).toEqual(DEFAULT_CHANNEL_POLICY)
  })

  it('写进去读得回来，且落盘（新实例从同一文件读）', () => {
    const p = tmpPath()
    const policy = {
      accountId: 'wxid_me',
      defaultMode: 'ignore' as const,
      peers: [{ id: 'Loop', mode: 'auto' as const, cooldownSeconds: 5 }],
    }
    new ChannelPolicyStore(p).set('pcwechat', policy)
    expect(fs.existsSync(p)).toBe(true)
    expect(new ChannelPolicyStore(p).get('pcwechat')).toEqual(policy)
  })

  it('入口收窄：坏值不进盘（mode 乱写的那条丢掉，defaultMode 退回默认）', () => {
    const s = new ChannelPolicyStore(tmpPath())
    const saved = s.set('pcwechat', {
      defaultMode: '随便' as never,
      peers: [
        { id: 'a', mode: '乱写' as never },
        { id: 'b', mode: 'notify' },
      ],
    })
    expect(saved).toEqual({ defaultMode: 'notify', peers: [{ id: 'b', mode: 'notify' }] })
  })

  it('播种：该渠道已有策略就原样不动（用户改过的不许被旧配置覆盖）', () => {
    const s = new ChannelPolicyStore(tmpPath())
    expect(s.seedIfAbsent('pcwechat', { defaultMode: 'notify', peers: [{ id: 'Loop', mode: 'auto' }] })).toBe(true)
    expect(s.seedIfAbsent('pcwechat', { defaultMode: 'ignore', peers: [] })).toBe(false)
    expect(s.get('pcwechat').peers[0].mode).toBe('auto')
  })

  it('文件写坏/不存在 → 当空表（策略读不到不该让渠道起不来）', () => {
    const p = tmpPath()
    fs.writeFileSync(p, '{不是 json', 'utf-8')
    expect(new ChannelPolicyStore(p).get('pcwechat')).toEqual(DEFAULT_CHANNEL_POLICY)
  })
})
