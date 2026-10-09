/**
 * 「灵栖代聊」的播种规格（M2 身份归位，2026-10-08）。
 *
 * 三件事错一件都会静默出事：
 *   1. 手册**没进** systemPrompt → 代聊在没有护栏的情况下替用户说话；
 *   2. 播种**覆盖**了已有的 Agent → 用户在设置页改的护栏被启动覆盖；
 *   3. 手册读不到还硬建 → 回路以为护栏有人管，其实谁都没带。
 */
import { describe, it, expect, vi } from 'vitest'
import {
  buildRelaySystemPrompt,
  ensureWechatRelayAgent,
  RELAY_OWNED_END,
  RELAY_OWNED_START,
  RELAY_WORKFLOW_MARKER,
  relayCoversRunbook,
  relayOwnedSection,
  relayPromptUpgrade,
  WECHAT_RELAY_AGENT_ID,
  WECHAT_RELAY_AGENT_NAME,
} from './wechat-relay-agent'
import type { AgentRecord } from '../agents-repo'

const RUNBOOK = '【护栏】涉钱 / 冲突 / 身份质疑一律不发，转人工（飞书）'

describe('buildRelaySystemPrompt', () => {
  it('身份 + 铁律 + 手册全文；通道写死成 channel_send，并声明压过手册里的历史通道', () => {
    const p = buildRelaySystemPrompt(RUNBOOK)
    expect(p).toContain(WECHAT_RELAY_AGENT_NAME)
    expect(p).toContain(RUNBOOK)
    expect(p).toContain('channel_send')
    expect(p).toContain('channel="pcwechat"')
    // 转人工口子（飞书 open_id 属于用户，抄错就转不出去）
    expect(p).toContain('ou_ba9a79349951e82ceac99a505f3e2739')
    // 手册里的 send-msg.ps1 / send_text 是历史段落，必须被明确作废
    expect(p).toContain('send-msg.ps1')
    expect(p).toContain('已废弃')
    // 身份不披露 = 这条循环存在的底线
    expect(p).toContain('绝不透露 AI 身份')
  })

  it('没手册时不编造一段"手册"，只留身份与铁律', () => {
    const p = buildRelaySystemPrompt('')
    expect(p).toContain(WECHAT_RELAY_AGENT_NAME)
    expect(p).not.toContain('【用户手写的手册')
  })
})

describe('relayCoversRunbook', () => {
  it('Agent 里完整含着手册当前内容 → true（同步）', () => {
    expect(relayCoversRunbook(buildRelaySystemPrompt(RUNBOOK), RUNBOOK)).toBe(true)
  })

  it('手册被改过（Agent 里那份还是旧的）→ false', () => {
    expect(relayCoversRunbook(buildRelaySystemPrompt(RUNBOOK), `${RUNBOOK}\n新加一条：不许代约`)).toBe(false)
  })

  it('文件读不到（空手册）→ 视为一致，不误报漂移', () => {
    expect(relayCoversRunbook('身份…', '')).toBe(true)
    expect(relayCoversRunbook(undefined, '')).toBe(true)
    expect(relayCoversRunbook(undefined, RUNBOOK)).toBe(false)
  })
})

