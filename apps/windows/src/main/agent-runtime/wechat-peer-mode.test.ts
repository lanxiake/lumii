/**
 * `wechat_peer_mode`：用户在自己和助手的对话里说「停止给某某代聊」时，Agent 改档位的那条路。
 *
 * 只测**能坏的那部分**：并表的去重键（id 或显示名都算同一个人）与非法档位的拒绝。
 * 落盘与缓存归 `ChannelPolicyStore`（真写 `~/.lumii/channel/channel-policies.json`），
 * 测试不碰用户的真文件——所以这里也不驱动「合法入参」那条 execute。
 */
import { describe, expect, it } from 'vitest'
import { applyPeerMode, withPeerMode } from './bridge-tool-registrar-integration'

const { registerChannelTools } = await import('./bridge-tool-registrar-integration')

describe('withPeerMode（改一个人档位后的名单）', () => {
  it('新人 → 追加一条', () => {
    expect(withPeerMode([], '杨冬', 'ignore')).toEqual([{ id: '杨冬', mode: 'ignore' }])
  })

  it('按 id 去重：同名不同大小写算同一个人', () => {
    expect(withPeerMode([{ id: 'wxid_Loop', mode: 'auto' }], 'wxid_loop', 'notify')).toEqual([
      { id: 'wxid_loop', mode: 'notify' },
    ])
  })

  it('按显示名去重：迁移过来的条目（id 就是人名）也要被盖掉，不能 auto/ignore 两条并存', () => {
    expect(withPeerMode([{ id: '杨冬', mode: 'auto' }], 'wxid_bmr50soxlyen22', 'ignore', '杨冬')).toEqual([
      { id: 'wxid_bmr50soxlyen22', label: '杨冬', mode: 'ignore' },
    ])
  })

  it('改别人不动别人的档', () => {
    const peers = withPeerMode(
      [
        { id: 'wxid_a', mode: 'auto' },
        { id: 'wxid_b', mode: 'draft' },
      ],
      'wxid_a',
      'notify',
    )
    expect(peers.find((p) => p.id === 'wxid_b')?.mode).toBe('draft')
  })
})

describe('applyPeerMode（认人 + 并表：模型给显示名时改的是哪一条）', () => {
  const peers = [
    { id: 'filehelper', label: '文件传输助手', mode: 'auto' as const },
    { id: 'wxid_bmr50soxlyen22', label: '杨冬', mode: 'auto' as const },
  ]

  it('给显示名 → 改到名单里那条真键上，不新建', () => {
    expect(applyPeerMode(peers, { peer: '杨冬', mode: 'ignore' })).toEqual([
      { id: 'filehelper', label: '文件传输助手', mode: 'auto' },
      { id: 'wxid_bmr50soxlyen22', label: '杨冬', mode: 'ignore' },
    ])
  })

  it('给 wxid / 大小写不同 → 同一条', () => {
    expect(applyPeerMode(peers, { peer: 'WXID_BMR50SOXLYEN22', mode: 'notify' })).toEqual([
      { id: 'filehelper', label: '文件传输助手', mode: 'auto' },
      { id: 'wxid_bmr50soxlyen22', label: '杨冬', mode: 'notify' },
    ])
  })

  it('名单里没有的人 → 新建一条', () => {
    expect(applyPeerMode(peers, { peer: '陌生人', mode: 'ignore', label: '小陌生' })).toEqual([
      ...peers,
      { id: '陌生人', label: '小陌生', mode: 'ignore' },
    ])
  })

  // 2026-10-11 实测：模型给 filehelper 传了 `label: "自动代回"`（它把 label 当成档位说明），
  // 而 label 是**从微信读来的真显示名**——以名单里那份为准，别让模型的话盖掉。
  it('名单里已有 label 时，模型给的 label 不生效', () => {
    const next = applyPeerMode(peers, { peer: '文件传输助手', mode: 'auto', label: '自动代回' })
    expect(next.find((p) => p.id === 'filehelper')).toMatchObject({ label: '文件传输助手' })
  })

  // 2026-10-11 实测的真事：模型拿到「文件传输助手」，按名字建了第二条；
  // 下一拍 withSelfPeers 见 filehelper 不在名单里又补一条 —— 越用越多。
  it('名字条目与真键条目并存时，认人后只留一条（顺带清掉误建的那条）', () => {
    const before = [
      { id: 'filehelper', label: '文件传输助手', mode: 'auto' as const },
      { id: '文件传输助手', label: '文件传输助手', mode: 'auto' as const },
    ]
    expect(applyPeerMode(before, { peer: '文件传输助手', mode: 'notify' })).toEqual([
      { id: 'filehelper', label: '文件传输助手', mode: 'notify' },
    ])
  })
})

describe('wechat_peer_mode 入参把关', () => {
  function register() {
    const registered = new Map<string, { execute: (...a: unknown[]) => unknown }>()
    registerChannelTools({
      toolRegistry: {
        register: (t: { name: string; execute: (...a: unknown[]) => unknown }) => registered.set(t.name, t),
      },
      toolContext: {},
      config: {},
      getChannelRouter: () => null,
      toolCallInstanceMap: new Map(),
      instanceStates: new Map(),
      getCurrentToolExecutorInstanceId: () => undefined,
    } as unknown as Parameters<typeof registerChannelTools>[0])
    return registered.get('wechat_peer_mode')!
  }

  function textOf(result: unknown): Record<string, unknown> {
    const content = (result as { content: Array<{ text: string }> }).content
    return JSON.parse(content[0].text)
  }

  it('非法档位 → 拒绝并说清允许哪几档（不写盘）', async () => {
    const body = textOf(await register().execute('c1', { peer: '杨冬', mode: 'silent' }))
    expect(body).toMatchObject({ ok: false, errorCode: 'INVALID_MODE' })
    expect(String(body.message)).toContain('ignore')
  })

  it('没给 peer → 拒绝', async () => {
    const body = textOf(await register().execute('c1', { peer: '  ', mode: 'auto' }))
    expect(body).toMatchObject({ ok: false, errorCode: 'PEER_NOT_FOUND' })
  })
})
