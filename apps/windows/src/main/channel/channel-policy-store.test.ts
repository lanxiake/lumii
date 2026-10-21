/**
 * 渠道策略存储：**播种不许覆盖用户改过的**——这是迁移唯一的安全性要求
 * （旧 `wechat-watch.json` 那份策略只在第一次搬过来时读一次）。
 */
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  DEFAULT_CHANNEL_POLICY,
  allPolicyPeers,
  parseChannelPolicy,
  policyForAccount,
  withPeersForAccount,
} from '../../shared/channel-policy'
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

/** 多开：按账号分账的解析与写回（没配过的号必须沿用顶层，迁移零成本） */
describe('账号分账（accounts）', () => {
  it('解析：保留各号名单，跳过 _hint；坏档退回 notify，不整份丢掉', () => {
    const p = parseChannelPolicy({
      defaultMode: 'ignore',
      peers: [{ id: 'top', mode: 'auto' }],
      accounts: {
        _hint: '说明字段不是账号',
        wxid_a: { label: ' 工作号 ', defaultMode: 'auto', peers: [{ id: 'boss', mode: 'auto' }] },
        wxid_b: { defaultMode: '乱写', peers: [{ id: 'x', mode: '乱写' }, { id: 'y', mode: 'notify' }] },
      },
    })
    // 名单外只能用非-agent 档：账号级 defaultMode 也受同一条硬约束（auto → notify）
    expect(p.accounts?.wxid_a).toEqual({
      label: '工作号',
      defaultMode: 'notify',
      peers: [{ id: 'boss', mode: 'auto' }],
    })
    expect(p.accounts?.wxid_b).toEqual({ defaultMode: 'notify', peers: [{ id: 'y', mode: 'notify' }] })
    expect(Object.keys(p.accounts ?? {})).toEqual(['wxid_a', 'wxid_b'])
  })

  it('取号：大小写不敏感；没配过的号沿用顶层', () => {
    const p = parseChannelPolicy({
      defaultMode: 'notify',
      peers: [{ id: 'top', mode: 'auto' }],
      accounts: { WXID_A: { defaultMode: 'ignore', peers: [{ id: 'a', mode: 'draft' }] } },
    })
    expect(policyForAccount(p, 'wxid_a').peers.map((x) => x.id)).toEqual(['a'])
    expect(policyForAccount(p, 'wxid_a').defaultMode).toBe('ignore')
    expect(policyForAccount(p, 'wxid_other').peers.map((x) => x.id)).toEqual(['top'])
    expect(policyForAccount(p).defaultMode).toBe('notify')
  })

  it('写回：新号继承顶层 defaultMode、保留已有备注；同名不同大小写只留一份', () => {
    const p = parseChannelPolicy({
      defaultMode: 'notify',
      peers: [{ id: 'top', mode: 'auto' }],
      accounts: { WXID_A: { label: '工作号', defaultMode: 'ignore', peers: [] } },
    })
    const next = withPeersForAccount(p, 'wxid_a', [{ id: 'a', mode: 'auto' }])
    expect(next.accounts).toEqual({
      wxid_a: { label: '工作号', defaultMode: 'ignore', peers: [{ id: 'a', mode: 'auto' }] },
    })
    const fresh = withPeersForAccount(p, 'wxid_b', [{ id: 'b', mode: 'auto' }])
    expect(fresh.accounts?.wxid_b.defaultMode).toBe('notify')
  })

  it('并集：顶层 + 各号去重（出站快照与画像巡检用它）', () => {
    const p = parseChannelPolicy({
      peers: [{ id: 'Top', mode: 'auto' }],
      accounts: {
        a: { defaultMode: 'notify', peers: [{ id: 'top', mode: 'ignore' }, { id: 'a1', mode: 'auto' }] },
        b: { defaultMode: 'notify', peers: [{ id: 'b1', mode: 'notify' }] },
      },
    })
    expect(allPolicyPeers(p).map((x) => x.id)).toEqual(['Top', 'a1', 'b1'])
  })
})