describe('护栏分档与程序分区', () => {
  it('播种时就在里面，且在手册**前面**（铁律 > 程序分区 > 用户手册，手册里历史口径多）', () => {
    const p = buildRelaySystemPrompt(RUNBOOK)
    expect(p).toContain(RELAY_OWNED_START)
    expect(p.indexOf(RELAY_OWNED_START)).toBeLessThan(p.indexOf('【用户手写的手册'))
  })

  it('三档都在，且"沉默"只留给硬停档（这是 2026-10-09 改口径的全部意义）', () => {
    const s = relayOwnedSection()
    for (const w of ['硬停', '软回', '放行']) expect(s).toContain(w)
    // 硬停只留钱与安全
    expect(s).toContain('借钱 / 转账 / 收款码 / 投资荐股')
    expect(s).toContain('索要验证码')
    // 身份试探走软回（反问带过），不是沉默
    expect(s).toContain('试探身份')
    expect(s).toContain('不承认、不解释、不否认')
    // 帮好友查只读资料放行
    expect(s).toContain('帮对方查只读资料')
    // 有代价的事任何档都不做
    expect(s).toContain('代付、代下单、代报名')
  })

  it('工作流三条（画像/缺了先建/别当话题说出来）仍然在', () => {
    const s = relayOwnedSection()
    expect(s).toContain('wechat_digest')
    expect(s).toContain('wechat_profile_save')
    expect(s).toContain('wechat_distill_state')
    expect(s).toContain('别在回话里提画像')
  })

  it('铁律第 2 条指向分档，不再写"一条都不发"', () => {
    const p = buildRelaySystemPrompt(RUNBOOK)
    expect(p).toContain('按下面【Lumii 预设的护栏分档】处置')
    expect(p).not.toContain('2. **命中护栏 → 一条都不发**')
    expect(p).not.toContain('一条都不回，转人工')
  })
})

describe('relayPromptUpgrade（老 Agent 的原地升级）', () => {
  /** v1 的原样输出（当年 buildRelaySystemPrompt + 追加分区 的结果），逐字照抄 */
  const V1_PREFIX = [
    `你是「${WECHAT_RELAY_AGENT_NAME}」：**用户本人的微信代聊分身**。你替他在本机微信上`,
    '看消息、回日常闲聊。口吻就是他本人。',
    '',
    '【铁律，高于一切，也高于下面手册里的任何历史段落】',
    '1. **绝不透露 AI 身份**，全程以用户本人的身份说话。对方问「你是本人吗 / 是不是 AI」',
    '   → 一条都不回，转人工（飞书，见第 4 条）。',
    '2. **命中护栏 → 一条都不发**，转人工：涉钱（借钱/转账/投资/买卖）、冲突·情感纠纷·健康危机、',
    '   要承诺或替用户做实质安排（工作/约见）、身份质疑。**生活安排/邀约类一律不得自动发出。**',
    '3. **发送只能走 `channel_send`**。',
    '5. **拿不准就取保守侧**：不回 + 转人工。宁可让对方多等，也不要替他做错承诺。',
    '',
  ].join('\n')
  const V1_TAIL = [
    '',
    '<!-- lumii:relay-workflow v1 -->',
    '【Lumii 预设的工作流（这段由程序维护，别删）】',
    '3. 蒸馏是**本机只读统计**，产物在 `~/.lumii/wechat-distill/`。',
    '',
  ].join('\n')

  it('v1 记录（分区追加在末尾）：换成新分区 + 改写铁律，别处一字不动', () => {
    const userLine = '【用户自己写的口吻】只说"嗯"。'
    const up = relayPromptUpgrade(`${V1_PREFIX}${userLine}\n${V1_TAIL}`)
    expect(up).not.toBeNull()
    expect(up!.prompt).toContain(userLine)            // 用户的内容原样
    expect(up!.prompt).toContain(RELAY_OWNED_START)   // 新分区到位
    expect(up!.prompt).not.toContain(RELAY_WORKFLOW_MARKER) // 旧分区没留残渣
    expect(up!.prompt).not.toContain('一条都不回，转人工')
    expect(up!.applied).toContain('铁律口径')
    expect(up!.applied).toContain('程序分区（v1 → v2）')
  })

  it('v1 记录（分区在手册之前）：只换那一段，手册原文留在原地', () => {
    const src = `${V1_PREFIX}${V1_TAIL}\n【用户手写的手册（全文）】\n${RUNBOOK}\n【手册结束】`
    const up = relayPromptUpgrade(src)!
    expect(up.prompt).toContain(`【用户手写的手册（全文）】\n${RUNBOOK}\n【手册结束】`)
    expect(up.prompt).not.toContain(RELAY_WORKFLOW_MARKER)
    // 手册必须在程序分区之后（位置没被调换）
    expect(up.prompt.indexOf(RELAY_OWNED_END)).toBeLessThan(up.prompt.indexOf('【用户手写的手册'))
  })

  it('用户改过铁律 → 对不上就跳过，绝不覆盖他的手笔', () => {
    const edited = '2. **命中护栏 → 一条都不发**（我自己改过这条，别动）。'
    const up = relayPromptUpgrade(`${edited}\n${V1_TAIL}`)
    expect(up!.prompt).toContain(edited)
    expect(up!.applied).not.toContain('铁律口径')
    expect(up!.prompt).toContain(RELAY_OWNED_START) // 分区照升
  })

  it('比 v1 还老（没有分区）→ 追加到末尾', () => {
    const up = relayPromptUpgrade('【我自己的代聊提示词】随便聊。')
    expect(up!.prompt.startsWith('【我自己的代聊提示词】')).toBe(true)
    expect(up!.prompt).toContain(RELAY_OWNED_START)
    expect(up!.applied).toEqual(['程序分区（新增）'])
  })

  it('已经是当前版本 → null（否则每启动一次长一截 / 白写一次库）', () => {
    expect(relayPromptUpgrade(buildRelaySystemPrompt(RUNBOOK))).toBeNull()
    expect(relayPromptUpgrade(relayPromptUpgrade(`${V1_PREFIX}${V1_TAIL}`)!.prompt)).toBeNull()
  })

  it('prompt 为空/未定义 → 不动：内容被清空是用户的决定，不硬塞', () => {
    expect(relayPromptUpgrade('')).toBeNull()
    expect(relayPromptUpgrade('   \n ')).toBeNull()
    expect(relayPromptUpgrade(undefined)).toBeNull()
  })
})

