/**
 * 中文句子分割器
 * 从 Agent 流式 delta 中提取完整句子用于 TTS 合成
 */

const log = {
  warn: (...args: unknown[]) => console.warn('[SentenceSplitter]', ...args),
}

export class SentenceSplitter {
  private buffer = ''
  private readonly HARD_PUNCT = /[。！？…\n]|[.!?](?=\s)/
  private readonly SOFT_PUNCT = /[，；]/
  private readonly MIN_SOFT_LEN = 8
  private readonly MAX_LEN = 50
  private readonly MIN_SENTENCE_LEN = 3
  private readonly MAX_ITERATIONS = 100

  /**
   * 接收新的文本 delta，返回可以立即 TTS 的完整句子列表
   */
  feed(delta: string): string[] {
    this.buffer += delta
    const sentences: string[] = []

    let iterations = 0
    while (true) {
      if (++iterations > this.MAX_ITERATIONS) {
        log.warn(`[feed] 循环超过 ${this.MAX_ITERATIONS} 次，强制退出。残留 buffer: "${this.buffer.slice(0, 30)}"`)
        this.buffer = ''
        break
      }

      // 强制切割点（句末标点）
      const hardIdx = this._findHardPunct()
      if (hardIdx !== -1) {
        const sentence = this.buffer.slice(0, hardIdx + 1).trim()
        this.buffer = this.buffer.slice(hardIdx + 1)
        if (sentence.length >= this.MIN_SENTENCE_LEN) {
          sentences.push(sentence)
        } else if (sentence.length > 0) {
          if (this._isPunctOnly(sentence)) {
            // 纯标点直接丢弃
          } else if (this.buffer.length === 0) {
            // buffer 已空，无后续内容可合并，直接作为短句输出
            sentences.push(sentence)
          } else {
            this.buffer = sentence + this.buffer
          }
        }
        continue
      }

      // 软切割点（积累足够长度后才切）
      const softIdx = this.buffer.search(this.SOFT_PUNCT)
      if (softIdx !== -1 && softIdx >= this.MIN_SOFT_LEN) {
        const sentence = this.buffer.slice(0, softIdx + 1).trim()
        this.buffer = this.buffer.slice(softIdx + 1)
        if (sentence.length >= this.MIN_SENTENCE_LEN) {
          sentences.push(sentence)
        } else if (sentence.length > 0) {
          if (this._isPunctOnly(sentence)) {
            // 纯标点直接丢弃
          } else if (this.buffer.length === 0) {
            sentences.push(sentence)
          } else {
            this.buffer = sentence + this.buffer
          }
        }
        continue
      }

      // 超长强制切割（在空格或标点处切，避免切断数字/单词）
      if (this.buffer.length >= this.MAX_LEN) {
        const cutPoint = this._findSafeCutPoint(this.MAX_LEN)
        const sentence = this.buffer.slice(0, cutPoint).trim()
        this.buffer = this.buffer.slice(cutPoint)
        if (sentence.length > 0) sentences.push(sentence)
        continue
      }

      break
    }

    return sentences.filter((s) => s.length > 0)
  }

  /**
   * 查找硬切割点（英文句号后跟空格时不切割数字如 3.14）
   */
  private _findHardPunct(): number {
    const buf = this.buffer
    for (let i = 0; i < buf.length; i++) {
      const ch = buf[i]
      if (/[。！？…\n]/.test(ch)) return i
      // 英文 .!? 后跟空格才视为句末（避免 3.14 被切割）
      if (/[.!?]/.test(ch)) {
        if (i + 1 < buf.length && /\s/.test(buf[i + 1])) {
          // 确认不是数字序列中的小数点
          const prev = buf[i - 1] ?? ''
          const next = buf[i + 1] ?? ''
          if (ch === '.' && /\d/.test(prev) && /\d/.test(next)) continue
          return i
        }
      }
    }
    return -1
  }

  /**
   * 超长时在空格或标点处寻找安全切割点
   */
  private _findSafeCutPoint(maxLen: number): number {
    const buf = this.buffer.slice(0, maxLen)
    // 从末尾向前找空格或标点
    for (let i = buf.length - 1; i >= Math.floor(maxLen * 0.6); i--) {
      if (/[\s，；。！？]/.test(buf[i])) return i + 1
    }
    return maxLen
  }

  /**
   * 通话结束时刷出缓冲区剩余内容
   */
  flush(): string {
    const remaining = this.buffer.trim()
    this.buffer = ''
    return remaining
  }

  reset(): void {
    this.buffer = ''
  }

  /** 检测文本是否仅由标点符号和空白组成 */
  private _isPunctOnly(text: string): boolean {
    // 字符类中 - 放末尾避免被解释为范围
    return /^[\s。！？…，；、：\u201C\u201D\u2018\u2019《》【】（）.!?,;:\n\r\t-]+$/u.test(text)
  }
}
