/**
 * TTS 文本清洗与 Qwen3 语言解析（避免 Markdown / Auto 导致中途「换语种」）
 */

/**
 * 去掉 Markdown / 虚拟人标签等不应进合成器的标记
 */
export function sanitizeTtsPlainText(text: string): string {
  const cleaned = String(text ?? '')
    // 虚拟人标签兜底
    .replace(/\[(?:emotion|motion)(?::[^\]]*)?\]/gi, '')
    .replace(/<\/?vh_action\b[^>]*>/gi, '')
    // Markdown
    .replace(/\*{1,3}([^*]*)\*{1,3}/g, '$1')
    .replace(/~~([^~]*)~~/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^[-*+]\s+/gm, '')
    .replace(/^>\s+/gm, '')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\*+/g, '')
    .replace(/_+/g, ' ')
    // 破折号 → 停顿
    .replace(/[—–]/g, '，')
    .replace(/[\u201C\u201D]/g, '')
    .replace(/[\u2018\u2019]/g, '')
    // emoji
    .replace(
      /[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{200D}\u{20E3}\u{E0020}-\u{E007F}]/gu,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim()

  if (/^[\s。！？…，；、：《》【】（）.!?,;:\n\r\t\-「」]*$/u.test(cleaned)) {
    return ''
  }
  return cleaned
}

/**
 * 统计文本中 CJK / Latin 字母占比，用于 Auto 语言消歧
 */
export function analyzeScriptRatio(text: string): { cjk: number; latin: number; total: number } {
  let cjk = 0
  let latin = 0
  for (const ch of text) {
    if (/[\u4e00-\u9fff\u3400-\u4dbf\u3040-\u30ff\uac00-\ud7af]/.test(ch)) cjk += 1
    else if (/[A-Za-z]/.test(ch)) latin += 1
  }
  return { cjk, latin, total: cjk + latin }
}

/**
 * 将配置语言解析为 Qwen3-TTS 实际 language。
 * Auto + 中文为主 → Chinese，避免多语种模型中途漂到英文等音色。
 */
export function resolveQwen3TtsLanguage(configured: string | undefined, text: string): string {
  const conf = (configured || 'Auto').trim() || 'Auto'
  if (conf.toLowerCase() !== 'auto') return conf

  const { cjk, latin, total } = analyzeScriptRatio(text)
  if (total === 0) return 'Chinese'
  // 日文假名较多时留给 Auto/Japanese；纯汉字+少量英文仍按中文
  const kana = (text.match(/[\u3040-\u30ff]/g) || []).length
  const hangul = (text.match(/[\uac00-\ud7af]/g) || []).length
  // 强中文偏置：出现任意汉字即锁 Chinese（han = cjk 去掉假名/谚文），
  // 杜绝中文长文里零星谚文/假名漂成韩/日。
  const han = cjk - kana - hangul
  if (han > 0) return 'Chinese'
  if (hangul >= 2) return 'Korean'
  if (kana >= 2) return 'Japanese'
  if (latin >= 4) return 'English'
  return 'Chinese'
}
