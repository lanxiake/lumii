import { describe, it, expect } from 'vitest'
import {
  INITIAL_TURN_FACTS,
  advanceTurnFacts,
  extractTaskCompletion,
  isNoticeEvent,
  toNoticeEvent,
  type RawAgentEvent,
} from './pet-notice-adapter'

/** task_complete 真完成的工具结果（形状与线上一致） */
const taskResult = (summary: string) => ({
  content: [{ type: 'text', text: JSON.stringify({ status: 'completed', summary }) }],
})

/** 验证门那次：**不是**完成，但 `isError` 是 false（线上实测抓到的形态） */
const verificationGateResult = () => ({
  content: [
    {
      type: 'text',
      text: '提示：本次未检测到验证步骤（未运行 test/build/lint）。若确认无需验证，请再次调用 task_complete 即可放行。',
    },
  ],
})

describe('isNoticeEvent —— 热路径上的那道闸', () => {
  it('产生类与销账类都放行', () => {
    for (const type of [
      'agent:tool:end',
      'agent:turn:end',
      'agent:permission:request',
      'agent:permission:prompt',
      'agent:ask-user:request',
      'agent:subagent:completed',
      'agent:error',
      'agent:abort',
      'agent:turn:file-changes',
      'agent:permission:granted',
      'agent:permission:denied',
      'agent:permission:timeout',
      'agent:permission:prompt:granted',
      'agent:permission:prompt:denied',
      'agent:permission:prompt:timeout',
      'agent:permission:prompt:cancelled',
      'agent:ask-user:cancelled',
    ]) {
      expect(isNoticeEvent(type), type).toBe(true)
    }
  })

  it('逐 token 的流式事件与过程事件一律挡掉', () => {
    for (const type of [
      'agent:message:delta',
      'agent:thinking:delta',
      'agent:tool:start',
      'agent:tool:progress',
      'agent:message:start',
      'agent:message:end',
      'agent:turn:start',
      'agent:context:compacted',
      'autonomous:mood:emotion',
    ]) {
      expect(isNoticeEvent(type), type).toBe(false)
    }
  })
})

describe('extractTaskCompletion —— 只认「真的完成」', () => {
  it('status=completed 时取 summary', () => {
    expect(extractTaskCompletion(taskResult('把文档整理完了'))).toEqual({
      completed: true,
      summary: '把文档整理完了',
    })
  })

  it('**验证门那次不算完成**（isError=false 但 status 不是 completed）', () => {
    // 2026-09-23 跑 E2E 抓到的：不区分的话一轮会冒两次「做完了」，第一次那句还是假的
    expect(extractTaskCompletion(verificationGateResult())).toEqual({ completed: false })
  })

  it('解析失败 / 形状不符 / 缺 status → completed:false，且**不抛**', () => {
    expect(extractTaskCompletion(undefined)).toEqual({ completed: false })
    expect(extractTaskCompletion(null)).toEqual({ completed: false })
    expect(extractTaskCompletion({})).toEqual({ completed: false })
    expect(extractTaskCompletion({ content: [] })).toEqual({ completed: false })
    expect(extractTaskCompletion({ content: [{ type: 'text', text: '不是 JSON' }] })).toEqual({
      completed: false,
    })
    expect(
      extractTaskCompletion({ content: [{ type: 'text', text: '{"summary":"没有 status"}' }] }),
    ).toEqual({ completed: false })
  })

  it('completed 但 summary 是空白 → 仍算完成，只是不带摘要（pet-core 用兜底文案）', () => {
    expect(
      extractTaskCompletion({ content: [{ type: 'text', text: '{"status":"completed","summary":"  "}' }] }),
    ).toEqual({ completed: true, summary: undefined })
  })

  it('非 text 的 content 块不参与', () => {
    const result = { content: [{ type: 'image', text: '{"status":"completed","summary":"假的"}' }] }
    expect(extractTaskCompletion(result)).toEqual({ completed: false })
  })
})

