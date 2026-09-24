import { describe, it, expect } from 'vitest'
import { noticeFromEvent } from '@mtbot/pet-core'
import type { PetGoalResultEvent, PetSensingEvent } from '../../../shared/agent-runtime-events'
import {
  INITIAL_TURN_FACTS,
  advanceTurnFacts,
  extractTaskCompletion,
  isNoticeEvent,
  isPetMoodEvent,
  noticeActionLabel,
  toNoticeEvent,
} from './pet-notice-adapter'

/** task_complete 真完成的工具结果（形状与线上一致） */
const taskResult = (summary: string) => ({
  content: [{ type: 'text', text: JSON.stringify({ status: 'completed', summary }) }],
})

/** 本文件统一的宠物身份。2026-09-24 起 `pet:sensing` 也带 `petAgentId`（与回执同口径） */
const PET = 'pet:demo_cartoon_cat'

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
      // 宠物自己的目标回执（三期 T3.5）：走 report 档，与 Agent 事件同一张表
      'pet:goal:result',
      // 宠物感知到的一句话（四期 T4.2/T4.3）：同上
      'pet:sensing',
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

describe('toNoticeEvent —— 宠物目标回执（三期 T3.5）', () => {
  // ⚠ 夹具**按线上的类型构造**（`PetGoalResultEvent`，来自 shared/agent-runtime-events），
  // 不是照抄适配器的字段名：两边漂移时这条会**编译不过**，而不是安静地读成 undefined。
  // 2026-09-24 真机第一跑就是这么错的——气泡冒出来了，说的却是兜底文案「我去看过了」。
  const petEvent = (over: Partial<PetGoalResultEvent> = {}): PetGoalResultEvent => ({
    type: 'pet:goal:result',
    sessionKey: 'evolution:pet:demo_cartoon_cat',
    // 事件上带它，但适配器**不读**：气泡归属靠 sessionKey（已经把宠物编进去了）
    petAgentId: 'pet:demo_cartoon_cat',
    // 气泡幂等键靠它（见 `PetGoalResultEvent.goalId`）：漏传的形态是"宠物连栽两次，
    // 用户只在第一次听见动静"——第二次被当成重放挡掉，不报错
    goalId: 'goal-1',
    ok: true,
    text: '工作目录根下有这些：a、b、c',
    ...over,
  })

  it('原话进 summary、成败进 ok，会话键是宠物自己的会话', () => {
    const n = toNoticeEvent(petEvent(), INITIAL_TURN_FACTS)
    expect(n?.type).toBe('pet:goal:result')
    expect(n?.sessionKey).toBe('evolution:pet:demo_cartoon_cat')
    expect(n?.summary).toBe('工作目录根下有这些：a、b、c')
    expect(n?.ok).toBe(true)
  })

  it('goalId 原样透传（丢了的话第二次失败会被当成重放挡掉）', () => {
    expect(toNoticeEvent(petEvent({ goalId: 'goal-42' }), INITIAL_TURN_FACTS)?.goalId).toBe('goal-42')
  })

  it('失败时 ok=false（文案的前缀由 pet-core 加，宿主不改写宠物的话）', () => {
    const n = toNoticeEvent(petEvent({ ok: false, text: '那个目录读不到' }), INITIAL_TURN_FACTS)
    expect(n?.ok).toBe(false)
    expect(n?.summary).toBe('那个目录读不到')
  })

  it('空文案**不返回 null**：回执宁可含糊也不能吞', () => {
    // 与 task_complete 的验证门那次刻意不同——那次是其实没完成，别冒
    const n = toNoticeEvent(petEvent({ ok: false, text: '   ' }), INITIAL_TURN_FACTS)
    expect(n).not.toBeNull()
    expect(n?.summary).toBeUndefined() // 交给 pet-core 的兜底文案
  })

  it('不带 ok 字段时**不臆断失败**', () => {
    const n = toNoticeEvent(petEvent({ ok: undefined as unknown as boolean }), INITIAL_TURN_FACTS)
    expect(n?.ok).toBe(true)
  })

  it('别的类型不会被带上 ok（这个字段只有宠物那条事件用）', () => {
    const n = toNoticeEvent({ type: 'agent:turn:end', sessionKey: 's', durationMs: 1 }, INITIAL_TURN_FACTS)
    expect(n?.ok).toBeUndefined()
  })
})

describe('isPetMoodEvent —— 情绪归属（四期 T4.4）', () => {
  it('宠物自己的 → 采纳', () => {
    expect(isPetMoodEvent({ agentId: PET }, PET)).toBe(true)
  })

  it('**助手的 → 不采纳**（这条以前是坏的：宠物窗把助手的心情当成了自己的脸）', () => {
    expect(isPetMoodEvent({ agentId: 'assistant' }, PET)).toBe(false)
  })

  it('别的宠物 → 不采纳（换模型之后旧事件可能还在路上）', () => {
    expect(isPetMoodEvent({ agentId: 'pet:mao_pro' }, PET)).toBe(false)
  })

  it('**认不出主人时不猜**：没带 agentId、或自己的身份还没拿到，都返回 false', () => {
    // 猜错的形态是宠物为助手的情绪雀跃——不报错、日志里也看不出
    expect(isPetMoodEvent({}, PET)).toBe(false)
    expect(isPetMoodEvent({ agentId: PET }, null)).toBe(false)
    expect(isPetMoodEvent({ agentId: undefined }, null)).toBe(false)
  })
})

