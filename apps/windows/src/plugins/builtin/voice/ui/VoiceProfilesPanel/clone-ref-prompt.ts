/**
 * 声音克隆麦克风录制：固定朗读稿与时长约束
 */

/** 用户照着念的固定中文文案（同时作为 ICL refText） */
export const CLONE_REF_PROMPT_ZH =
  '你好，我是灵栖。今天天气不错，我们一起聊聊吧。'

/** 最短录音时长（毫秒），短于此时长不落盘 */
export const MIN_CLONE_RECORD_MS = 3000

/** 最长录音时长（毫秒），到达后自动停止并落盘 */
export const MAX_CLONE_RECORD_MS = 30000

export type CloneSampleSource = 'file' | 'record'

/**
 * 按样本来源解析保存用的转写文本
 */
export function resolveCloneRefText(source: CloneSampleSource, fileRefText: string): string {
  if (source === 'record') return CLONE_REF_PROMPT_ZH
  return fileRefText.trim()
}
