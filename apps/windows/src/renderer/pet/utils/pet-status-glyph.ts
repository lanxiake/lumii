/**
 * pet-status-glyph — 宠物头顶那个小符号该显示什么（纯函数，可单测）
 *
 * 由来：用户 2026-09-22 的要求「待机不需要左右和上下移动，待机有自己的动画，需要添加特效」。
 * 位移去掉之后，"它现在在干什么"就少了一个可读信号——**用头顶的符号补回来**，
 * 而不是把宠物整体挪来挪去。
 *
 * ## 为什么是符号而不是第二个气泡
 *
 * 气泡（`PetSpeechBubble`）是**一句话**，有 TTL、会占一行文字、要读；符号是**状态灯**，
 * 一眼扫到就够。两者的生命周期也不同：气泡说完就走，符号要跟着状态一直挂着。
 *
 * ## 优先级：谁的信号更急谁在上面
 *
 * 一个时刻只显示一个符号。排序不是按"重要"，是按**用户此刻该不该被打断**：
 * Agent 在等你确认 > Agent 卡住 > 对话中思考 > 睡着 > 打盹。
 * 睡着排最后：它只在真的没人管的时候才出现，而前三项都说明"有事情正在发生"。
 * （`blocked` 排在 `waiting` 后面，是因为它多半是 waiting 没被理会的后果，
 * 两者同时存在时"在等你"比"卡住了"更可操作。）
 */

/** 符号的语义色调，映射到组件里的颜色 */
export type PetGlyphTone =
  /** 中性进行中（思考） */
  | 'info'
  /** 需要你出手 */
  | 'alert'
  /** 睡着了 */
  | 'sleep'

export interface PetGlyph {
  /** 显示的字符。**单字符**：宽度稳定，不会让定位左右跳 */
  char: string
  tone: PetGlyphTone
  /** 中文说明，供 title / aria-label */
  label: string
}

export interface PetGlyphInput {
  /** `PetAvatarStatus['phase']` */
  phase: string
  /** `PetIdleStage`：awake / drowsy / asleep */
  idleStage?: string
  /** `AgentActivity`：idle / thinking / working / waiting / blocked */
  agentActivity?: string
}

/**
 * 决定此刻该显示哪个符号；没有要显示的返回 `null`（这是常态）。
 *
 * 入参一律用 `string`（不是联合类型）——调用方的状态来自多个模块的运行时值，
 * 这里只做字符串比较，**不 import 那些类型**，免得为了一个只读判断把
 * 渲染层与编排层的类型耦在一起。
 */
export function pickStatusGlyph(input: PetGlyphInput): PetGlyph | null {
  const { phase, idleStage, agentActivity } = input

  if (agentActivity === 'waiting') {
    return { char: '?', tone: 'alert', label: 'Agent 在等你确认' }
  }
  if (agentActivity === 'blocked') {
    return { char: '!', tone: 'alert', label: 'Agent 卡住了' }
  }
  // Agent 侧的思考/干活同样算「正在忙」。**照 voice 的 phase 判是不够的**：
  // 文字对话那一轮根本不走语音状态机（`voiceState` 一直是 idle），
  // 只认 phase 就变成"只有打语音电话时才冒省略号"——实测发了一轮真消息，
  // 头顶什么都没有，正是这个原因。
  if (agentActivity === 'thinking') {
    return { char: '…', tone: 'info', label: '正在思考' }
  }
  if (agentActivity === 'working') {
    return { char: '…', tone: 'info', label: '正在干活' }
  }
  if (phase === 'thinking') {
    return { char: '…', tone: 'info', label: '正在思考' }
  }
  if (idleStage === 'asleep') {
    return { char: 'Z', tone: 'sleep', label: '睡着了' }
  }
  if (idleStage === 'drowsy') {
    return { char: 'z', tone: 'sleep', label: '在打盹' }
  }
  return null
}
