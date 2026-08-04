/**
 * 语音模型管理器
 * 模型存储在客户端本地，与网关完全隔离
 */
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** GitHub 下载镜像（国内网络 GitHub 直连易超时） */
const DOWNLOAD_MIRROR_PREFIXES = [
  'https://gh.ddlc.top/',
  'https://gh-proxy.com/',
  '',
  'https://ghfast.top/',
]

const CONNECT_TIMEOUT_MS = 60_000
const DATA_IDLE_TIMEOUT_MS = 120_000

const log = {
  info: (...args: unknown[]) => console.log('[VoiceModelManager]', ...args),
  warn: (...args: unknown[]) => console.warn('[VoiceModelManager]', ...args),
  error: (...args: unknown[]) => console.error('[VoiceModelManager]', ...args),
}

export interface VoiceModelStatus {
  id: string
  name: string
  sizeBytes: number
  downloaded: boolean
  path?: string
}

export interface VoiceModelPaths {
  vad: string
  asr: string
  tts: string
  ttsVocoder?: string
}

const MODEL_CATALOG = {
  vad: {
    id: 'vad',
    name: 'Silero VAD',
    filename: 'silero_vad.onnx',
    sizeBytes: 1_900_000,
    dir: 'vad',
    downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    type: 'single' as const,
  },
  'asr-paraformer-zh': {
    id: 'asr-paraformer-zh',
    name: 'Paraformer 中文离线 ASR (Small)',
    sizeBytes: 78_000_000,
    dir: 'asr/paraformer-zh-small',
    files: ['model.int8.onnx', 'tokens.txt', 'am.mvn'],
    downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2',
    extractedDir: 'sherpa-onnx-paraformer-zh-small-2024-03-09',
    type: 'tar' as const,
  },
  'tts-vits-zh': {
    id: 'tts-vits-zh',
    name: 'VITS 中文 TTS (Aishell3)',
    sizeBytes: 128_000_000,
    dir: 'tts/vits-zh-aishell3',
    files: ['model.onnx', 'lexicon.txt', 'tokens.txt'],
    downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-zh-aishell3.tar.bz2',
    extractedDir: 'vits-zh-aishell3',
    type: 'tar' as const,
  },
} as const

type ModelId = keyof typeof MODEL_CATALOG

export class VoiceModelManager {
  private get baseDir(): string {
    return path.join(app.getPath('userData'), 'models', 'voice')
  }

  async getModelPaths(): Promise<VoiceModelPaths> {
    const base = this.baseDir
    return {
      vad: path.join(base, 'vad', 'silero_vad.onnx'),
      asr: path.join(base, 'asr', 'paraformer-zh-small'),
      tts: path.join(base, 'tts', 'vits-zh-aishell3'),
    }
  }

  isModelDownloaded(modelId: ModelId): boolean {
    const model = MODEL_CATALOG[modelId]
    if (!model) return false
    const modelDir = path.join(this.baseDir, model.dir)

    if ('files' in model) {
      return model.files.every((f) => fs.existsSync(path.join(modelDir, f)))
    }
    return fs.existsSync(path.join(this.baseDir, model.dir, (model as { filename: string }).filename))
  }

  areRequiredModelsReady(): boolean {
    return (
      this.isModelDownloaded('vad') &&
      this.isModelDownloaded('asr-paraformer-zh') &&
      this.isModelDownloaded('tts-vits-zh')
    )
  }

  /**
   * 判断当前 TTS 引擎是否可用（Edge 无需本地模型，VITS 需已下载）
   */
  isTtsReady(provider: string): boolean {
    if (provider === 'edge') return true
    return this.isModelDownloaded('tts-vits-zh')
  }

  getModelsStatus(): VoiceModelStatus[] {
    return Object.values(MODEL_CATALOG).map((m) => ({
      id: m.id,
      name: m.name,
      sizeBytes: m.sizeBytes,
      downloaded: this.isModelDownloaded(m.id as ModelId),
      path: path.join(this.baseDir, m.dir),
    }))
  }

  getModelBaseDir(): string {
    return this.baseDir
  }

  /**
   * 下载模型（支持断点续传思路：先下载到临时文件，完成后移动）
   */
  startDownload(
    modelId: string,
    onProgress: (p: { progress: number; downloadedBytes: number; totalBytes: number }) => void,
    onError?: (message: string) => void,
  ): AbortController {
    const abort = new AbortController()
    const model = MODEL_CATALOG[modelId as ModelId]
    if (!model) {
      log.error(`[startDownload] 未知模型 ID: ${modelId}`)
      onError?.(`未知模型: ${modelId}`)
      return abort
    }

    log.info(`[startDownload] 开始下载: ${model.name}`)
    this._downloadModel(model, onProgress, abort.signal).catch((e) => {
      if (!abort.signal.aborted) {
        const message = e instanceof Error ? e.message : String(e)
        log.error(`[startDownload] 下载失败 ${modelId}: ${message}`)
        onError?.(message)
      }
    })

    return abort
  }

