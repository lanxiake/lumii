/**
 * PetEmotionMapper - Agent 流式文本表情解析（渲染层）
 *
 * 设计依据：03 号 §4.3、06 号 §6.2、07 号计划 §4.1 (6.2)
 *
 * 消费 agent:text delta，增量解析 [emotion] 标签，映射到当前模型 emotionMap 索引，
 * 回调 setExpression。复用 shared/virtual-human 的纯函数（extractEmotionTags /
 * mapEmotionsToIndices），自身只持有跨 delta 的累积缓冲与去重状态。
 *
 * 流式策略：标签可能被 delta 切断（如 "[jo" + "y]"），故缓冲未闭合的 '[' 残段，
 * 待后续 delta 补全再解析；已闭合标签即时触发表情。
 */

import {
  extractEmotionTags,
} from '../../../shared/virtual-human'

const log = {
  info: (...args: unknown[]) => console.log('[PetEmotionMapper]', ...args),
  warn: (...args: unknown[]) => console.warn('[PetEmotionMapper]', ...args),
}

/** 模型/LLM 常见别名 → registry emotionMap key（对齐 OLV 常用标签） */
const EMOTION_ALIASES: Record<string, string> = {
  happy: 'joy',
  happiness: 'joy',
  glad: 'joy',
  sad: 'sadness',
  angry: 'anger',
  mad: 'anger',
  scared: 'fear',
  afraid: 'fear',
  surprised: 'surprise',
  shock: 'surprise',
  calm: 'neutral',
  default: 'neutral',
}

export class PetEmotionMapper {
  /** 跨 delta 残留缓冲（可能含未闭合的 '[' 开头） */
  private buffer = ''
  /** 本轮已输出的清洁字符累计数（用于给表情/动作标签标注"读到第几个字"位置） */
  private cleanCharsEmitted = 0
  /** 最近一次已发出的表情索引（去重，避免相邻重复标签抖动） */
  private lastIndex: number | null = null
  /** 本轮流式已发出的表情计数（>0 时 message:end 的 applyFromFullText 兜底跳过，避免重复） */
  private emittedThisTurn = 0

  constructor(
    private emotionMap: Record<string, number>,
    /** 表情命中回调。atChar = 该标签在清洁文本流中的字符偏移，
     *  由编排器按朗读进度对齐触发（karaoke 式），与动作标签同坐标系、同节奏。 */
    private onExpression: (index: number, emotionName: string, atChar: number) => void,
    /** 动作标签 [motion:tag] 命中回调（可选，未注入动作时不传）。
     *  atChar = 该标签在清洁文本流中的字符偏移，供编排器按朗读进度对齐触发（karaoke 式）。 */
    private onMotion?: (tag: string, atChar: number) => void,
  ) {}

  /** 更新表情回调（模型热切换时确保指向当前编排器） */
  setOnExpression(handler: (index: number, emotionName: string, atChar: number) => void): void {
    this.onExpression = handler
  }

  /** 更新动作回调（模型热切换时确保指向当前编排器） */
  setOnMotion(handler: ((tag: string, atChar: number) => void) | undefined): void {
    this.onMotion = handler
  }

  /** 更新模型 emotionMap（热切换模型时调用） */
  setEmotionMap(emotionMap: Record<string, number>): void {
    this.emotionMap = emotionMap
    this.lastIndex = null
  }