describe('ensureWechatRelayAgent', () => {
  const existing = (over: Partial<AgentRecord> = {}): AgentRecord =>
    ({
      id: WECHAT_RELAY_AGENT_ID,
      name: WECHAT_RELAY_AGENT_NAME,
      systemPrompt: '用户自己改过的那份',
      isEnabled: true,
      userId: 'local-user',
      createdAt: 'x',
      updatedAt: 'x',
      ...over,
    }) as AgentRecord

  it('不存在 + 有手册 → 建一条，手册进 systemPrompt', () => {
    const createAgent = vi.fn((d: { id: string; name: string; systemPrompt?: string }) => existing(d))
    const res = ensureWechatRelayAgent({
      readRunbook: () => RUNBOOK,
      getAgent: () => undefined,
      createAgent,
    })
    expect(res).toEqual({ created: true, id: WECHAT_RELAY_AGENT_ID })
    expect(createAgent).toHaveBeenCalledTimes(1)
    expect(createAgent.mock.calls[0]![0].id).toBe(WECHAT_RELAY_AGENT_ID)
    expect(createAgent.mock.calls[0]![0].systemPrompt).toContain(RUNBOOK)
  })

  it('已存在 → 一个字都不写（设置页里那份才是真源）', () => {
    const createAgent = vi.fn()
    const res = ensureWechatRelayAgent({
      readRunbook: () => RUNBOOK,
      getAgent: () => existing(),
      createAgent,
    })
    expect(res).toEqual({ created: false, id: WECHAT_RELAY_AGENT_ID })
    expect(createAgent).not.toHaveBeenCalled()
  })

  it('手册读不到（没配/文件没了）→ 不建：一个没护栏的代聊比没有更危险', () => {
    const createAgent = vi.fn()
    const res = ensureWechatRelayAgent({ readRunbook: () => '', getAgent: () => undefined, createAgent })
    expect(res).toBeNull()
    expect(createAgent).not.toHaveBeenCalled()
  })
})