describe('toNoticeEvent', () => {
  const facts = INITIAL_TURN_FACTS

  it('会话键按 rootSessionKey 归一（子 Agent 各有一把 key，共用一个 root）', () => {
    const n = toNoticeEvent(
      { type: 'agent:permission:request', sessionKey: 'child-1', rootSessionKey: 'root-1' },
      facts,
    )
    expect(n?.sessionKey).toBe('root-1')
  })

  it('没有 rootSessionKey 时退回 sessionKey', () => {
    const n = toNoticeEvent({ type: 'agent:ask-user:request', sessionKey: 'solo' }, facts)
    expect(n?.sessionKey).toBe('solo')
  })

  it('没有会话键 / 空白会话键 → null（折进去也点不动）', () => {
    expect(toNoticeEvent({ type: 'agent:error' }, facts)).toBeNull()
    expect(toNoticeEvent({ type: 'agent:error', sessionKey: '   ' }, facts)).toBeNull()
  })

  it('没有 type → null', () => {
    expect(toNoticeEvent({ sessionKey: 's' }, facts)).toBeNull()
  })

  it('子 Agent 的 name/status 映射到 subagentName/subagentStatus', () => {
    const n = toNoticeEvent(
      { type: 'agent:subagent:completed', sessionKey: 's', name: '查资料', status: 'failed' },
      facts,
    )
    expect(n?.subagentName).toBe('查资料')
    expect(n?.subagentStatus).toBe('failed')
  })

  it('fileChanges 折算成 fileCount', () => {
    const n = toNoticeEvent(
      { type: 'agent:turn:file-changes', sessionKey: 's', fileChanges: [{}, {}, {}] },
      facts,
    )
    expect(n?.fileCount).toBe(3)
  })

  it('只有 task_complete 才解析 summary', () => {
    const withTask = toNoticeEvent(
      { type: 'agent:tool:end', sessionKey: 's', toolName: 'task_complete', result: taskResult('完成了') },
      facts,
    )
    expect(withTask?.summary).toBe('完成了')
    const withBash = toNoticeEvent(
      { type: 'agent:tool:end', sessionKey: 's', toolName: 'bash', result: taskResult('不该被解析') },
      facts,
    )
    expect(withBash?.summary).toBeUndefined()
  })

  it('**验证门那次的 task_complete 整条丢掉**（不是"传空摘要用兜底文案"）', () => {
    const n = toNoticeEvent(
      {
        type: 'agent:tool:end',
        sessionKey: 's',
        toolName: 'task_complete',
        isError: false,
        result: verificationGateResult(),
      },
      facts,
    )
    expect(n).toBeNull()
  })

  it('本轮事实被原样带上（pet-core 用它让 turn:end 让位）', () => {
    const n = toNoticeEvent({ type: 'agent:turn:end', sessionKey: 's', durationMs: 200_000 }, {
      sawTaskComplete: true,
      userInitiated: false,
    })
    expect(n?.hasTaskComplete).toBe(true)
  })
})

describe('advanceTurnFacts', () => {
  it('turn:start 复位', () => {
    const before = { sawTaskComplete: true, userInitiated: true }
    expect(advanceTurnFacts(before, { type: 'agent:turn:start' })).toEqual(INITIAL_TURN_FACTS)
  })

  it('task_complete 真完成 → 立标志（这是 turn:end 让位的依据）', () => {
    const after = advanceTurnFacts(INITIAL_TURN_FACTS, {
      type: 'agent:tool:end',
      toolName: 'task_complete',
      isError: false,
      result: taskResult('完成了'),
    })
    expect(after.sawTaskComplete).toBe(true)
  })

  it('**验证门那次不立标志**（否则"验证门后被打断"那一轮会两头落空：既没完成通知、也没"跑完了"）', () => {
    const after = advanceTurnFacts(INITIAL_TURN_FACTS, {
      type: 'agent:tool:end',
      toolName: 'task_complete',
      isError: false,
      result: verificationGateResult(),
    })
    expect(after.sawTaskComplete).toBe(false)
  })

  it('失败的 task_complete 也不立标志', () => {
    const after = advanceTurnFacts(INITIAL_TURN_FACTS, {
      type: 'agent:tool:end',
      toolName: 'task_complete',
      isError: true,
    })
    expect(after.sawTaskComplete).toBe(false)
  })

  it('别的工具不动标志', () => {
    const after = advanceTurnFacts(INITIAL_TURN_FACTS, {
      type: 'agent:tool:end',
      toolName: 'bash',
    })
    expect(after).toBe(INITIAL_TURN_FACTS)
  })

  it('无关事件原样返回（引用相等，调用方据此跳过写回）', () => {
    const facts = { sawTaskComplete: false, userInitiated: false }
    expect(advanceTurnFacts(facts, { type: 'agent:message:delta' })).toBe(facts)
  })
})
