/**
 * event-converter 回归保护
 *
 * 背景：同步抛错（未配置 API Key / 模型未启用）时，pi-agent-core 不会抛异常，
 * 而是把错误吞成 agent:end（经 mapAgentEvent 挂上 error 字段）。若 converter 不把它
 * 转成 agent:error，桌面端渲染进程收不到错误提示，表现为「发完消息毫无反应」。
 */

import { describe, expect, it } from 'vitest'
import {
  convertOldEventToIpcEvents,
  createRunContext,
  parseThinkTagsFromRaw,
} from './event-converter'
import type { AgentRuntimeEvent as OldEvent } from '@mtbot/agent-runtime'

const INSTANCE_ID = 'instance-1'
const SESSION_KEY = 'conversation-1'

describe('convertOldEventToIpcEvents agent:end', () => {
  it('同步抛错（带 error）转成 agent:error，让渲染进程弹 toast', () => {
    const ctx = createRunContext(SESSION_KEY, INSTANCE_ID, SESSION_KEY)
    const oldEvent = {
      type: 'agent:end',
      instanceId: INSTANCE_ID,
      error: '请先在设置中填写文本对话模型的 API Key',
    } as OldEvent

    const events = convertOldEventToIpcEvents(oldEvent, ctx)
    expect(events).toEqual([
      expect.objectContaining({
        type: 'agent:error',
        errorCode: 'AGENT_ERROR',
        errorMessage: '请先在设置中填写文本对话模型的 API Key',
        isRetryable: false,
      }),
    ])
  })

  it('正常结束（无 error）转成 turn:end + idle', () => {
    const ctx = createRunContext(SESSION_KEY, INSTANCE_ID, SESSION_KEY)
    const oldEvent = { type: 'agent:end', instanceId: INSTANCE_ID } as OldEvent

    const events = convertOldEventToIpcEvents(oldEvent, ctx)
    expect(events.map((e) => e.type)).toEqual(['agent:turn:end', 'agent:idle'])
  })
})

/**
 * parseThinkTagsFromRaw —— 内联 think 标签的落库侧剥离
 *
 * 2026-09-18：函数的文档注释一直写着"支持孤立 </think>"，实现却是把它当正文输出。
 * 后果是模型独白进正文并对用户可见——实测 8 条消息（cron:seed-morning-briefing 等）
 * 的 text part 里带着整段 `The user is asking about...`，UI 渲染的就是这串独白 + 正文。
 */
describe('parseThinkTagsFromRaw', () => {
  it('成对 <think>…</think>：推理归 thinking，正文归 final', () => {
    const r = parseThinkTagsFromRaw('<think>先想一下</think>\n\n这是正文。')
    expect(r.thinkingText).toBe('先想一下')
    expect(r.finalText).toBe('这是正文。')
  })

  it('孤立 </think>（DeepSeek 风格）：闭标签之前是推理，之后是正文', () => {
    const r = parseThinkTagsFromRaw(
      'The user is asking about the Civil Code.\n</think>\n\n中国《民法典》共七编。',
    )
    expect(r.thinkingText).toContain('The user is asking')
    expect(r.finalText).toBe('中国《民法典》共七编。')
    expect(r.finalText).not.toContain('The user is asking')
  })

  it('多个孤立 </think>：取最后一个，中间的独白不泄漏进正文', () => {
    const r = parseThinkTagsFromRaw('独白一\n</think>\n\n更多独白\n</think>\n\n真正的正文。')
    expect(r.finalText).toBe('真正的正文。')
    expect(r.finalText).not.toContain('独白')
    expect(r.thinkingText).toContain('独白一')
    expect(r.thinkingText).toContain('更多独白')
  })

  it('成对块 + 孤立闭标签混用：两者都剥离', () => {
    const r = parseThinkTagsFromRaw('<think>块内推理</think>\n\n散装独白\n</think>\n\n正文。')
    expect(r.finalText).toBe('正文。')
    expect(r.thinkingText).toContain('块内推理')
    expect(r.thinkingText).toContain('散装独白')
  })

  it('没有标签时原样返回（不能误伤含 "</think>" 字样的正常讨论）', () => {
    const raw = '这个模型的输出里有 think 标签，但没有闭标签。'
    const r = parseThinkTagsFromRaw(raw)
    expect(r.thinkingText).toBe('')
    expect(r.finalText).toBe(raw)
  })

  it('只有闭标签且后面为空：正文为空（该轮没有面向用户的话）', () => {
    const r = parseThinkTagsFromRaw('只有推理\n</think>\n\n')
    expect(r.thinkingText).toBe('只有推理')
    expect(r.finalText).toBe('')
  })

  it('闭标签前为空：不产生空的 thinking 段', () => {
    const r = parseThinkTagsFromRaw('</think>\n\n正文。')
    expect(r.thinkingText).toBe('')
    expect(r.finalText).toBe('正文。')
  })
})
