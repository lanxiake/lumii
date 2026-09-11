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

/** 16-bit LE PCM Buffer → Float32Array（[-1,1)） */
function pcmToFloat32(buf: Buffer): Float32Array {
  const int16 = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2))
  const f32 = new Float32Array(int16.length)
  for (let i = 0; i < int16.length; i++) f32[i] = int16[i] / 32768
  return f32
}

/**
 * 判断是否 SILK 音频。
 *
 * ffmpeg 没有 SILK 解码器，这类文件必须交给 silk-wasm，否则 ffmpeg 直接报错。
 * 微信/QQ 的 silk 可能在魔数前多一个 \x02 前缀，所以在头部若干字节里找而不是前缀匹配。
 */
function isSilkAudio(head: Buffer): boolean {
  return head.subarray(0, 16).toString('latin1').includes('#!SILK')
}

/**
 * 按容器魔数判断是否音频，用于入站附件识别。
 *
 * 不看 content_type 和扩展名 —— QQ 这两者都不可靠（content_type 可能是空或
 * 非标准值，filename 可能没扩展名）。buffer 反正已经下载到手，直接看内容最准。
 *
 * 故意不认 ftyp(m4a/mp4)：那会把用户发的视频误判成语音去转录。
 */
export function looksLikeAudio(head: Buffer): boolean {
  const s = head.subarray(0, 16).toString('latin1')
  if (s.includes('#!SILK')) return true // SILK：QQ / 微信语音
  if (s.includes('#!AMR')) return true // AMR / AMR-WB
  if (s.startsWith('OggS')) return true // Ogg 封装的 Opus/Vorbis（飞书）
  if (s.startsWith('RIFF') && s.includes('WAVE')) return true // wav
  if (s.startsWith('ID3')) return true // 带 ID3 tag 的 mp3
  if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) return true // mp3 帧同步
  return false
}

/** 头部字节的可读摘要，用于诊断未识别的附件格式 */
export function describeHead(head: Buffer): string {
  const hex = head.subarray(0, 8).toString('hex')
  const ascii = head.subarray(0, 8).toString('latin1').replace(/[^\x20-\x7e]/g, '.')
  return `hex=${hex} ascii="${ascii}"`
}

/** SILK → 16k 单声道 PCM Float32（走 silk-wasm，纯 WASM 无需原生编译） */
async function decodeSilk(absPath: string): Promise<Float32Array> {
  try {
    // silk-wasm 是纯 WASM 实现，无原生依赖
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { decode } = require('silk-wasm')
    const silkBuf = await fs.readFile(absPath)
    // decode 返回 { data: Int16Array, sampleRate: number }
    const result = await decode(silkBuf, 16000)
    // 转 Float32Array（[-1, 1)）
    const f32 = new Float32Array(result.data.length)
    for (let i = 0; i < result.data.length; i++) {
      f32[i] = result.data[i] / 32768
    }
    return f32
  } catch (e) {
    throw new Error(`silk-wasm 解码失败: ${e instanceof Error ? e.message : String(e)}`)
  }
}

/** 任意 ffmpeg 可解格式（amr / opus / m4a / mp3 …）→ 16k 单声道 PCM Float32 */
async function decodeViaFfmpeg(absPath: string): Promise<Float32Array> {
  const ffmpeg = resolvePackagedFfmpegPath()
  return new Promise<Float32Array>((resolve, reject) => {
    const child = spawn(
      ffmpeg,
      ['-y', '-i', absPath, '-ar', '16000', '-ac', '1', '-f', 's16le', 'pipe:1'],
      { windowsHide: true },
    )
    const chunks: Buffer[] = []
    const errChunks: Buffer[] = []
    child.stdout.on('data', (c: Buffer) => chunks.push(c))
    child.stderr.on('data', (c: Buffer) => errChunks.push(c))
    child.on('error', reject)
    child.on('close', (code) => {
      if (code !== 0) {
        const tail = Buffer.concat(errChunks).toString('utf8').trim().split('\n').slice(-2).join(' ')
        reject(new Error(`ffmpeg exit ${code}${tail ? `: ${tail}` : ''}`))
        return
      }
      resolve(pcmToFloat32(Buffer.concat(chunks)))
    })
  })
}

/**
 * 语音文件 → 16k 单声道 PCM → ASR，返回识别文字。
 * 任一环节失败（解码失败/ffmpeg 缺失/ASR 返回空）都降级为 ''，不抛。
 *
 * 按内容嗅探格式：QQ 语音是 SILK（ffmpeg 解不了）走 silk-wasm，
 * 其余（飞书 opus、企微 amr 等）交给 ffmpeg。不依赖扩展名，因为
 * 各渠道给的 filename 未必准。
 *
 * @param absPath 音频文件绝对路径
 * @param asr     16k PCM Float32 转录回调（主进程注入 voiceCallService.transcribePcm）
 */
export async function transcribeVoiceFile(
  absPath: string,
  asr: (samples: Float32Array, sampleRate: number) => Promise<string>,
): Promise<string> {
  try {
    const fh = await fs.open(absPath, 'r')
    let head: Buffer
    try {
      const buf = Buffer.alloc(16)
      const { bytesRead } = await fh.read(buf, 0, 16, 0)
      head = buf.subarray(0, bytesRead)
    } finally {
      await fh.close()
    }

    const silk = isSilkAudio(head)
    log.info(`[transcribeVoiceFile] 解码方式=${silk ? 'silk-wasm' : 'ffmpeg'} file=${path.basename(absPath)}`)
    const samples = silk ? await decodeSilk(absPath) : await decodeViaFfmpeg(absPath)

    const text = (await asr(samples, 16000)).trim()
    if (text) log.info(`[transcribeVoiceFile] 转录成功: "${text.slice(0, 40)}"`)
    else log.warn('[transcribeVoiceFile] ASR 返回空文本')
    return text
  } catch (e) {
    log.warn(`[transcribeVoiceFile] 转录失败: ${e instanceof Error ? e.message : String(e)}`)
    return ''
  }
}
