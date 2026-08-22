/**
 * ASR 转录纯函数：PCM 采样转录、WAV base64 转录。
 * 从 VoiceCallService 中提取，仅依赖 AsrProvider（由调用方注入，不持有跨调用状态）。
 */
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { AsrProvider } from './asr-engine.js'

const log = {
  info: (...args: unknown[]) => console.log('[VoiceService]', ...args),
  error: (...args: unknown[]) => console.error('[VoiceService]', ...args),
  warn: (...args: unknown[]) => console.warn('[VoiceService]', ...args),
}

/**
 * 对 PCM 采样做 ASR 转录；非 16kHz 输入先线性插值降/升采样。
 * 调用方需确保 asrProvider 已初始化（VoiceCallService.ensureInitialized）。
 */
export async function transcribePcm(asrProvider: AsrProvider, samples: Float32Array, sampleRate: number): Promise<string> {
  try {
    log.info(`[transcribePcm] 开始转录 PCM, sampleRate=${sampleRate}, samples=${samples.length}`)
    // 如果 sampleRate 不是 16000，做简单降采样（线性插值）
    let pcm = samples
    if (sampleRate !== 16000 && sampleRate > 0) {
      const ratio = sampleRate / 16000
      const outLen = Math.floor(samples.length / ratio)
      pcm = new Float32Array(outLen)
      for (let i = 0; i < outLen; i++) {
        const srcIdx = i * ratio
        const lo = Math.floor(srcIdx)
        const hi = Math.min(lo + 1, samples.length - 1)
        const frac = srcIdx - lo
        pcm[i] = samples[lo] * (1 - frac) + samples[hi] * frac
      }
      log.info(`[transcribePcm] 重采样 ${sampleRate}Hz → 16000Hz, outLen=${outLen}`)
    }
    const stream = asrProvider.createStream()
    stream.feed(pcm)
    const text = stream.resetAndGetResult().trim()
    stream.destroy()
    log.info(`[transcribePcm] 转录结果: "${text}"`)
    return text
  } catch (e) {
    log.error(`[transcribePcm] 转录失败: ${(e as Error).message}`)
    return ''
  }
}

/**
 * 对 base64 编码的 WAV 文件进行 ASR 转录，返回识别文字。
 * 仅支持 WAV（PCM），其他格式返回空字符串。
 * 调用方需确保 asrProvider 已初始化（VoiceCallService.ensureInitialized）。
 * @param asrProvider 已初始化的 ASR provider
 * @param base64Data base64 编码的音频文件内容
 * @param mimeType 文件 MIME 类型
 */
export async function transcribeAudioBuffer(asrProvider: AsrProvider, base64Data: string, mimeType: string): Promise<string> {
  const isWav = mimeType === 'audio/wav' || mimeType === 'audio/x-wav' || mimeType === 'audio/wave'
  if (!isWav) {
    log.warn(`[transcribeAudioBuffer] 当前仅支持 WAV 格式，跳过 mimeType=${mimeType}`)
    return ''
  }

  // 写临时 WAV 文件
  const tmpFile = path.join(os.tmpdir(), `mtbot-asr-${randomUUID()}.wav`)
  try {
    const buf = Buffer.from(base64Data, 'base64')
    fs.writeFileSync(tmpFile, buf)
    log.info(`[transcribeAudioBuffer] 临时文件写入: ${tmpFile} (${buf.length} bytes)`)

    // 使用 sherpa-onnx readWave 解码
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const SherpaOnnx = require('sherpa-onnx-node') as any
    const wave = SherpaOnnx.readWave(tmpFile) as { sampleRate: number; samples: Float32Array }
    log.info(`[transcribeAudioBuffer] WAV 解码完成, sampleRate=${wave.sampleRate}, samples=${wave.samples.length}`)

    // 送入 ASR 流识别
    const stream = asrProvider.createStream()
    stream.feed(wave.samples)
    const text = stream.resetAndGetResult().trim()
    stream.destroy()
    log.info(`[transcribeAudioBuffer] 转录结果: "${text}"`)
    return text
  } catch (e) {
    log.error(`[transcribeAudioBuffer] 转录失败: ${(e as Error).message}`)
    return ''
  } finally {
    try { fs.unlinkSync(tmpFile) } catch { /* ignore */ }
  }
}
