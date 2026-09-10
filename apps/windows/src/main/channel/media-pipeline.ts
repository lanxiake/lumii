/**
 * 入站媒体归一化共享纯函数（飞书 / 企微 / qbot 共用）。
 *
 * 只收真正重复的三件事：媒体行拼装、落盘、语音文件转文字（opus/音频 → 16k PCM → ASR）。
 * 下载器各渠道不同（飞书 messageResource / 企微 downloadFile），由调用方拿到 Buffer 后调用 saveInboundMedia。
 */

import path from 'node:path'
import { spawn } from 'node:child_process'
import { promises as fs } from 'node:fs'
import { resolveActiveWorkspaceDir } from '../workspace-paths.js'
import { resolvePackagedFfmpegPath } from '../screen-record/ffmpeg-runner.js'

const log = {
  info: (...args: unknown[]) => console.log('[MediaPipeline]', ...args),
  warn: (...args: unknown[]) => console.warn('[MediaPipeline]', ...args),
}

/** 拼 `[media attached: <path> (<filename>)]` 行（path 为相对 workspace 的路径） */
export function mediaAttachedLine(localPath: string, fileName?: string): string {
  return `[media attached: ${localPath}${fileName ? ` (${fileName})` : ''}]`
}

/** 拼 `[语音转录: <text>]` 行 */
export function transcriptLine(text: string): string {
  return `[语音转录: ${text}]`
}

/**
 * 把入站媒体 buffer 落盘到 workspace/uploads/{YYYYMMDD}/，返回相对 workspace 路径。
 * 文件名用时间戳前缀避免同一天重名覆盖。
 */
export async function saveInboundMedia(fileName: string, buffer: Buffer): Promise<string> {
  const workspaceDir = resolveActiveWorkspaceDir()
  const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
  const uploadDir = path.join(workspaceDir, 'uploads', dateStr)
  await fs.mkdir(uploadDir, { recursive: true })
  const safeName = `${Date.now()}_${fileName}`
  await fs.writeFile(path.join(uploadDir, safeName), buffer)
  return `uploads/${dateStr}/${safeName}`
}

/**
 * 语音文件 → ffmpeg 转 16k 单声道 s16le PCM → ASR，返回识别文字。
 * 任一环节失败（ffmpeg 缺失/转码失败/ASR 返回空）都降级为 ''，不抛。
 *
 * @param absPath 音频文件绝对路径（飞书 opus 等）
 * @param asr      16k PCM Float32 转录回调（主进程注入 voiceCallService.transcribePcm）
 */
export async function transcribeVoiceFile(
  absPath: string,
  asr: (samples: Float32Array, sampleRate: number) => Promise<string>,
): Promise<string> {
  try {
    const ffmpeg = resolvePackagedFfmpegPath()
    const samples = await new Promise<Float32Array>((resolve, reject) => {
      const child = spawn(
        ffmpeg,
        ['-y', '-i', absPath, '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1'],
        { windowsHide: true },
      )
      const chunks: Buffer[] = []
      child.stdout.on('data', (c: Buffer) => chunks.push(c))
      child.on('error', reject)
      child.on('close', (code) => {
        if (code !== 0) {
          reject(new Error(`ffmpeg exit ${code}`))
          return
        }
        const buf = Buffer.concat(chunks)
        const int16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2))
        const f32 = new Float32Array(int16.length)
        for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768
        resolve(f32)
      })
    })
    const text = (await asr(samples, 16000)).trim()
    if (text) log.info(`[transcribeVoiceFile] 转录成功: "${text.slice(0, 40)}"`)
    return text
  } catch (e) {
    log.warn(`[transcribeVoiceFile] 转录失败: ${e instanceof Error ? e.message : String(e)}`)
    return ''
  }
}
