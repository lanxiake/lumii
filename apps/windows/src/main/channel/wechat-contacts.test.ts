import { describe, it, expect } from 'vitest'
import {
  parseWechatContactBook,
  mergeWechatContacts,
  contactsFromPolicy,
  loadWechatContacts,
  type WechatContact,
} from './wechat-contacts'
import type { ChannelPolicy } from '../../shared/channel-policy'

const BOOK = JSON.stringify({
  self: { talker: 'wxid_me', name: '我自己' },
  contacts: [
    { talker: 'wxid_mama', name: '妈妈', kind: 'friend' },
    { talker: '12345@chatroom', name: '家人群', kind: 'group' },
    { talker: 'wxid_noname', name: '', kind: 'friend' },
    { talker: '', name: '没 id 的条目', kind: 'friend' },
    null,
  ],
})

const policyOf = (peers: ChannelPolicy['peers']): ChannelPolicy => ({
  defaultMode: 'notify',
  peers,
})

describe('wechat-contacts', () => {
  it('list_contacts 解析：坏条目跳过，群按 kind/@chatroom 认，没名字退回 id', () => {
    const { contacts, self } = parseWechatContactBook(BOOK)
    expect(self).toEqual({ id: 'wxid_me', label: '我自己', isGroup: false })
    expect(contacts).toEqual([
      { id: 'wxid_mama', label: '妈妈', isGroup: false },
      { id: '12345@chatroom', label: '家人群', isGroup: true },
      { id: 'wxid_noname', label: 'wxid_noname', isGroup: false },
    ])
  })

  it('解析失败或不是对象时给空表，不抛', () => {
    expect(parseWechatContactBook('连不上')).toEqual({ contacts: [] })
    expect(parseWechatContactBook('[{"talker":"x"}]')).toEqual({ contacts: [] })
  })

  it('合并去重大小写不敏感，微信那份优先', () => {
    const a: WechatContact[] = [{ id: 'wxid_MAMA', label: '妈妈(微信)', isGroup: false }]
    const b: WechatContact[] = [
      { id: 'wxid_mama', label: '妈妈(名单)', isGroup: false },
      { id: 'wxid_gone', label: '删过的人', isGroup: false },
    ]
    expect(mergeWechatContacts(a, b)).toEqual([
      { id: 'wxid_MAMA', label: '妈妈(微信)', isGroup: false },
      { id: 'wxid_gone', label: '删过的人', isGroup: false },
    ])
  })

  it('微信读不到时退回已配名单并如实给原因', async () => {
    const policy = policyOf([{ id: 'wxid_a', label: '阿呆', mode: 'auto' }])
    const res = await loadWechatContacts({
      // 侧车失败即抛（不再有「同一段字符串里嗅探未连接」那种判据，见 callText 的注释）
      callTool: async () => {
        throw new Error('本机微信侧车未就绪：spawn ENOENT')
      },
      getPolicy: () => policy,
    })
    expect(res.error).toMatch(/读微信通讯录失败/)
    expect(res.contacts).toEqual([{ id: 'wxid_a', label: '阿呆', isGroup: false }])
  })

  it('读成功时只给通讯录里真实存在的人，不把已配过但已删除的人补回来', async () => {
    // 用户报的坑：名单里配过、但微信里早就删掉的人，不该出现在「从微信里挑人」里
    // ——那些人在微信里压根选不到，混进来会让人以为微信里还有他们。
    const policy = policyOf([{ id: 'wxid_old', label: '删掉的老同学', mode: 'draft' }])
    const res = await loadWechatContacts({
      callTool: async () =>
        JSON.stringify({
          self: { talker: 'wxid_me', name: '我' },
          contacts: [{ talker: 'wxid_mama', name: '妈妈', kind: 'friend' }],
        }),
      getPolicy: () => policy,
    })
    expect(res.error).toBeUndefined()
    expect(res.self).toEqual({ id: 'wxid_me', label: '我', isGroup: false })
    expect(res.contacts.map((c) => c.id)).toEqual(['wxid_mama'])
  })

  it('通讯录为空时退回已配名单（微信没登录 / 还没好友）', async () => {
    const policy = policyOf([{ id: 'wxid_a', label: '阿呆', mode: 'auto' }])
    const res = await loadWechatContacts({
      callTool: async () => JSON.stringify({ contacts: [] }),
      getPolicy: () => policy,
    })
    expect(res.error).toMatch(/没读到微信通讯录/)
    expect(res.contacts.map((c) => c.id)).toEqual(['wxid_a'])
  })

  it('已配名单里没备注名的用 id 当显示名', () => {
    expect(contactsFromPolicy(policyOf([{ id: 'filehelper', mode: 'ignore' }]))).toEqual([
      { id: 'filehelper', label: 'filehelper', isGroup: false },
    ])
  })
})