  /**
   * 喂入流式 delta，解析其中的表情标签并触发 setExpression。
   * 采用增量解析：一旦缓冲头部形成完整 [tag] 立即入队，不等到整段结束。
   * @returns 本 delta 去除表情标签后的清洁文本（供字幕消费）
   */
  feed(delta: string): string {
    this.buffer += delta
    let cleanOut = ''

    while (this.buffer.length > 0) {
      // 动作标签 [motion:tag]（含冒号，须先于表情匹配）
      const motionTag = this.buffer.match(/^\[motion:([a-zA-Z0-9_一-龥]+)\]/)
      if (motionTag) {
        // 标注该动作在清洁文本流中的字符偏移，由编排器按朗读进度对齐触发（不在此立即播放）
        const atChar = this.cleanCharsEmitted + cleanOut.length
        log.info(`[feed] 命中动作标签 [motion:${motionTag[1]}] atChar=${atChar}`)
        this.onMotion?.(motionTag[1]!, atChar)
        this.buffer = this.buffer.slice(motionTag[0].length)
        continue
      }

      // 未闭合的 [motion: 开头：等待后续 delta，避免漏触发或泄漏进字幕
      if (/^\[motion:?[a-zA-Z0-9_一-龥]*$/.test(this.buffer)) {
        break
      }

      const completeTag = this.buffer.match(/^\[([a-zA-Z0-9_一-龥]+)\]/)
      if (completeTag) {
        // 标注该表情在清洁文本流中的字符偏移，与动作标签同坐标系，
        // 由编排器按朗读进度对齐触发（读到此处才切表情），不在此立即应用。
        const atChar = this.cleanCharsEmitted + cleanOut.length
        this.emitEmotion(completeTag[1]!, atChar)
        this.buffer = this.buffer.slice(completeTag[0].length)
        continue
      }

      // 未闭合标签：等待后续 delta
      if (this.buffer.startsWith('[') && !this.buffer.includes(']')) {
        break
      }

      const nextOpen = this.buffer.indexOf('[')
      if (nextOpen === -1) {
        cleanOut += this.buffer
        this.buffer = ''
        break
      }
      if (nextOpen > 0) {
        cleanOut += this.buffer.slice(0, nextOpen)
        this.buffer = this.buffer.slice(nextOpen)
        continue
      }

      // 以 '[' 开头但非合法标签，丢弃一个字符避免死循环
      cleanOut += this.buffer[0]
      this.buffer = this.buffer.slice(1)
    }

    this.cleanCharsEmitted += cleanOut.length
    return cleanOut
  }

  /**
   * 从完整回复文本提取并应用全部表情（message:end 兜底，防止 delta 丢失时无表情）。
   *
   * 流式 feed 已按位置发出过表情时（emittedThisTurn>0），跳过兜底避免重复入队——
   * 此前的实现正是在此重复入队后又被 reset() 清空，导致除首个外全部表情丢失。
   * 仅当流式完全没解析到表情（delta 丢失/乱序）时，才用完整文本兜底：
   * 无位置信息，退化为按均匀间隔在文本长度上铺开。
   */
  applyFromFullText(text: string): void {
    if (this.emittedThisTurn > 0) {
      log.info(`[applyFromFullText] 流式已发出 ${this.emittedThisTurn} 个表情，跳过兜底`)
      return
    }
    const { cleanText, emotions } = extractEmotionTags(text)
    if (emotions.length === 0) {
      log.info('[applyFromFullText] 无表情标签')
      return
    }
    log.info(`[applyFromFullText] 兜底解析到表情: ${emotions.join(' → ')}`)
    // 无逐标签位置：把表情均匀铺在清洁文本长度上，仍走朗读进度对齐。
    const span = Math.max(1, cleanText.length)
    emotions.forEach((name, i) => {
      const atChar = Math.floor((span * i) / emotions.length)
      this.emitEmotion(name, atChar)
    })
  }

  /**
   * 发出一个表情（带朗读位置）：解析名称/别名 → 映射索引 → 去重 → 回调编排器。
   * 编排器据 atChar 按朗读进度对齐触发，实现"读到此处才切表情"。
   */
  private emitEmotion(name: string, atChar: number): void {
    const normalized = this.resolveEmotionName(name)
    const idx = this.emotionMap[normalized]
    if (typeof idx !== 'number') {
      log.warn(
        `[emitEmotion] 未知表情 "${name}" (norm=${normalized})，emotionMap keys=${Object.keys(this.emotionMap).join(',')}`,
      )
      return
    }
    // 相邻重复去重（同一表情连续标注不重复排队），但不同位置的同名表情允许（如首尾都 neutral）
    if (idx === this.lastIndex) {
      log.info(`[emitEmotion] 跳过相邻重复表情 ${normalized} → index=${idx}`)
      return
    }
    this.lastIndex = idx
    this.emittedThisTurn++
    log.info(`[emitEmotion] ${normalized} → index=${idx} atChar=${atChar}`)
    this.onExpression(idx, normalized, atChar)
  }

  /** 解析表情名：优先直查 emotionMap，再尝试 OLV 常用别名 */
  private resolveEmotionName(name: string): string {
    if (typeof this.emotionMap[name] === 'number') return name
    const aliased = EMOTION_ALIASES[name.toLowerCase()]
    if (aliased && typeof this.emotionMap[aliased] === 'number') return aliased
    return name
  }

  /** 一轮回复结束：清空缓冲（残留未闭合标签丢弃）与去重/计数状态 */
  reset(): void {
    this.buffer = ''
    this.cleanCharsEmitted = 0
    this.lastIndex = null
    this.emittedThisTurn = 0
  }
}
