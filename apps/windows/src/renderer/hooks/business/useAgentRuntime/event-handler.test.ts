/**
 * 渲染层事件处理：流式正文的最终兜底。
 *
 * 背景（2026-09-16 定时任务会话「只有我发的消息、没有回复」）：
 * 渲染侧的主 Agent `message:end` 只使用内存中 delta 累积的正文，
 * 完全忽略事件本身携带的最终文本（主进程已算好的完整回复）。
 * 一旦 delta 没到（IPC 丢失、窗口刚打开、渲染进程重启），
 * 这条回复在内存里就是空白 —— 空消息会被 UI 隐藏，看起来像 Agent 没回。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { resetRuntimeStore, runtimeStore } from './agent-runtime-store'
import { handleRuntimeEvent, resetAgentRuntimeEventHandlerForTests } from './event-handler'
import type { AgentRuntimeEvent } from '../../../../shared/agent-runtime-events'

const SESSION_KEY = 'cron:seed-morning-briefing'
const RUN_ID = 'run-bbcfab15'
const MESSAGE_ID = 'a30e6910e705ad539960d0b73973dcc1'
const FINAL_TEXT = '早间简报 · 2026-09-16 星期三\n1. 排查 TOCC→12345 未入库'

/** 走一遍 message:start → message:end 的最小回合（delta 由调用方决定是否补） */
function emitTurn(events: readonly Partial<AgentRuntimeEvent>[]): void {
  for (const e of events) handleRuntimeEvent(e as AgentRuntimeEvent)
}

function lastMessageText(): string {
  const msgs = runtimeStore.getState().sessions.get(SESSION_KEY)?.messages ?? []
  return msgs[msgs.length - 1]?.content[0]?.text ?? ''
}