describe('toNoticeEvent —— 宠物感知（四期 T4.2/T4.3）', () => {
  // ⚠ 与上面那条同一条纪律：**按线上的类型构造**（`PetSensingEvent`），
  // 不是照抄适配器的字段名。两边漂移时这里会编译不过。
  const sensingEvent = (over: Partial<PetSensingEvent> = {}): PetSensingEvent => ({
    type: 'pet:sensing',
    petAgentId: PET,
    // 注意：这条是**用户正在用的那条会话**，不是宠物自己的（宠物目标那条反过来）
    sessionKey: 'conv-user-1',
    text: '要不要歇会儿',
    kind: 'interrupted',
    ...over,
  })

  it('原话进 summary，会话键是你在用的那条', () => {
    const n = toNoticeEvent(sensingEvent(), INITIAL_TURN_FACTS)
    expect(n?.type).toBe('pet:sensing')
    expect(n?.sessionKey).toBe('conv-user-1')
    expect(n?.summary).toBe('要不要歇会儿')
  })

  it('**不带 ok**：感知类没有成败可言，别把回执那套语义捎过来', () => {
    const n = toNoticeEvent(sensingEvent(), INITIAL_TURN_FACTS)
    expect(n?.ok).toBeUndefined()
  })

  it('`kind` 与空文案都照原样交给 pet-core——**空的不在这里返回 null**', () => {
    // 丢不丢由 pet-core 决定（感知类没有内容就整条不产生），宿主只管搬运
    const empty = toNoticeEvent(sensingEvent({ text: '   ' }), INITIAL_TURN_FACTS)
    expect(empty).not.toBeNull()
    expect(empty?.summary).toBeUndefined()
  })
})

/**
 * 五期 T5.1②：感知带上来的"可以派它去做"的一件事。
 *
 * 这条链路上最容易错的是**按钮文案**：同一个 `pet:sensing` kind，有建议时是
 * "让我去看看"（真的派活），没有时是"回到刚才"（跳会话）。文案与行为必须同源，
 * 否则用户会按下一个说"去看看"、实际只把主窗切了个会话的按钮。
 */
describe('宠物感知的建议（五期 T5.1②）', () => {
  const withProposal = (description: string): PetSensingEvent => ({
    type: 'pet:sensing',
    petAgentId: PET,
    sessionKey: 'conv-user-1',
    text: '要不要歇会儿',
    kind: 'interrupted',
    proposal: { description },
  })

  /**
   * 没有建议的那条。
   *
   * 走一个**有类型的变量**而不是把字面量直接塞进 `toNoticeEvent`：
   * 后者的形参是 `RawAgentEvent`（它刻意不认识 `kind`，见那个接口的注释），
   * 字面量会撞多余属性检查——而这条用例要问的正是"线上那条事件长这样，结果如何"。
   */
  const withoutProposal = (): PetSensingEvent => ({
    type: 'pet:sensing',
    petAgentId: PET,
    sessionKey: 'conv-user-1',
    text: '要不要歇会儿',
    kind: 'interrupted',
  })

  it('建议原样搬过去（pet-core 与主进程都不该改写它）', () => {
    const n = toNoticeEvent(withProposal('查一下「像素流水线」相关的资料'), INITIAL_TURN_FACTS)
    expect(n?.proposal).toEqual({ description: '查一下「像素流水线」相关的资料' })
  })

  it('没有建议时字段是 undefined，不是空对象', () => {
    const n = toNoticeEvent(withoutProposal(), INITIAL_TURN_FACTS)
    expect(n?.proposal).toBeUndefined()
  })

  it('有建议 → 按钮是"让我去看看"', () => {
    // 造一条真通知（经 pet-core），再问它的按钮文案——两端的约定在这里合上
    const notice = noticeFromEvent(
      toNoticeEvent(withProposal('查一下「像素流水线」相关的资料'), INITIAL_TURN_FACTS)!,
      { now: 1_000_000 },
    )
    expect(notice).not.toBeNull()
    expect(noticeActionLabel(notice!)).toBe('让我去看看')
  })

  it('没有建议 → 按钮还是"回到刚才"（对照组：别把这个默认值改掉）', () => {
    const notice = noticeFromEvent(
      toNoticeEvent(withoutProposal(), INITIAL_TURN_FACTS)!,
      { now: 1_000_000 },
    )
    expect(noticeActionLabel(notice!)).toBe('回到刚才')
  })

  it('建议是空白串时不产生 proposal（按钮保持"回到刚才"）', () => {
    const notice = noticeFromEvent(
      toNoticeEvent(withProposal('   '), INITIAL_TURN_FACTS)!,
      { now: 1_000_000 },
    )
    expect(notice?.proposal).toBeUndefined()
  })
})
