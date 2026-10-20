import type { DatabaseAdapter, PetGoalSignal } from '@mtbot/agent-runtime'

import { agentRuntimeLog as log } from '../bridge-utils'
import { persistPetTaskReceipt } from '../pet-task-store'

/**
 * 把一个宠物目标的结局播报出去：回执写进宠物会话 + 推气泡事件 + 再落一次库。
 *
 * **不落终态**——终态由各自那条路自己写（跑完/超时在 `runPetGoal`，
 * 被硬闸门拒/执行抛错在 `pet-dispatch` 的 `finishWithoutRun`）。一条路一个写者，
 * 不给同一行两个更新源。
 *
 * ⚠ 三期的缺口正在这里：全仓唯一的 `pet:goal:result` 发送点原本埋在成功路径末尾，
 * 另两条路只写了一条 WARN 日志，用户侧**零回执**。
 *
 * 从 bridge 搬出来是为了能测「写库失败不该吞掉播报」这条语义——
 * 它仨（会话消息 / 事件 / 持久回执）各自独立，一条失败不影响另外两条。
 */

export interface PetGoalReceiptDeps {
  db: DatabaseAdapter
  conversationIdFor(agentId: string): string
  ensureConversation(agentId: string, conversationId: string): void
  saveMessage?(message: {
    conversationId: string
    agentId: string
    role: 'user' | 'assistant'
    contentJson: { type: 'text'; text: string }
  }): unknown
  forwardEvent(payload: {
    type: 'pet:goal:result'
    sessionKey: string
    petAgentId: string
    goalId: string
    ok: boolean
    text: string
  }): void
}

export function reportPetGoalReceipt(
  goal: PetGoalSignal,
  ok: boolean,
  text: string,
  opts: { userTurn?: string },
  deps: PetGoalReceiptDeps,
): void {
  const convId = deps.conversationIdFor(goal.agentId)
  // 这条也顺带补建：被硬闸门拒 / 执行抛错那两条路**根本没建过实例**，
  // 会话可能还不存在，而回执是用户唯一能看见的东西（详见 ensurePetConversation）
  deps.ensureConversation(goal.agentId, convId)
  try {
    if (opts.userTurn) {
      deps.saveMessage?.({
        conversationId: convId,
        agentId: goal.agentId,
        role: 'user',
        contentJson: { type: 'text', text: opts.userTurn },
      })
    }
    deps.saveMessage?.({
      conversationId: convId,
      agentId: goal.agentId,
      role: 'assistant',
      contentJson: { type: 'text', text: text || '（没有产出）' },
    })
  } catch (err) {
    // 回执写库失败不该把一次已完成的目标炸成失败——日志是最后一道可见性
    log.warn(
      `[reportPetGoalResult] 回执写库失败 goalId=${goal.id}:`,
      err instanceof Error ? err.message : err,
    )
  }
  // 播报：**只推这一条事件**，宠物窗把它折成 report 档通知（气泡 + 控制坞一行）。
  // 不走 `showCronNotification` —— P3 断言：同一件事既冒气泡又弹系统通知就是重复打扰。
  //
  // 事件里带 `goalId`：气泡的幂等键靠它，光有文案的话"第二次失败"会被当成重放挡掉
  // （见 `pet-core` 的 notice.ts）。
  deps.forwardEvent({
    type: 'pet:goal:result',
    sessionKey: convId,
    petAgentId: goal.agentId,
    goalId: goal.id,
    ok,
    text,
  })
  /**
   * 回执**再落一次库**（五期 T5.8，设计 §4.2.2）。
   *
   * 上面那条事件与这条写库解决的是两件不同的事，缺一不可：
   * - 事件 = **当下被看见**（气泡），但它是瞬时的：用户点完「让它去做」去倒杯水，
   *   气泡对着空气说完就没了，回来什么都没有，以为没执行；
   * - 写库 = **回来能看到**（控制坞宠物流那条持久条目 + 未读高亮）。
   *
   * `t` 取**现在**而不是调用方传进来的时刻：这是一条"我报回来了"的时间戳，
   * 未读游标按它比大小，跨零点也不会错（与 `recordTokensIfLive` 同一条口径）。
   */
  persistPetTaskReceipt(deps.db, goal.id, ok, text, new Date().toISOString())
}