describe('agent:message:end 的正文兜底', () => {
  beforeEach(() => {
    resetRuntimeStore()
    resetAgentRuntimeEventHandlerForTests()
  })

  it('delta 未到达时用事件携带的最终文本填充，回复不会显示成空白', () => {
    emitTurn([
      { type: 'agent:turn:start', runId: RUN_ID, sessionKey: SESSION_KEY, turnIndex: 0, timestamp: Date.now() },
      { type: 'agent:message:start', runId: RUN_ID, sessionKey: SESSION_KEY, messageId: MESSAGE_ID, model: 'test-model', timestamp: Date.now() },
      // delta 全部丢失（模拟）：渲染层没有任何增量可累积
      {
        type: 'agent:message:end',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        messageId: MESSAGE_ID,
        content: [{ type: 'text', text: FINAL_TEXT }],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      },
    ])

    expect(lastMessageText()).toContain('早间简报')
  })

  it('delta 正常到达时以流式累积为准，不被事件文本覆盖', () => {
    emitTurn([
      { type: 'agent:turn:start', runId: RUN_ID, sessionKey: SESSION_KEY, turnIndex: 0, timestamp: Date.now() },
      { type: 'agent:message:start', runId: RUN_ID, sessionKey: SESSION_KEY, messageId: MESSAGE_ID, model: 'test-model', timestamp: Date.now() },
      { type: 'agent:message:delta', runId: RUN_ID, sessionKey: SESSION_KEY, messageId: MESSAGE_ID, delta: '流式累积的正文', totalLength: 7 },
      {
        type: 'agent:message:end',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        messageId: MESSAGE_ID,
        content: [{ type: 'text', text: FINAL_TEXT }],
        usage: { inputTokens: 100, outputTokens: 50 },
        stopReason: 'end_turn',
      },
    ])

    expect(lastMessageText()).toBe('流式累积的正文')
  })

  it('续轮（tool_use 后继续）时，兜底文本追加在已有正文之后而不是覆盖', () => {
    emitTurn([
      { type: 'agent:turn:start', runId: RUN_ID, sessionKey: SESSION_KEY, turnIndex: 0, timestamp: Date.now() },
      { type: 'agent:message:start', runId: RUN_ID, sessionKey: SESSION_KEY, messageId: MESSAGE_ID, model: 'test-model', timestamp: Date.now() },
      { type: 'agent:message:delta', runId: RUN_ID, sessionKey: SESSION_KEY, messageId: MESSAGE_ID, delta: '第一轮正文', totalLength: 5 },
      // 第一轮结束（要调工具），保持流式
      {
        type: 'agent:message:end',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        messageId: MESSAGE_ID,
        content: [{ type: 'text', text: '第一轮正文' }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'tool_use',
      },
      // 第二轮：delta 丢失，事件带本轮最终文本
      { type: 'agent:message:start', runId: RUN_ID, sessionKey: SESSION_KEY, messageId: MESSAGE_ID, model: 'test-model', timestamp: Date.now() },
      {
        type: 'agent:message:end',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        messageId: MESSAGE_ID,
        content: [{ type: 'text', text: '第二轮正文' }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'end_turn',
      },
    ])

    const text = lastMessageText()
    expect(text).toContain('第一轮正文')
    expect(text).toContain('第二轮正文')
  })
})

/**
 * 中止标记（2026-09-20 冒烟实测）
 *
 * `isAborted` 此前全仓无写入方：气泡的「回复已中断」徽标与子运行块的「已中断」
 * 都读它，但正常中止（user:abort → pi-ai abort）只发 message:end(stopReason='aborted')，
 * 没人把它落到消息上——中止被显示成「已完成」。
 */
describe('agent:message:end 的中止标记', () => {
  beforeEach(() => {
    resetRuntimeStore()
    resetAgentRuntimeEventHandlerForTests()
  })

  function messagesOf(sessionKey = SESSION_KEY) {
    return runtimeStore.getState().sessions.get(sessionKey)?.messages ?? []
  }

  it('主消息 stopReason=aborted → 消息带 isAborted（气泡「回复已中断」的依据）', () => {
    emitTurn([
      { type: 'agent:turn:start', runId: RUN_ID, sessionKey: SESSION_KEY, turnIndex: 0, timestamp: Date.now() },
      { type: 'agent:message:start', runId: RUN_ID, sessionKey: SESSION_KEY, messageId: MESSAGE_ID, model: 'test-model', timestamp: Date.now() },
      { type: 'agent:message:delta', runId: RUN_ID, sessionKey: SESSION_KEY, messageId: MESSAGE_ID, delta: '说了一半', totalLength: 4 },
      {
        type: 'agent:message:end',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        messageId: MESSAGE_ID,
        content: [{ type: 'text', text: '说了一半' }],
        usage: { inputTokens: 10, outputTokens: 4 },
        stopReason: 'aborted',
      },
    ])

    expect(messagesOf().at(-1)?.isAborted).toBe(true)
  })

  it('中止的那轮正文为空（0 token、无 llmError）→ 不被「空消息」守卫吞掉，仍写 isAborted', () => {
    // 生产实测形状：中止发生在模型输出之前，content 空、usage 0 —— 恰好命中
    // message:end 顶部「0-token 空消息跳过」的全部条件（2026-09-20 冒烟：运行块因此显示已完成）
    emitTurn([
      { type: 'agent:turn:start', runId: RUN_ID, sessionKey: SESSION_KEY, turnIndex: 0, timestamp: Date.now() },
      { type: 'agent:message:start', runId: RUN_ID, sessionKey: SESSION_KEY, messageId: MESSAGE_ID, model: 'test-model', timestamp: Date.now() },
      {
        type: 'agent:message:end',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        messageId: MESSAGE_ID,
        content: [{ type: 'text', text: '' }],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'aborted',
      },
    ])

    expect(messagesOf().at(-1)?.isAborted).toBe(true)
  })

  it('正常 end_turn 不设 isAborted', () => {
    emitTurn([
      { type: 'agent:turn:start', runId: RUN_ID, sessionKey: SESSION_KEY, turnIndex: 0, timestamp: Date.now() },
      { type: 'agent:message:start', runId: RUN_ID, sessionKey: SESSION_KEY, messageId: MESSAGE_ID, model: 'test-model', timestamp: Date.now() },
      {
        type: 'agent:message:end',
        runId: RUN_ID,
        sessionKey: SESSION_KEY,
        messageId: MESSAGE_ID,
        content: [{ type: 'text', text: '好好说完了' }],
        usage: { inputTokens: 10, outputTokens: 5 },
        stopReason: 'end_turn',
      },
    ])

    expect(messagesOf().at(-1)?.isAborted).toBeUndefined()
  })

  it('子 Agent 消息同样带 isAborted（运行块「已中断」的依据）——空正文 + 0 token 的生产形状', () => {
    const SUB_SESSION = 'child-session-1'
    const SUB_MESSAGE_ID = 'sub-message-1'
    const SUB_INSTANCE = 'inst-sub-1'

    emitTurn([
      { type: 'agent:turn:start', runId: RUN_ID, sessionKey: SESSION_KEY, turnIndex: 0, timestamp: Date.now() },
      {
        type: 'agent:message:start',
        runId: RUN_ID,
        sessionKey: SUB_SESSION,
        rootSessionKey: SESSION_KEY,
        instanceId: SUB_INSTANCE,
        messageId: SUB_MESSAGE_ID,
        model: 'test-model',
        timestamp: Date.now(),
      },
      {
        type: 'agent:message:end',
        runId: RUN_ID,
        sessionKey: SUB_SESSION,
        rootSessionKey: SESSION_KEY,
        instanceId: SUB_INSTANCE,
        messageId: SUB_MESSAGE_ID,
        content: [{ type: 'text', text: '' }],
        usage: { inputTokens: 0, outputTokens: 0 },
        stopReason: 'aborted',
      },
    ])

    const sub = messagesOf().find((m) => m.id === SUB_MESSAGE_ID)
    expect(sub?.isAborted).toBe(true)
    expect(sub?.sourceAgent?.instanceId).toBe(SUB_INSTANCE)
  })
})
