/**
 * `wechat-watch` 盯梢循环的行为规格。
 *
 * 这条循环的**唯一价值**是：没事发生时零成本、有事发生时不错过。
 * 所以测试盯死三件事：
 *   1. 没有新消息 → 不通知（否则就是噪声源）；失败 → 不推进水位、不通知（绝不乱报）；
 *   2. 报的是「别人发的、不在忽略名单里」的那些（自己发的不必提醒自己）；
 *   3. 水位一定推进且落库（重启不重复报，也不重复读同一段）。
 */
import { afterAll, beforeAll, describe, it, expect, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { resolvePeerPolicy } from '../../shared/channel-policy'
import { agentRuntimeLog as log } from './bridge-utils'
import {
  buildAutoPrompt,
  buildDraftPrompt,
  DEFAULT_WECHAT_WATCH_CONFIG,
  ensureWechatWatchConfigFile,
  ensureWechatWatchCronJobSeeded,
  formatIncomingForHistory,
  formatWechatNotice,
  buildProfileSweepPrompt,
  enqueueWechatOutbox,
  formatWechatProfiles,
  loadInstructions,
  parseWechatWatchConfig,
  pickProfileSweepTarget,
  policyFromWatchConfig,
  profileScopesFromFiles,
  readWechatOutbox,
  resolveWorkspacePath,
  runWechatWatch,
  selectNewMessages,
  WECHAT_PROFILE_MAX_CHARS,
  WECHAT_WATCH_INSTRUCTION,
  watchConversationIdFor,
  watchConversationTitleFor,
  type WechatMessage,
  type WechatWatchDeps,
} from './wechat-watch-tick'

function fakeDb(initial: Record<string, string> = {}) {
  const kv = new Map(Object.entries(initial))
  const db = {
    prepare: vi.fn((sql: string) => ({
      get: (key: string) => (kv.has(key) ? { value: kv.get(key) } : undefined),
      run: (...args: unknown[]) => {
        if (sql.includes('INSERT OR REPLACE INTO runtime_state')) {
          kv.set(String(args[0]), String(args[1]))
        }
        return { changes: 1 }
      },
    })),
  }
  return { db: db as never, kv }
}

function deps(over: Partial<WechatWatchDeps> = {}) {
  const { db, kv } = fakeDb()
  // 形参写全（server/tool），`mockImplementation` 才按工具分流；契约类型只声明了 0 参，故断言一次
  const callMcpTool = vi.fn(async (_server: string, _tool: string) =>
    JSON.stringify({ count: 0, messages: [], next_since_ts: 2000 }),
  )
  const showNotification = vi.fn()
  const d: WechatWatchDeps = {
    getDb: () => db,
    callMcpTool: callMcpTool as unknown as WechatWatchDeps['callMcpTool'],
    showNotification,
    configPath: 'NUL',
    nowMs: () => 1_800_000,
    ...over,
  }
  return { d, kv, callMcpTool, showNotification }
}

describe('parseWechatWatchConfig', () => {
  it('空/垃圾输入退回默认（盯梢不能因为配置写坏就停）', () => {
    expect(parseWechatWatchConfig(null)).toEqual(DEFAULT_WECHAT_WATCH_CONFIG)
    expect(parseWechatWatchConfig('nope')).toEqual(DEFAULT_WECHAT_WATCH_CONFIG)
    expect(parseWechatWatchConfig({ enabled: 'yes', defaultMode: '随便' })).toEqual(
      DEFAULT_WECHAT_WATCH_CONFIG,
    )
  })

  it('分组：只认合法 mode、peers 为空的组直接丢掉', () => {
    const cfg = parseWechatWatchConfig({
      defaultMode: 'ignore',
      groups: [
        { name: '家人', mode: 'auto', peers: ['妈妈', ''], cooldownSeconds: 30 },
        { name: '空的', mode: 'draft', peers: [] },
        { name: '坏模式', mode: '乱写', peers: ['张三'] },
      ],
    })
    expect(cfg.defaultMode).toBe('ignore')
    expect(cfg.groups).toEqual([
      { name: '家人', mode: 'auto', peers: ['妈妈'], cooldownSeconds: 30 },
      { name: '坏模式', mode: 'notify', peers: ['张三'], cooldownSeconds: undefined },
    ])
  })

  it('v1 兼容：watch 视为一个 notify 分组 + 默认忽略；ignore 即黑名单', () => {
    const cfg = parseWechatWatchConfig({ watch: ['Loop'], ignore: ['filehelper', '某群'], enabled: true })
    expect(cfg.defaultMode).toBe('ignore')
    expect(cfg.groups).toEqual([{ name: '白名单', mode: 'notify', peers: ['Loop'], cooldownSeconds: undefined }])
    expect(cfg.blacklist).toEqual(['filehelper', '某群'])
  })
})

/**
 * 老配置（blacklist + groups）→ 渠道策略 → 每人一档的解析。
 * 这几条同时是**迁移的同义性证明**：搬迁前后同一个会话必须走同一档。
 */
describe('policyFromWatchConfig / resolvePeerPolicy', () => {
  const policy = policyFromWatchConfig(
    parseWechatWatchConfig({
      defaultMode: 'notify',
      blacklist: ['filehelper'],
      groups: [
        { name: '家人', mode: 'auto', peers: ['妈妈'], cooldownSeconds: 10 },
        { name: '同事', mode: 'draft', peers: ['张三', 'wxid_zhangsan'] },
      ],
    }),
  )

  it('黑名单→ignore；命中一条就生效；其余走 defaultMode', () => {
    expect(resolvePeerPolicy(policy, { label: '文件传输助手', id: 'filehelper' }).mode).toBe('ignore')
    expect(resolvePeerPolicy(policy, { id: 'wxid_mama', label: '妈妈' })).toMatchObject({
      mode: 'auto',
      matchedBy: '妈妈',
      cooldownSeconds: 10,
    })
    expect(resolvePeerPolicy(policy, { id: 'wxid_zhangsan', label: '张三' }).mode).toBe('draft')
    // 大小写不敏感：talker 命中
    expect(resolvePeerPolicy(policy, { id: 'WXID_ZHANGSAN' }).mode).toBe('draft')
    expect(resolvePeerPolicy(policy, { id: 'wxid_x', label: '陌生人' })).toMatchObject({
      mode: 'notify',
      matchedBy: null,
    })
  })

  it('冷却：条目可以自定，没写用默认 60 秒', () => {
    // 老配置是按**显示名**写的（`peers:['妈妈']`），所以查的人要带上 name —— 盯梢那边
    // 传的是 `{id: talker, label: name}`，两种写法都命中（旧解析器同样是 talker/name 各试一遍）
    expect(resolvePeerPolicy(policy, { id: 'wxid_mama', label: '妈妈' }).cooldownSeconds).toBe(10)
    expect(resolvePeerPolicy(policy, { id: 'wxid_zhangsan', label: '张三' }).cooldownSeconds).toBe(60)
    expect(resolvePeerPolicy(policy, { id: 'wxid_x', label: '陌生人' }).cooldownSeconds).toBe(60)
  })

  it('同一个名字既在黑名单又在分组里：黑名单优先（迁移靠保序，不靠两套判据）', () => {
    const p = policyFromWatchConfig(
      parseWechatWatchConfig({
        blacklist: ['张三'],
        groups: [{ name: '同事', mode: 'auto', peers: ['张三'] }],
      }),
    )
    expect(resolvePeerPolicy(p, { id: 'wxid_zhangsan', label: '张三' }).mode).toBe('ignore')
  })
})

describe('selectNewMessages', () => {
  const msgs = [
    { ts: 1, name: 'Loop', talker: 'wxid_loop', from_me: false },
    { ts: 2, name: '我', talker: 'wxid_me', from_me: true },
    { ts: 3, name: '文件传输助手', talker: 'filehelper', from_me: false },
    { ts: 4, name: '群聊', talker: '123@chatroom', from_me: false },
  ]

  it('只处理别人发的；ignore 档连提醒都不给', () => {
    const out = selectNewMessages(msgs, policyFromWatchConfig(DEFAULT_WECHAT_WATCH_CONFIG))
    expect(out.map((m) => m.ts)).toEqual([1, 4])
  })

  it('defaultMode=ignore 时：只有表里的会话会被处理（=只盯名单）', () => {
    const cfg = parseWechatWatchConfig({
      defaultMode: 'ignore',
      groups: [{ name: '好友', mode: 'notify', peers: ['wxid_loop'] }],
    })
    expect(selectNewMessages(msgs, policyFromWatchConfig(cfg)).map((m) => m.ts)).toEqual([1])
  })
})

describe('formatWechatNotice', () => {
  it('最多三条，其余折叠', () => {
    const body = formatWechatNotice([
      { ts: 1, name: 'A', text: '一' },
      { ts: 2, name: 'B', text: '二' },
      { ts: 3, name: 'C', text: '三' },
      { ts: 4, name: 'D', text: '四' },
    ])
    expect(body).toBe('A：一\nB：二\nC：三\n…还有 1 条')
  })
})

describe('runWechatWatch', () => {
  it('没有新消息：不通知、水位推进到 next_since_ts', async () => {
    const { d, kv, showNotification } = deps()
    const out = await runWechatWatch(d)
    expect(out).toBe('无新消息')
    expect(showNotification).not.toHaveBeenCalled()
    expect(kv.get('wechat_watch_last_ts')).toBe('2000')
  })

  it('首次运行（无水位）只从现在起看，不翻历史', async () => {
    const { d, callMcpTool } = deps()
    await runWechatWatch(d)
    expect(callMcpTool).toHaveBeenCalledWith('wechat-local', 'poll_new', { since_ts: 1800 })
  })

  it('有新消息：通知正文含名字与内容，水位照推进', async () => {
    const { d, kv, callMcpTool, showNotification } = deps()
    callMcpTool.mockResolvedValueOnce(
      JSON.stringify({
        count: 2,
        messages: [
          { ts: 1990, name: 'Loop', talker: 'wxid_loop', from_me: false, text: '在吗' },
          { ts: 1991, name: '我', talker: 'wxid_me', from_me: true, text: '这条不该报' },
        ],
        next_since_ts: 1991,
      }),
    )
    const out = await runWechatWatch(d)
    // 第三个参数是跳转目标：只涉及一个会话 → 直达那个好友（M1 起按 peer 分会话）
    expect(showNotification).toHaveBeenCalledWith('微信新消息（1）', 'Loop：在吗', 'pcwechat:wxid_loop')
    expect(out).toContain('提醒 1 条')
    expect(kv.get('wechat_watch_last_ts')).toBe('1991')
  })

  it('poll 失败：不推进水位、不通知（门闩失败=这拍什么都不做）', async () => {
    const { d, kv, callMcpTool, showNotification } = deps({})
    callMcpTool.mockRejectedValueOnce(new Error('MCP request timeout: tools/call'))
    const out = await runWechatWatch(d)
    expect(out).toContain('poll 失败')
    expect(showNotification).not.toHaveBeenCalled()
    expect(kv.has('wechat_watch_last_ts')).toBe(false)
  })

  it('MCP 没装/没连：安静跳过（客户端不依赖微信 MCP）', async () => {
    const { d, kv, callMcpTool, showNotification } = deps({})
    callMcpTool.mockRejectedValueOnce(new Error('MCP Server [wechat-local] 未连接'))
    const out = await runWechatWatch(d)
    expect(out).toContain('未连接')
    expect(out).not.toContain('poll 失败') // 不是"失败"，是"这台机器没这个数据源"
    expect(showNotification).not.toHaveBeenCalled()
    expect(kv.has('wechat_watch_last_ts')).toBe(false)
  })

  it('enabled=false：连 MCP 都不调', async () => {
    const { d, callMcpTool } = deps({ config: { ...DEFAULT_WECHAT_WATCH_CONFIG, enabled: false } })
    const out = await runWechatWatch(d)
    expect(out).toContain('已关闭')
    expect(callMcpTool).not.toHaveBeenCalled()
  })

  it('被过滤掉的消息：不通知，但仍推进水位（否则下一拍重复读同一段）', async () => {
    const { d, kv, callMcpTool, showNotification } = deps()
    callMcpTool.mockResolvedValueOnce(
      JSON.stringify({
        count: 1,
        messages: [
          { ts: 1995, name: '文件传输助手', talker: 'filehelper', from_me: false, text: '自用' },
        ],
        next_since_ts: 1995,
      }),
    )
    const out = await runWechatWatch(d)
    expect(showNotification).not.toHaveBeenCalled()
    expect(out).toContain('均被过滤')
    expect(kv.get('wechat_watch_last_ts')).toBe('1995')
  })
})

describe('会话 id / 标题（每 peer 一条线）', () => {
  it('id 用稳定 talker，标题用显示名', () => {
    expect(watchConversationIdFor('wxid_s6piyhfvptv522')).toBe('pcwechat:wxid_s6piyhfvptv522')
    expect(watchConversationTitleFor('Loop', 'wxid_s6piyhfvptv522')).toBe('本机微信 · Loop')
  })

  it('没有显示名时退回 talker（绝不产生空标题）', () => {
    expect(watchConversationTitleFor(undefined, 'wxid_x')).toBe('本机微信 · wxid_x')
    expect(watchConversationTitleFor('   ', 'wxid_x')).toBe('本机微信 · wxid_x')
  })

  it('群聊 / 带 @ 的 talker 一样能当 id（weixin 渠道已有同样先例）', () => {
    expect(watchConversationIdFor('1234@chatroom')).toBe('pcwechat:1234@chatroom')
  })
})

describe('runWechatWatch · 分组策略', () => {
  const cfgAutoLoop = parseWechatWatchConfig({
    defaultMode: 'notify',
    groups: [{ name: '好友', mode: 'auto', peers: ['Loop'], cooldownSeconds: 300 }],
  })
  const incoming = (text: string, ts = 1990) =>
    JSON.stringify({
      count: 1,
      messages: [{ ts, name: 'Loop', talker: 'wxid_loop', from_me: false, text }],
      next_since_ts: ts,
    })

  it('auto 组：回合说发了 → 还要读库确认；库里没有就写「未发」（不替它邀功）', async () => {
    const driveTurn = vi.fn(async () => '已发出：在的')
    const { d, callMcpTool, showNotification } = deps({ config: cfgAutoLoop, driveTurn })
    callMcpTool.mockResolvedValueOnce(incoming('在吗'))
    const out = await runWechatWatch(d)
    expect(driveTurn).toHaveBeenCalledTimes(1)
    const [prompt, meta] = driveTurn.mock.calls[0] as unknown as [
      string,
      { mode: string; convId: string; title: string; peer: string },
    ]
    expect(prompt).toContain('direct' in {} ? '' : 'wxid_loop')
    // 发送走渠道出站（名单是硬门），不是拿 MCP 的工具自己发
    expect(prompt).toContain('channel_send')
    expect(prompt).toContain('pcwechat')
    expect(prompt).not.toMatch(/send_text\(/)
    expect(meta.mode).toBe('auto')
    // 回合落在**那个好友的会话**里（不是所有人共用的单例）
    expect(meta.convId).toBe('pcwechat:wxid_loop')
    expect(meta.title).toBe('本机微信 · Loop')
    expect(meta.peer).toBe('wxid_loop')
    expect(out).toContain('未发') // 库里查不到我的发送 → 不写「已代回」
    const titles = showNotification.mock.calls.map((c) => String(c[0]))
    expect(titles.some((t) => t.includes('已处理'))).toBe(true)
    // 只涉及一个会话 → 点通知直达 Loop
    const actedCall = showNotification.mock.calls.find((c) => String(c[0]).includes('已处理'))
    expect(actedCall?.[2]).toBe('pcwechat:wxid_loop')
  })

  it('同一拍里两个会话 → 通知不带跳转目标（没法替用户挑一个）', async () => {
    const cfgBoth = parseWechatWatchConfig({
      defaultMode: 'notify',
      groups: [{ name: '好友', mode: 'auto', peers: ['Loop', '小明'], cooldownSeconds: 300 }],
    })
    const driveTurn = vi.fn(async () => 'ok')
    const { d, callMcpTool, showNotification } = deps({ config: cfgBoth, driveTurn })
    callMcpTool.mockResolvedValueOnce(
      JSON.stringify({
        count: 2,
        messages: [
          { ts: 1990, name: 'Loop', talker: 'wxid_loop', from_me: false, text: '在吗' },
          { ts: 1991, name: '小明', talker: 'wxid_ming', from_me: false, text: '在吗' },
        ],
        next_since_ts: 1991,
      }),
    )
    await runWechatWatch(d)
    expect(driveTurn).toHaveBeenCalledTimes(2)
    const convIds = (driveTurn.mock.calls as unknown as Array<[string, { convId: string }]>).map(
      (c) => c[1].convId,
    )
    expect(convIds.sort()).toEqual(['pcwechat:wxid_loop', 'pcwechat:wxid_ming'])
    for (const call of showNotification.mock.calls) {
      expect(call[2]).toBeUndefined()
    }
  })

  it('auto 组：库里确实有我发的 → 写「已代回」', async () => {
    const driveTurn = vi.fn(async () => '发好了')
    const { d, callMcpTool } = deps({ config: cfgAutoLoop, driveTurn })
    callMcpTool
      .mockResolvedValueOnce(incoming('在吗'))
      .mockResolvedValueOnce(JSON.stringify({ messages: [{ ts: 1991, name: 'Loop', talker: 'wxid_loop', from_me: true, text: '我回的' }] }))
    const out = await runWechatWatch(d)
    expect(out).toContain('已代回')
  })

  it('用户自己刚回过（from_me）→ 冷却被他占住，auto 不重复代聊', async () => {
    const driveTurn = vi.fn(async () => 'ok')
    const { d, callMcpTool } = deps({ config: cfgAutoLoop, driveTurn, nowMs: () => 1_800_000 })
    callMcpTool.mockResolvedValueOnce(JSON.stringify({
      messages: [
        { ts: 1990, name: '我', talker: 'wxid_loop', from_me: true, text: '我自己回了' },
        { ts: 1991, name: 'Loop', talker: 'wxid_loop', from_me: false, text: '他又说了一句' },
      ],
      next_since_ts: 1991,
    }))
    const out = await runWechatWatch(d)
    expect(driveTurn).not.toHaveBeenCalled()
    expect(out).toContain('提醒 1 条')
  })

  it('draft 组：提示词明确「只起草不许发」；回合后若真发了消息，如实加警告', async () => {
    const cfgDraft = parseWechatWatchConfig({
      groups: [{ name: '同事', mode: 'draft', peers: ['Loop'] }],
    })
    const driveTurn = vi.fn(async () => '草稿：在的，稍等')
    const { d, callMcpTool } = deps({ config: cfgDraft, driveTurn })
    // 第一次 poll 给「新消息」，第二次（回合后的自证）给一条 from_me
    callMcpTool
      .mockResolvedValueOnce(incoming('在吗'))
      .mockResolvedValueOnce(
        JSON.stringify({ messages: [{ ts: 1999, name: 'Loop', talker: 'wxid_loop', from_me: true, text: '我发的' }] }),
      )
    const out = await runWechatWatch(d)
    const [prompt] = driveTurn.mock.calls[0] as unknown as [string]
    expect(prompt).toContain('不要发送')
    expect(out).toContain('⚠️')
  })

  it('没有 driveTurn（未接线）：draft/auto 降级为提醒，不出错', async () => {
    const { d, callMcpTool, showNotification } = deps({ config: cfgAutoLoop })
    callMcpTool.mockResolvedValue(incoming('在吗'))
    const out = await runWechatWatch(d)
    expect(out).toContain('提醒 1 条')
    expect(showNotification).toHaveBeenCalled()
  })

  it('冷却期内不重复驱动：第二次只提醒', async () => {
    const driveTurn = vi.fn(async () => 'ok')
    const { d, callMcpTool } = deps({ config: cfgAutoLoop, driveTurn, nowMs: () => 1_800_000 })
    callMcpTool.mockResolvedValue(incoming('第一条', 1990))
    await runWechatWatch(d)
    expect(driveTurn).toHaveBeenCalledTimes(1)
    // 同一会话、下一拍（水位推进后）又来一条 → 冷却 300s 未过 → 不再驱动
    callMcpTool.mockResolvedValue(incoming('第二条', 1995))
    const out2 = await runWechatWatch(d)
    expect(driveTurn).toHaveBeenCalledTimes(1)
    expect(out2).toContain('提醒 1 条')
  })
})

describe('手册注入（RUNBOOK）——**回落路径**：代聊 Agent 不在时才是这条', () => {
  const msg = { ts: 100, name: 'Loop', talker: 'wxid_loop', text: '在吗' }

  it('提示词把手册放在最前（硬约束，不靠模型"记得去读"），触发信息在后', () => {
    const p = buildAutoPrompt(msg, '【护栏】涉钱不发', 'temp/wx-loop/RUNBOOK.md')
    expect(p.indexOf('【护栏】涉钱不发')).toBeGreaterThanOrEqual(0)
    expect(p.indexOf('【护栏】涉钱不发')).toBeLessThan(p.indexOf('【本次触发】'))
    expect(p).toContain('不要再轮询')
    expect(p).toContain('转人工')
    const d = buildDraftPrompt(msg, '【护栏】涉钱不发', 'temp/wx-loop/RUNBOOK.md')
    expect(d.indexOf('【护栏】涉钱不发')).toBeLessThan(d.indexOf('【本次触发】'))
    expect(d).toContain('只起草、不要发送')
  })

  it('auto 档的发送指令只指向渠道出站，且把<收件人>钉死成这一条消息的 talker', () => {
    const p = buildAutoPrompt(msg, '【手册】日常闲聊可直接回', 'temp/wx-loop/RUNBOOK.md')
    expect(p).toContain('channel_send')
    expect(p).toContain('channel="pcwechat"')
    expect(p).toContain('to="wxid_loop"')
    // 绕过渠道直发 = 绕开名单，提示词里不许出现这条路
    expect(p).not.toMatch(/send_text\(/)
  })

  it('配置解析认 instructionsFile；没配/手册读不到时提示词照常生成', () => {
    const cfg = parseWechatWatchConfig({
      groups: [{ name: '好友', mode: 'auto', peers: ['Loop'] }],
      instructionsFile: 'temp/wx-loop/RUNBOOK.md',
    })
    expect(cfg.instructionsFile).toBe('temp/wx-loop/RUNBOOK.md')
    expect(buildAutoPrompt(msg)).not.toContain('【必须遵守的手册')
    expect(loadInstructions(undefined)).toBe('')
    expect(loadInstructions('不存在的-abc-123.md')).toBe('')
  })

  it('workspace 相对路径按 ~/.lumii/workspace 解析；绝对路径原样', () => {
    expect(resolveWorkspacePath('temp/x.md')).toContain('workspace')
    expect(resolveWorkspacePath('C:/tmp/x.md')).toBe('C:/tmp/x.md')
  })
})

/**
 * M2 身份归位（2026-10-08）：手册搬进「灵栖代聊」的 systemPrompt 之后，
 * 回路这一侧只剩两件事要盯死——
 *   1. Agent 在 → 提示词里**不再重复那几千字**（否则 M2 的收益没了）；
 *   2. Agent 不在（删了/禁用/手册读不到）→ **退回注入**（护栏不许静默消失）。
 */
describe('手册归属：住在代聊 Agent 的 systemPrompt 里（M2）', () => {
  const RUNBOOK_TEXT = '【护栏】涉钱 / 冲突 / 身份质疑一律不发，转人工'
  let runbookFile = ''
  let cfgFile = parseWechatWatchConfig({ groups: [] })

  beforeAll(() => {
    runbookFile = path.join(os.tmpdir(), `wx-runbook-${Date.now()}.md`)
    fs.writeFileSync(runbookFile, RUNBOOK_TEXT, 'utf-8')
    cfgFile = parseWechatWatchConfig({
      groups: [{ name: '好友', mode: 'auto', peers: ['Loop'], cooldownSeconds: 300 }],
      instructionsFile: runbookFile,
    })
  })
  afterAll(() => {
    try {
      fs.unlinkSync(runbookFile)
    } catch {
      /* 临时文件删不掉不影响判定 */
    }
  })

  const incoming = JSON.stringify({
    count: 1,
    messages: [{ ts: 1990, name: 'Loop', talker: 'wxid_loop', from_me: false, text: '在吗' }],
    next_since_ts: 1990,
  })

  it('代聊 Agent 在 → 手册不重复注入，但「本次触发」和发送通道照旧', async () => {
    const driveTurn = vi.fn(async () => 'ok')
    const { d, callMcpTool } = deps({
      config: cfgFile,
      driveTurn,
      getRelayAgent: () => ({ id: 'wechat-relay', systemPrompt: `身份…\n${RUNBOOK_TEXT}` }),
    })
    callMcpTool.mockResolvedValueOnce(incoming)
    await runWechatWatch(d)
    const [prompt] = driveTurn.mock.calls[0] as unknown as [string]
    expect(prompt).not.toContain(RUNBOOK_TEXT)
    expect(prompt).toContain('【本次触发】')
    expect(prompt).toContain('channel_send')
  })

  it('代聊 Agent 不在 → 退回每轮注入（护栏不能因为少了个 Agent 就消失）', async () => {
    const driveTurn = vi.fn(async () => 'ok')
    const { d, callMcpTool } = deps({ config: cfgFile, driveTurn, getRelayAgent: () => undefined })
    callMcpTool.mockResolvedValueOnce(incoming)
    await runWechatWatch(d)
    const [prompt] = driveTurn.mock.calls[0] as unknown as [string]
    expect(prompt).toContain(RUNBOOK_TEXT)
    expect(prompt).toContain('本次触发')
  })

  it('Agent 里那份和手册文件不一致 → 仍以 Agent 为准（手册文件只是留档），并记一条 warn', async () => {
    const warn = vi.spyOn(log, 'warn').mockImplementation(() => {})
    const driveTurn = vi.fn(async () => 'ok')
    const { d, callMcpTool } = deps({
      config: cfgFile,
      driveTurn,
      // 用户在设置页把护栏改短了/改了措辞：文件里那句就不在里面了
      getRelayAgent: () => ({ id: 'wechat-relay', systemPrompt: '身份…\n【护栏】我自己改过的版本' }),
    })
    callMcpTool.mockResolvedValueOnce(incoming)
    await runWechatWatch(d)
    const [prompt] = driveTurn.mock.calls[0] as unknown as [string]
    expect(prompt).not.toContain(RUNBOOK_TEXT)
    expect(warn.mock.calls.some((c) => String(c[0]).includes('已不一致'))).toBe(true)
    warn.mockRestore()
  })
})

/**
 * 会话历史里要看得见**对方的输入**：此前只推一条 `【微信代回】<peer>` 的界面提示
 * （不落库），用户点进代聊会话只看得到助手单方面的回复。把消息交给桥接侧去落库的
 * 前提是**整批原样送到**（同一拍同一会话的多条合并成一个回合，只送最后一条会丢历史）。
 */
describe('回合元数据带上触发这一轮的消息', () => {
  const cfg = parseWechatWatchConfig({
    groups: [{ name: '好友', mode: 'auto', peers: ['Loop', '123@chatroom'], cooldownSeconds: 300 }],
  })
  const payload = JSON.stringify({
    count: 2,
    messages: [
      { ts: 1991, name: 'Loop', talker: 'wxid_loop', from_me: false, text: '在吗', sender: 'Loop' },
      { ts: 1992, name: 'Loop', talker: 'wxid_loop', from_me: false, text: '在的', sender: 'Loop' },
      { ts: 1993, name: '家人群', talker: '123@chatroom', from_me: false, text: '周末回不回来', sender: '小舅' },
    ],
    next_since_ts: 1993,
  })

  it('同一会话这拍的多条一起给桥接侧；群消息补发送者，私聊不补', async () => {
    const driveTurn = vi.fn(async () => 'ok')
    const { d, callMcpTool } = deps({ config: cfg, driveTurn })
    callMcpTool.mockResolvedValueOnce(payload)
    await runWechatWatch(d)
    const byConv = new Map(
      (driveTurn.mock.calls as unknown as [string, { convId: string; incoming: WechatMessage[] }][]).map(
        ([, meta]) => [meta.convId, meta.incoming],
      ),
    )
    const loop = byConv.get('pcwechat:wxid_loop') ?? []
    expect(loop.map(formatIncomingForHistory)).toEqual(['在吗', '在的'])
    // 私聊的 sender 就是对方本人，与会话标题重复，不再往正文里塞
    const group = byConv.get('pcwechat:123@chatroom') ?? []
    expect(group.map(formatIncomingForHistory)).toEqual(['小舅：周末回不回来'])
  })

  it('非文本 / 空正文：历史里也得留下一条，不能静默空掉', () => {
    expect(formatIncomingForHistory({ ts: 1, talker: 'wxid_loop', text: '' })).toBe('（非文本消息）')
    expect(formatIncomingForHistory({ ts: 1, talker: 'wxid_loop', text: '[非文本消息]' })).toBe(
      '[非文本消息]',
    )
  })
})

describe('formatWechatProfiles（代聊每轮注入的画像前缀）', () => {
  it('剥掉落盘文件的元数据行，只留正文档', () => {
    const out = formatWechatProfiles([
      { label: '关于我（本人）', content: '<!-- wechat-distill scope=self updated=2026-10-08 22:00:00 -->\n说话简短。' },
    ])
    expect(out).toContain('## 关于我（本人）\n说话简短。')
    expect(out).not.toContain('<!--')
  })

  it('两份画像都拼进去，顺序是「我」在前', () => {
    const out = formatWechatProfiles([
      { label: '关于我（本人）', content: '说话简短' },
      { label: '关于这个人', content: '韩玉，同事' },
    ])
    expect(out.indexOf('说话简短')).toBeLessThan(out.indexOf('韩玉，同事'))
  })

  it('没有一份可用（没蒸馏过 / 空正文 / 只有元数据）→ 空串，调用方据此不注入', () => {
    expect(formatWechatProfiles([])).toBe('')
    expect(formatWechatProfiles([{ label: '关于我（本人）', content: '' }])).toBe('')
    expect(formatWechatProfiles([{ label: '关于我（本人）', content: '<!-- x -->\n  \n' }])).toBe('')
    // 一份空一份有 → 只注入有的那份，不因为缺一半就整体放弃
    const out = formatWechatProfiles([
      { label: '关于我（本人）', content: '' },
      { label: '关于这个人', content: '韩玉' },
    ])
    expect(out).toContain('韩玉')
    expect(out).not.toContain('关于我（本人）')
  })

  it('超长画像截断到上限（注入 = 内容进模型上下文，不能无限塞）', () => {
    const out = formatWechatProfiles([{ label: '关于这个人', content: 'x'.repeat(5000) }])
    expect(out).toContain('x'.repeat(WECHAT_PROFILE_MAX_CHARS))
    expect(out).not.toContain('x'.repeat(WECHAT_PROFILE_MAX_CHARS + 1))
  })

  it('缺画像时把「缺」这条事实写进提示词（Agent 才知道该先建再回）', () => {
    const out = formatWechatProfiles([
      { label: '关于这个人', content: '', whenMissing: '这个人还没有画像——先建一份再回。' },
    ])
    expect(out).toContain('## 关于这个人\n这个人还没有画像——先建一份再回。')
  })

  it('有正文时不写 whenMissing（否则等于叫它重建已有的画像）', () => {
    const out = formatWechatProfiles([
      { label: '关于这个人', content: '韩玉，家人', whenMissing: '还没有画像——先建再回。' },
    ])
    expect(out).toContain('韩玉，家人')
    expect(out).not.toContain('还没有画像')
  })

  it('没给 whenMissing 的缺失项安静跳过（MCP 没连上时不误导模型去重建）', () => {
    expect(formatWechatProfiles([{ label: '关于这个人', content: '' }])).toBe('')
  })
})

/**
 * 锁屏/抢不到前台时的那条队列。
 *
 * 盯死三件事：**同一句只排一次**（回路重试不该把队列撑大）、**本人已回过话就不补**
 * （几十分钟前的草稿发出去比不发更怪）、**门还关着就停手**（绝不重复发第二条）。
 */
describe('待补发队列（发送门够不着时排队，门开了自动补发）', () => {
  const cfgOutbox = parseWechatWatchConfig({
    defaultMode: 'notify',
    groups: [{ name: '好友', mode: 'auto', peers: ['Loop'] }],
  })

  /** poll_new 无新消息 + 按工具分流的 MCP 桩；`send` 决定发送门开没开 */
  function outboxDeps(
    opts: { send?: (n: number) => string; lastFromMe?: boolean; lastFromMeTs?: number } = {},
  ) {
    const { d, callMcpTool, kv } = deps({ config: cfgOutbox, nowMs: () => Date.now() })
    let sends = 0
    callMcpTool.mockImplementation(async (_s: string, tool: string) => {
      if (tool === 'read_history') {
        // 默认取「入队之后」的秒（时钟往后挪一分钟只为满足判据），正是"期间已回过话"的形态
        const ts = opts.lastFromMeTs ?? Math.floor(Date.now() / 1000) + 60
        return JSON.stringify({
          messages: [
            opts.lastFromMe === true ? { from_me: true, ts } : { from_me: false, ts },
          ],
        })
      }
      if (tool === 'send_text') {
        sends += 1
        return opts.send ? opts.send(sends) : JSON.stringify({ ok: true, dry_run: false })
      }
      return JSON.stringify({ count: 0, messages: [], next_since_ts: 2000 })
    })
    return { d, callMcpTool, kv, sent: () => sends }
  }

  it('入队去重（同一 (peer, 文本) 只留一条）；空 peer / 空文本直接丢', () => {
    const { db } = fakeDb()
    const d = db as never
    enqueueWechatOutbox(d, '', 'x')
    enqueueWechatOutbox(d, 'wxid_a', '   ')
    enqueueWechatOutbox(d, 'wxid_a', '早')
    enqueueWechatOutbox(d, 'wxid_a', '早')
    enqueueWechatOutbox(d, 'wxid_a', '九点零三分')
    expect(readWechatOutbox(d).map((x) => x.text)).toEqual(['早', '九点零三分'])
  })

  it('空闲拍补发并清队；摘要里报补了几条', async () => {
    const { d, kv, sent } = outboxDeps()
    const db = d.getDb()
    enqueueWechatOutbox(db, 'wxid_s6piyhfvptv522', '10月9号 周五')
    const out = await runWechatWatch(d)
    expect(out).toBe('无新消息｜补发 1 条')
    expect(sent()).toBe(1)
    expect(readWechatOutbox(db)).toEqual([])
    expect(kv.get('wechat_watch_last_ts')).toBe('2000')
  })

  it('末条是本人发的、且晚于入队 → 不补、直接丢弃（期间用户自己回过话了）', async () => {
    const { d, sent } = outboxDeps({ lastFromMe: true })
    const db = d.getDb()
    enqueueWechatOutbox(db, 'wxid_s6piyhfvptv522', '10月9号 周五')
    await runWechatWatch(d)
    expect(sent()).toBe(0)
    expect(readWechatOutbox(db)).toEqual([])
  })

  it('末条 from_me 但是**入队之前**的老消息 → 不算已回过话，照补', async () => {
    // 2026-10-09 15:34 实测：15:33 排队的「15:34」被 14:53 那条附件判成"本人已回过话"而
    // 静默丢弃——那条回复其实从没发出去。判据只看 from_me 就是这个下场。
    const { d, sent } = outboxDeps({
      lastFromMe: true,
      lastFromMeTs: Math.floor(Date.now() / 1000) - 3600,
    })
    const db = d.getDb()
    enqueueWechatOutbox(db, 'wxid_s6piyhfvptv522', '15:34')
    expect(await runWechatWatch(d)).toBe('无新消息｜补发 1 条')
    expect(sent()).toBe(1)
    expect(readWechatOutbox(db)).toEqual([])
  })

  it('门还关着：留队、停手，不重复发第二条', async () => {
    const { d, sent } = outboxDeps({
      send: () => JSON.stringify({ ok: false, error_code: 'env_not_ready' }),
    })
    const db = d.getDb()
    enqueueWechatOutbox(db, 'wxid_s6piyhfvptv522', '一')
    enqueueWechatOutbox(db, 'wxid_7igswtmzj7nr22', '二')
    const out = await runWechatWatch(d)
    expect(sent()).toBe(1) // 撞了一次门就停，不把第二条也捅上去
    expect(readWechatOutbox(db)).toHaveLength(2)
    expect(out).toBe('无新消息')
  })

  it('补发有节流：连着两拍不会各撞一次门', async () => {
    const { d, sent } = outboxDeps({
      send: () => JSON.stringify({ ok: false, error_code: 'env_not_ready' }),
    })
    enqueueWechatOutbox(d.getDb(), 'wxid_s6piyhfvptv522', '一')
    await runWechatWatch(d)
    await runWechatWatch(d)
    expect(sent()).toBe(1)
  })

  it('过期（>30 分钟）的不再补——迟到的问候不如不发', async () => {
    const { d, callMcpTool, sent } = outboxDeps()
    const db = d.getDb()
    enqueueWechatOutbox(db, 'wxid_s6piyhfvptv522', '早')
    const future = Date.now() + 31 * 60_000
    const out = await runWechatWatch({ ...d, nowMs: () => future })
    expect(out).toBe('无新消息')
    expect(sent()).toBe(0)
    expect(readWechatOutbox(db)).toEqual([])
    // 全程只有本拍那次 poll_new：过期判定在**碰微信之前**，不该白读一次历史
    expect(callMcpTool.mock.calls.map((c) => c[1])).toEqual(['poll_new'])
  })

  it('这一拍有活回合 → 不补发（不跟回合抢那双手）', async () => {
    const { d, callMcpTool, sent } = outboxDeps()
    const db = d.getDb()
    enqueueWechatOutbox(db, 'wxid_s6piyhfvptv522', '早')
    callMcpTool.mockImplementation(async (_s: string, tool: string) => {
      if (tool === 'poll_new') {
        return JSON.stringify({
          count: 1,
          messages: [{ ts: 1990, name: 'Loop', talker: 'wxid_s6piyhfvptv522', from_me: false, text: '在吗' }],
          next_since_ts: 1990,
        })
      }
      return JSON.stringify({ ok: true, dry_run: false })
    })
    // 名单里的人是 wxid_...，消息里是同一个 talker，会被 policy 命中 → 这一轮非空闲
    await runWechatWatch({ ...d, driveTurn: undefined })
    expect(sent()).toBe(0)
    expect(readWechatOutbox(db)).toHaveLength(1)
  })
})

describe('画像巡检（空闲拍给名单里的人补画像）', () => {
  // 名单里就一个人（还只是显示名，没有 wxid），巡检的"谁缺画像"判断才有确定的答案
  const cfgSweep = parseWechatWatchConfig({
    defaultMode: 'notify',
    groups: [{ name: '好友', mode: 'auto', peers: ['Loop'] }],
  })
  const files = (...scopes: string[]) => JSON.stringify({ dir: 'x', files: scopes.map((s) => `contacts/${s}.md`) })

  it('只认 contacts/<scope>.md；self.md 不是"某个人"，认不出的忽略', () => {
    expect(profileScopesFromFiles(['contacts/a.md', 'self.md', 'contacts/b.md', 'junk', 7])).toEqual([
      'a',
      'b',
    ])
    expect(profileScopesFromFiles(undefined)).toEqual([])
  })

  it('挑第一个没画像的；ignore 档不挑', () => {
    const peers = [
      { id: 'wxid_a', label: 'A', mode: 'auto' as const },
      { id: 'wxid_b', label: 'B', mode: 'auto' as const },
      { id: 'wxid_c', label: 'C', mode: 'ignore' as const },
    ]
    expect(pickProfileSweepTarget(peers, ['wxid_a'])).toEqual({ id: 'wxid_b', label: 'B' })
    expect(pickProfileSweepTarget(peers, ['wxid_a', 'wxid_b'])).toBeUndefined()
    // 显示名匹配也算「已有画像」（老配置是按名字写的，文件名却可能是 wxid）
    expect(pickProfileSweepTarget(peers, ['A'])).toEqual({ id: 'wxid_b', label: 'B' })
  })

  it('提示词写死"别发微信"（代聊的 systemPrompt 是鼓励回话的，不写就可能凭空发一句）', () => {
    const p = buildProfileSweepPrompt('韩玉', 'wxid_h')
    expect(p).toContain('wechat_digest')
    expect(p).toContain('不要给微信里的任何人发消息')
    expect(p).toContain('wxid_h')
  })

  it('空闲拍驱动一轮巡检：给还没画像的那个人，且提示词里禁发消息', async () => {
    const driveTurn = vi.fn(async () => '已建画像')
    const { d, callMcpTool } = deps({ config: cfgSweep, driveTurn, nowMs: () => 1_800_000_000 })
    callMcpTool.mockImplementation(async (_s: string, tool: string) =>
      tool === 'wechat_profile_get'
        ? files('wxid_loop')
        : JSON.stringify({ messages: [], next_since_ts: 2000 }),
    )
    const out = await runWechatWatch(d)
    expect(out).toContain('画像巡检')
    expect(driveTurn).toHaveBeenCalledTimes(1)
    const [prompt, meta] = driveTurn.mock.calls[0] as unknown as [
      string,
      { incoming: unknown[]; peer: string },
    ]
    expect(prompt).toContain('不要给微信里的任何人发消息')
    expect(meta.incoming).toEqual([])
    // 名单里那条是显示名「Loop」，已有画像的文件名是 wxid → 名字条目没对上，仍算"缺"
    // （巡检是机会性的，不值得为它加一套"人名→wxid"解析；下一拍自愈后就对上了）
    expect(meta.peer).toBe('Loop')
  })

  it('30 分钟节流：紧接着下一拍不再巡检（否则每 15 秒叫一轮模型）', async () => {
    const driveTurn = vi.fn(async () => 'ok')
    const { d, callMcpTool } = deps({ config: cfgSweep, driveTurn, nowMs: () => 1_800_000_000 })
    callMcpTool.mockImplementation(async (_s: string, tool: string) =>
      tool === 'wechat_profile_get' ? files('wxid_loop') : JSON.stringify({ messages: [], next_since_ts: 2000 }),
    )
    await runWechatWatch(d)
    expect(driveTurn).toHaveBeenCalledTimes(1)
    const out2 = await runWechatWatch(d)
    expect(driveTurn).toHaveBeenCalledTimes(1)
    expect(out2).toBe('无新消息')
  })

  it('画像清单读不到（MCP 没连/怪形状）→ 什么都不做，不空跑模型', async () => {
    const driveTurn = vi.fn(async () => 'ok')
    const { d, callMcpTool } = deps({ config: cfgSweep, driveTurn, nowMs: () => 1_800_000_000 })
    callMcpTool.mockImplementation(async (_s: string, tool: string) =>
      tool === 'wechat_profile_get' ? '{"error":"boom"}' : JSON.stringify({ messages: [], next_since_ts: 2000 }),
    )
    expect(await runWechatWatch(d)).toBe('无新消息')
    expect(driveTurn).not.toHaveBeenCalled()
  })

  it('名单里人人都有画像 → 不驱动', async () => {
    const driveTurn = vi.fn(async () => 'ok')
    const { d, callMcpTool } = deps({ config: cfgSweep, driveTurn, nowMs: () => 1_800_000_000 })
    callMcpTool.mockImplementation(async (_s: string, tool: string) =>
      tool === 'wechat_profile_get'
        ? files('Loop')
        : JSON.stringify({ messages: [], next_since_ts: 2000 }),
    )
    expect(await runWechatWatch(d)).toBe('无新消息')
    expect(driveTurn).not.toHaveBeenCalled()
  })
})

describe('ensureWechatWatchConfigFile', () => {
  it('首次写出默认配置；已存在则不动（用户改过的不许被覆盖）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wxwatch-'))
    const p = path.join(dir, 'wechat-watch.json')
    ensureWechatWatchConfigFile(p)
    const first = JSON.parse(fs.readFileSync(p, 'utf-8'))
    expect(first.enabled).toBe(true)
    expect(first.blacklist).toEqual(['filehelper'])
    expect(typeof first._hint).toBe('string')
    fs.writeFileSync(p, JSON.stringify({ enabled: false, defaultMode: 'ignore' }), 'utf-8')
    ensureWechatWatchConfigFile(p)
    expect(JSON.parse(fs.readFileSync(p, 'utf-8'))).toEqual({ enabled: false, defaultMode: 'ignore' })
  })
})

