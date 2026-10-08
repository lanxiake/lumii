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
  relayCoversRunbook,
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
