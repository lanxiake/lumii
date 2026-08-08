/**
 * 克隆参考音频临时落盘（设置页麦克风录制）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * 将 base64 音频写入系统临时目录，返回绝对路径
 */
export function saveTempCloneRefAudio(
  audioBase64: string,
  ext: 'wav' | 'webm' = 'wav',
): string {
  if (!audioBase64 || typeof audioBase64 !== 'string') {
    throw new Error('音频数据为空')
  }
  const buf = Buffer.from(audioBase64, 'base64')
  if (buf.byteLength < 44) {
    throw new Error('音频数据过短或无效')
  }
  const safeExt = ext === 'webm' ? 'webm' : 'wav'
  const filePath = path.join(os.tmpdir(), `lumii-voice-clone-${randomUUID()}.${safeExt}`)
  fs.writeFileSync(filePath, buf)
  return filePath
}