describe('ensureWechatWatchCronJobSeeded', () => {
  it('首次播种：agent_id 为 NULL（走确定性处理器、不叫模型）', () => {
    const runs: unknown[][] = []
    const db = {
      prepare: vi.fn((sql: string) => ({
        get: () => undefined,
        run: (...args: unknown[]) => {
          runs.push([sql, ...args])
          return { changes: 1 }
        },
      })),
    }
    ensureWechatWatchCronJobSeeded(db as never, { mcpConfigured: true })
    const insert = runs.find((r) => String(r[0]).includes('INSERT INTO local_cron_jobs'))
    expect(insert).toBeTruthy()
    expect(String(insert![0])).toContain("'every'")
    expect(String(insert![0])).toContain('NULL')
    expect(insert).toContain(WECHAT_WATCH_INSTRUCTION)
    expect(insert).toContain(15_000)
  })

  it('未配置 wechat-local MCP：不建任务（客户端不依赖微信 MCP）', () => {
    const runs: unknown[][] = []
    const db = { prepare: vi.fn(() => ({ get: () => undefined, run: (...a: unknown[]) => { runs.push(a); return { changes: 1 } } })) }
    ensureWechatWatchCronJobSeeded(db as never, { mcpConfigured: false })
    expect(runs).toHaveLength(0)
  })

  it('未配置 MCP 但任务已存在：停掉它，避免任务页里一条永远「未连接」的循环', () => {
    const runs: unknown[][] = []
    const db = {
      prepare: vi.fn((sql: string) => ({
        get: () => ({ id: 'wechat-watch' }),
        run: (...args: unknown[]) => { runs.push([sql, ...args]); return { changes: 1 } },
      })),
    }
    ensureWechatWatchCronJobSeeded(db as never, { mcpConfigured: false })
    expect(String(runs[0][0])).toContain('SET enabled = 0')
  })

  it('已存在：把形态改回来（interval/agent_id/schedule_type）', () => {
    const runs: unknown[][] = []
    const db = {
      prepare: vi.fn((sql: string) => ({
        get: () => ({ id: 'wechat-watch' }),
        run: (...args: unknown[]) => {
          runs.push([sql, ...args])
          return { changes: 1 }
        },
      })),
    }
    ensureWechatWatchCronJobSeeded(db as never, { mcpConfigured: true })
    const upd = runs.find((r) => String(r[0]).includes('UPDATE local_cron_jobs'))
    expect(String(upd![0])).toContain('agent_id = NULL')
    expect(upd).toContain(15_000)
  })
})
