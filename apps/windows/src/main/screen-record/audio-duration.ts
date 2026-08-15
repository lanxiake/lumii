/**
 * 音频时长探测（旁白 cue 缺 endMs 时用）
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import { resolvePackagedFfmpegPath } from './ffmpeg-runner'

/**
 * 从 WAV 头解析时长（ms）；非标准 WAV 返回 null。
 */
export function probeWavDurationMs(filePath: string): number | null {
  try {
    const fd = fs.openSync(filePath, 'r')
    const hdr = Buffer.alloc(44)
    fs.readSync(fd, hdr, 0, 44, 0)
    fs.closeSync(fd)
    if (hdr.toString('ascii', 0, 4) !== 'RIFF' || hdr.toString('ascii', 8, 12) !== 'WAVE') {
      return null
    }
    const byteRate = hdr.readUInt32LE(28)
    if (byteRate <= 0) return null
    const stat = fs.statSync(filePath)
    const dataBytes = Math.max(0, stat.size - 44)
    return Math.round((dataBytes / byteRate) * 1000)
  } catch {
    return null
  }
}

/**
 * 探测媒体时长（优先 WAV 头，否则 ffmpeg -i stderr）。
 */
export async function probeMediaDurationMs(filePath: string): Promise<number | null> {
  if (filePath.toLowerCase().endsWith('.wav')) {
    const wavMs = probeWavDurationMs(filePath)
    if (wavMs != null && wavMs > 0) return wavMs
  }
  let bin: string
  try {
    bin = resolvePackagedFfmpegPath()
  } catch {
    return null
  }
  if (!fs.existsSync(bin) || !fs.existsSync(filePath)) return null

  return new Promise((resolve) => {
    const child = spawn(bin, ['-i', filePath], { windowsHide: true })
    let stderr = ''
    child.stderr?.on('data', (c: Buffer | string) => {
      stderr += typeof c === 'string' ? c : c.toString('utf8')
    })
    child.on('close', () => {
      const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr)
      if (!m) {
        resolve(null)
        return
      }
      const h = Number(m[1])
      const min = Number(m[2])
      const sec = Number(m[3])
      resolve(Math.round((h * 3600 + min * 60 + sec) * 1000))
    })
    child.on('error', () => resolve(null))
  })
}
