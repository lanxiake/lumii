import { describe, it, expect } from 'vitest'
import {
  parseWechatSessions,
  mergeWechatContacts,
  contactsFromPolicy,
  loadWechatContacts,
  type WechatContact,
} from './wechat-contacts'
import type { ChannelPolicy } from '../../shared/channel-policy'

const SESSIONS = JSON.stringify([
  { talker: 'wxid_mama', name: '妈妈', last: '回来吃饭吗' },
  { talker: '12345@chatroom', name: '家人群', last: '在吗' },
  { talker: 'filehelper', name: '', last: '' },
  { talker: '', name: '没 id 的条目' },
  null,
])

const policyOf = (peers: ChannelPolicy['peers']): ChannelPolicy => ({
  defaultMode: 'notify',
  peers,
})

describe('wechat-contacts', () => {
  it('list_sessions 解析：坏条目跳过，群按 @chatroom 认，没名字退回 id', () => {
    expect(parseWechatSessions(SESSIONS)).toEqual([
      { id: 'wxid_mama', label: '妈妈', isGroup: false },
      { id: '12345@chatroom', label: '家人群', isGroup: true },
      { id: 'filehelper', label: 'filehelper', isGroup: false },
    ])
  })

  it('解析失败或不是数组时给空列表，不抛', () => {
    expect(parseWechatSessions('连不上')).toEqual([])
    expect(parseWechatSessions('{"talker":"x"}')).toEqual([])
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
      mcpServer: 'wechat-local',
      callMcpTool: async () => '错误：MCP 未连接',
      getPolicy: () => policy,
    })
    expect(res.error).toMatch(/没连上/)
    expect(res.contacts).toEqual([{ id: 'wxid_a', label: '阿呆', isGroup: false }])
  })

  it('读成功时微信会话在前、已配的补在后', async () => {
    const policy = policyOf([{ id: 'wxid_old', label: '老同学', mode: 'draft' }])
    const res = await loadWechatContacts({
      mcpServer: 'wechat-local',
      callMcpTool: async () => '[{"talker":"wxid_mama","name":"妈妈","last":"在吗"}]',
      getPolicy: () => policy,
    })
    expect(res.error).toBeUndefined()
    expect(res.contacts.map((c) => c.id)).toEqual(['wxid_mama', 'wxid_old'])
  })

  it('已配名单里没备注名的用 id 当显示名', () => {
    expect(contactsFromPolicy(policyOf([{ id: 'filehelper', mode: 'ignore' }]))).toEqual([
      { id: 'filehelper', label: 'filehelper', isGroup: false },
    ])
  })
})
