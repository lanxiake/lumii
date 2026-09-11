/**
 * 渠道入站语音 ASR 失败时的用户提示。
 *
 * 微信 / 飞书 / QQ 依赖本地 Paraformer；识别失败时向渠道回复友好指引，
 * 避免静默丢弃或把占位符当成指令交给 Agent。
 */

/** 模型未下载：引导到设置页下载 Paraformer */
export const CHANNEL_VOICE_ASR_MODEL_MISSING_HINT =
  '❌ 语音无法识别。请打开桌面客户端，在「设置 → 语音设置」中下载「Paraformer 中文离线 ASR (Small)」后再试。'

/** 模型已就绪但识别为空：请重说或改用文字 */
export const CHANNEL_VOICE_ASR_EMPTY_HINT =
  '❌ 语音未能识别，请再说一次或改用文字发送。'

/** 登录层历史占位符（转录失败时曾写入 text） */
const VOICE_PLACEHOLDER = '[语音消息]'

let asrReadyChecker: (() => boolean) | null = null

/**
 * 由主进程注入：是否已下载可用的 Paraformer ASR 模型。
 * 传 null 清除（测试用）。
 */
export function setChannelAsrReadyChecker(fn: (() => boolean) | null): void {
  asrReadyChecker = fn
}

/** 查询本地 ASR 模型是否就绪；未注入 checker 时视为未就绪。 */
export function isChannelAsrModelReady(): boolean {
  try {
    return asrReadyChecker?.() ?? false
  } catch {
    return false
  }
}

/**
 * 按模型是否就绪选择渠道提示文案。
 */
export function resolveChannelVoiceAsrHint(asrModelReady: boolean): string {
  return asrModelReady ? CHANNEL_VOICE_ASR_EMPTY_HINT : CHANNEL_VOICE_ASR_MODEL_MISSING_HINT
}

/** 读取当前 checker 并返回应对用户展示的提示。 */
export function getChannelVoiceAsrFailedHint(): string {
  return resolveChannelVoiceAsrHint(isChannelAsrModelReady())
}

/**
 * 判断入站消息是否为「语音且本地 ASR 未得到有效转录」。
 * 飞书 type=audio；QQ type=voice；成功转录为原文或 `[语音转录: …]`。
 */
export function isChannelVoiceAsrFailed(
  type: string | undefined,
  text: string | undefined,
): boolean {
  if (type !== 'audio' && type !== 'voice') return false
  const t = (text ?? '').trim()
  if (/\[语音转录:\s*[^\]]+\]/.test(t)) return false
  const withoutPlaceholder = t.replaceAll(VOICE_PLACEHOLDER, '').trim()
  // 无有效转录：空、仅占位符、或仅有旁白文字但没有转录行
  if (!withoutPlaceholder) return true
  // 飞书成功时 text 为纯转录原文（无标记）；有非占位符正文且无转录标记 → 视为成功
  // QQ 成功必带 [语音转录:]；飞书成功为原文。若去掉占位符后仍有正文且不含转录标记：
  // - 飞书：成功
  // - QQ：旁白+失败占位 → 仍算 ASR 失败（语音没听懂）
  if (type === 'audio') return false
  return true
}

/**
 * 微信 SILK 语音：有 .silk 媒体行、无转录、且没有其它用户文字指令。
 */
export function isWeixinSilkAsrFailed(opts: {
  mediaLines: string[]
  transcript: string
  hasUserText: boolean
}): boolean {
  const hadSilk = opts.mediaLines.some((l) => /\.silk/i.test(l))
  if (!hadSilk) return false
  if (opts.transcript.trim()) return false
  return opts.hasUserText !== true
}
