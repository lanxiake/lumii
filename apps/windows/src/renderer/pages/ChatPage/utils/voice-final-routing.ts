/**
 * 语音定稿（final）该往哪走？——纯函数，便于单测。
 *
 * 背景（2026-11-01 计划 §3 P0-2）：
 * 旧逻辑只有「空闲就发、忙就塞输入框」两条路，而塞输入框时**主进程已经进了
 * thinking**（`submitToAgent` 里 transition 的），于是状态与消息两头落空：
 * AI 永远"思考中"，用户再说的话被攒起来永远等不到放行（G1）。
 *
 * 语义拍板：语音开口 = 打断/纠偏意图，不是排队意图。
 * - 上一轮 run 还在跑 → 走插话（steer），像 OpenAI Realtime / 豆包那样当场纠偏；
 * - 只是本地发送中（上传图片/长文本），没有运行中的 run → 短队列，松手就发；
 * - 其余 → 正常发送。
 */
export type VoiceFinalAction = 'steer' | 'queue' | 'send'

export const VOICE_FINAL_QUEUE_LIMIT = 2

export function decideVoiceFinalAction(params: {
  isSending: boolean
  hasActiveRun: boolean
  queueLen: number
}): VoiceFinalAction {
  if (params.hasActiveRun) return 'steer'
  if (params.isSending) {
    // 队列满了仍然要收下——宁可排队也别丢用户说的话；上限只用于 UI 提示
    return 'queue'
  }
  return 'send'
}