  private async _downloadModel(
    model: (typeof MODEL_CATALOG)[ModelId],
    onProgress: (p: { progress: number; downloadedBytes: number; totalBytes: number }) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const tempDir = path.join(app.getPath('temp'), 'mtbot-voice-models')
    fs.mkdirSync(tempDir, { recursive: true })

    const targetDir = path.join(this.baseDir, model.dir)
    fs.mkdirSync(targetDir, { recursive: true })

    if (model.type === 'single') {
      // 单文件下载
      const filename = (model as { filename: string }).filename
      const tempFile = path.join(tempDir, filename)
      await this._downloadFile(model.downloadUrl, tempFile, onProgress, signal)
      fs.renameSync(tempFile, path.join(targetDir, filename))
      log.info(`[_downloadModel] ${model.name} 下载完成`)
    } else {
      // tar.bz2 下载后解压
      const tarFile = path.join(tempDir, `${model.id}.tar.bz2`)
      await this._downloadFile(model.downloadUrl, tarFile, onProgress, signal)

      log.info(`[_downloadModel] 解压 ${model.name}...`)
      // 使用 Windows 系统 tar，避免 git bash 拦截
      const tarExe = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
      await execFileAsync(tarExe, ['-xf', tarFile, '-C', tempDir])

      // 复制所需文件
      const extractedDir = path.join(tempDir, (model as { extractedDir: string }).extractedDir)
      for (const file of model.files) {
        const src = path.join(extractedDir, file)
        const dst = path.join(targetDir, file)
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dst)
        } else {
          log.warn(`[_downloadModel] 文件不存在: ${src}`)
        }
      }

      // 复制 FST 规范化文件（可选）
      for (const fst of ['date.fst', 'phone.fst', 'number.fst']) {
        const src = path.join(extractedDir, fst)
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(targetDir, fst))
        }
      }

      // 清理临时文件
      try {
        fs.rmSync(tarFile, { force: true })
        fs.rmSync(extractedDir, { recursive: true, force: true })
      } catch { /* ignore */ }

      log.info(`[_downloadModel] ${model.name} 下载并解压完成`)
    }
  }

  /**
   * 依次尝试镜像与直连下载语音模型文件
   */
  private async _downloadFile(
    url: string,
    destPath: string,
    onProgress: (p: { progress: number; downloadedBytes: number; totalBytes: number }) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const errors: string[] = []

    for (const prefix of DOWNLOAD_MIRROR_PREFIXES) {
      const mirrorUrl = prefix ? `${prefix}${url}` : url
      const label = prefix ? new URL(prefix).hostname : 'github.com'
      try {
        await this._downloadFileOnce(mirrorUrl, destPath, onProgress, signal)
        log.info(`[_downloadFile] 下载成功 (${label}): ${path.basename(destPath)}`)
        return
      } catch (err) {
        if (signal.aborted) throw err
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(`[_downloadFile] ${label} 失败: ${msg}`)
        errors.push(`${label}: ${msg}`)
        try {
          fs.unlinkSync(destPath)
        } catch {
          /* ignore */
        }
      }
    }

    throw new Error(`所有下载源均失败，请检查网络:\n${errors.join('\n')}`)
  }

  /**
   * 从单个 URL 下载文件（支持重定向、连接/数据双超时）
   */
  private _downloadFileOnce(
    url: string,
    destPath: string,
    onProgress: (p: { progress: number; downloadedBytes: number; totalBytes: number }) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error('已取消'))
        return
      }

      let settled = false
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let connectTimer: ReturnType<typeof setTimeout> | undefined
      let currentReq: http.ClientRequest | null = null

      const finish = (err?: Error) => {
        if (settled) return
        settled = true
        if (idleTimer) clearTimeout(idleTimer)
        if (connectTimer) clearTimeout(connectTimer)
        if (err) reject(err)
        else resolve()
      }

      const resetIdleTimer = () => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => {
          currentReq?.destroy()
          finish(new Error('下载超时（长时间无数据）'))
        }, DATA_IDLE_TIMEOUT_MS)
      }

      const doRequest = (reqUrl: string, redirectCount = 0): void => {
        if (redirectCount > 5) {
          finish(new Error('重定向次数过多'))
          return
        }

        const protocol = reqUrl.startsWith('https') ? https : http
        const req = protocol.get(reqUrl, { headers: { 'User-Agent': 'mtbot-client' } }, (res) => {
          currentReq = req
          if (connectTimer) {
            clearTimeout(connectTimer)
            connectTimer = undefined
          }

          if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            const next = new URL(res.headers.location, reqUrl).toString()
            log.info(`[_downloadFile] 重定向: ${next.slice(0, 100)}...`)
            res.resume()
            doRequest(next, redirectCount + 1)
            return
          }

          if (res.statusCode !== 200) {
            res.resume()
            finish(new Error(`HTTP ${res.statusCode}`))
            return
          }

          const totalBytes = parseInt(res.headers['content-length'] ?? '0', 10)
          let downloadedBytes = 0
          const fileStream = fs.createWriteStream(destPath)

          signal.addEventListener('abort', () => {
            req.destroy()
            fileStream.close()
            fs.unlink(destPath, () => {})
            finish(new Error('已取消'))
          }, { once: true })

          resetIdleTimer()

          res.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length
            resetIdleTimer()
            const progress = totalBytes > 0 ? downloadedBytes / totalBytes : 0
            onProgress({ progress, downloadedBytes, totalBytes })
          })

          res.pipe(fileStream)

          fileStream.on('finish', () => {
            fileStream.close(() => finish())
          })

          fileStream.on('error', (e) => {
            fs.unlink(destPath, () => {})
            finish(e)
          })

          res.on('error', (e) => finish(e))
        })

        req.on('error', (e) => finish(e))
        currentReq = req

        connectTimer = setTimeout(() => {
          req.destroy()
          finish(new Error('连接超时，无法访问下载源'))
        }, CONNECT_TIMEOUT_MS)
      }

      doRequest(url)
    })
  }
}
