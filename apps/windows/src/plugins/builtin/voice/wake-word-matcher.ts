/**
 * 唤醒词匹配。
 *
 * 为什么不用 sherpa 的关键词唤醒（KWS）：KWS 要单独的 `keywords.txt` +
 * 一个流式模型（zipformer transducer），本地又得多下一个几百 MB 的模型，
 * 而我们**已经有 VAD + Paraformer 离线 ASR**。句末短句走一遍离线识别，
 * 拿文本匹配，代价是一条几十毫秒的 ASR，零新增模型。
 *
 * ponytail: 靠 ASR 文本匹配，不是声学级 KWS。上限是唤醒词必须"说清楚"
 * （连读/极小声会识别成别的词）。真要常驻低功耗待命，再换 KWS 模型。
 *
 * 匹配规则：
 * - 去空白与标点（"灵栖，灵栖。" → "灵栖灵栖"）
 * - 允许中间夹语气词（"灵栖啊灵栖"）
 * - 容忍常见同音/近音误识（栖/西/息/希/溪…），因为离线 ASR 对生造词不敏感
 */
const WAKE_WORD = '灵栖'

/** 同音/近音字：ASR 把「灵栖」写成这些也算唤醒 */
const HOMOPHONES: Record<string, string> = {
  西: '栖',
  息: '栖',
  希: '栖',
  溪: '栖',
  熙: '栖',
  稀: '栖',
  夕: '栖',
  昔: '栖',
  吸: '栖',
  曦: '栖',
  林: '灵',
  铃: '灵',
  玲: '灵',
  凌: '灵',
  陵: '灵',
  零: '灵',
  领: '灵',
}

/** 只保留中日韩文字与字母数字 */
function normalize(text: string): string {
  return text
    .toLowerCase()
    .split('')
    .map((ch) => HOMOPHONES[ch] ?? ch)
    .join('')
    .replace(/[^\p{Script=Han}a-z0-9]/gu, '')
}

/** 允许出现在两个「灵栖」之间的语气词 */
const FILLERS = new Set(['啊', '呀', '哦', '嗯', '诶', '欸', '那个', '哈', '嘞'])

function stripFillers(text: string): string {
  let out = text
  for (const f of FILLERS) out = out.split(f).join('')
  return out
}

/**
 * 判断一段识别文本是否包含唤醒词。
 *
 * @returns 命中的规范化文本（用于日志），未命中返回 null
 */
export function matchWakeWord(text: string): string | null {
  if (!text) return null
  const normalized = normalize(text)
  if (!normalized) return null

  const target = normalize(WAKE_WORD) // '灵栖'

  // 标准形态：灵栖灵栖（也接受说三遍/带别的话，只要包含连续两次）
  if (normalized.includes(target + target)) return target + target

  // 允许夹语气词：灵栖啊灵栖
  const stripped = stripFillers(normalized)
  if (stripped.includes(target + target)) return target + target

  return null
}

export const WAKE_WORD_DISPLAY = WAKE_WORD + WAKE_WORD
