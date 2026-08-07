/**
 * 语音模型管理器
 * 模型存储在客户端本地；支持分项下载、暂停、取消与 HTTP Range 断点续传
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

import type { VoiceModelDownloadState } from '../../shared/voice-events.js'

/** 单项下载任务状态（与 shared 对齐） */
export type { VoiceModelDownloadState }

export interface VoiceModelStatus {
  id: string
  name: string
  sizeBytes: number
  downloaded: boolean
  path?: string
  /** 下载任务状态 */
  downloadState: VoiceModelDownloadState
  /** 已下载字节（含 partial） */
  downloadedBytes: number
  /** 最近错误信息 */
  errorMessage?: string
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

interface TaskRuntime {
  abort: AbortController | null
  /** pause 时置 true，abort 后不删 partial */
  pausing: boolean
  state: VoiceModelDownloadState
  downloadedBytes: number
  totalBytes: number
  errorMessage?: string
  /** 上次成功使用的镜像前缀，续传优先 */
  lastMirrorPrefix?: string
}

/**
 * 语音模型本地下载与就绪检测
 */
export class VoiceModelManager {
  private tasks = new Map<string, TaskRuntime>()

  private get baseDir(): string {
    return path.join(app.getPath('userData'), 'models', 'voice')
  }

  private get tempDir(): string {
    return path.join(app.getPath('temp'), 'mtbot-voice-models')
  }

  /**
   * 获取或创建任务运行时状态
   */
  private getOrCreateTask(modelId: string): TaskRuntime {
    let t = this.tasks.get(modelId)
    if (!t) {
      t = {
        abort: null,
        pausing: false,
        state: 'idle',
        downloadedBytes: 0,
        totalBytes: 0,
      }
      this.tasks.set(modelId, t)
    }
    return t
  }

  /**
   * partial 临时文件路径
   */
  private partialPath(modelId: string): string {
    const model = MODEL_CATALOG[modelId as ModelId]
    if (!model) return path.join(this.tempDir, `${modelId}.partial`)
    if (model.type === 'single') {
      return path.join(this.tempDir, `${(model as { filename: string }).filename}.partial`)
    }
    return path.join(this.tempDir, `${model.id}.tar.bz2.partial`)
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

  /**
   * 判断通话所需模型是否就绪。
   * Edge TTS 无需本地下载 VITS；其余（含未传 provider）要求 VITS。
   */
  areRequiredModelsReady(ttsProvider?: string): boolean {
    if (!this.isModelDownloaded('vad') || !this.isModelDownloaded('asr-paraformer-zh')) {
      return false
    }
    if (ttsProvider === 'edge') return true
    return this.isModelDownloaded('tts-vits-zh')
  }

  /**
   * 判断当前 TTS 引擎是否可用（Edge 无需本地模型，VITS 需已下载）
   */
  isTtsReady(provider: string): boolean {
    if (provider === 'edge') return true
    return this.isModelDownloaded('tts-vits-zh')
  }

  /**
   * 汇总各模型状态（含下载进度字段）
   */
  getModelsStatus(): VoiceModelStatus[] {
    return Object.values(MODEL_CATALOG).map((m) => {
      const id = m.id as ModelId
      const downloaded = this.isModelDownloaded(id)
      const task = this.tasks.get(id)
      let downloadState: VoiceModelDownloadState = task?.state ?? 'idle'
      if (downloaded && downloadState !== 'downloading' && downloadState !== 'extracting') {
        downloadState = 'ready'
      }
      let downloadedBytes = task?.downloadedBytes ?? 0
      if (!task || task.state === 'idle' || task.state === 'paused') {
        const partial = this.partialPath(id)
        if (fs.existsSync(partial)) {
          try {
            downloadedBytes = fs.statSync(partial).size
            if (!task || task.state === 'idle') {
              downloadState = downloaded ? 'ready' : 'paused'
            }
          } catch {
            // ignore
          }
        }
      }
      return {
        id: m.id,
        name: m.name,
        sizeBytes: m.sizeBytes,
        downloaded,
        path: path.join(this.baseDir, m.dir),
        downloadState,
        downloadedBytes,
        errorMessage: task?.errorMessage,
      }
    })
  }

  getModelBaseDir(): string {
    return this.baseDir
  }

  /**
   * 开始或从暂停处续传下载
   */
  startDownload(
    modelId: string,
    onProgress: (p: {
      progress: number
      downloadedBytes: number
      totalBytes: number
      state: VoiceModelDownloadState
    }) => void,
    onError?: (message: string) => void,
  ): void {
    const model = MODEL_CATALOG[modelId as ModelId]
    if (!model) {
      log.error(`[startDownload] 未知模型 ID: ${modelId}`)
      onError?.(`未知模型: ${modelId}`)
      return
    }

    const task = this.getOrCreateTask(modelId)
    if (task.state === 'downloading' || task.state === 'extracting') {
      log.warn(`[startDownload] ${modelId} 已在下载中，忽略重复请求`)
      return
    }
    if (this.isModelDownloaded(modelId as ModelId)) {
      task.state = 'ready'
      onProgress({ progress: 1, downloadedBytes: model.sizeBytes, totalBytes: model.sizeBytes, state: 'ready' })
      return
    }

    task.pausing = false
    task.errorMessage = undefined
    task.abort = new AbortController()
    task.state = 'downloading'

    log.info(`[startDownload] 开始下载: ${model.name}`)
    this._downloadModel(model, task, onProgress, task.abort.signal)
      .then(() => {
        task.state = 'ready'
        task.downloadedBytes = model.sizeBytes
        task.abort = null
        onProgress({
          progress: 1,
          downloadedBytes: model.sizeBytes,
          totalBytes: model.sizeBytes,
          state: 'ready',
        })
      })
      .catch((e) => {
        if (task.pausing) {
          task.state = 'paused'
          task.abort = null
          const partialSize = fs.existsSync(this.partialPath(modelId))
            ? fs.statSync(this.partialPath(modelId)).size
            : task.downloadedBytes
          task.downloadedBytes = partialSize
          onProgress({
            progress: task.totalBytes > 0 ? partialSize / task.totalBytes : 0,
            downloadedBytes: partialSize,
            totalBytes: task.totalBytes || model.sizeBytes,
            state: 'paused',
          })
          return
        }
        if (task.abort?.signal.aborted) {
          // cancel 路径已在 cancelDownload 清理
          return
        }
        const message = e instanceof Error ? e.message : String(e)
        task.state = 'error'
        task.errorMessage = message
        task.abort = null
        log.error(`[startDownload] 下载失败 ${modelId}: ${message}`)
        onError?.(message)
      })
  }

  /**
   * 暂停下载（保留 partial，支持后续续传）
   */
  pauseDownload(modelId: string): boolean {
    const task = this.tasks.get(modelId)
    if (!task || task.state !== 'downloading' || !task.abort) {
      return false
    }
    task.pausing = true
    task.abort.abort()
    log.info(`[pauseDownload] 已暂停: ${modelId}`)
    return true
  }

  /**
   * 取消下载并删除 partial
   */
  cancelDownload(modelId: string): boolean {
    const task = this.getOrCreateTask(modelId)
    task.pausing = false
    if (task.abort) {
      task.abort.abort()
      task.abort = null
    }
    const partial = this.partialPath(modelId)
    try {
      if (fs.existsSync(partial)) fs.unlinkSync(partial)
    } catch {
      // ignore
    }
    task.state = 'idle'
    task.downloadedBytes = 0
    task.totalBytes = 0
    task.errorMessage = undefined
    log.info(`[cancelDownload] 已取消并清理: ${modelId}`)
    return true
  }

  private async _downloadModel(
    model: (typeof MODEL_CATALOG)[ModelId],
    task: TaskRuntime,
    onProgress: (p: {
      progress: number
      downloadedBytes: number
      totalBytes: number
      state: VoiceModelDownloadState
    }) => void,
    signal: AbortSignal,
  ): Promise<void> {
    fs.mkdirSync(this.tempDir, { recursive: true })
    const targetDir = path.join(this.baseDir, model.dir)
    fs.mkdirSync(targetDir, { recursive: true })

    const report = (downloadedBytes: number, totalBytes: number, state: VoiceModelDownloadState) => {
      task.downloadedBytes = downloadedBytes
      task.totalBytes = totalBytes
      task.state = state
      const progress = totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : 0
      onProgress({ progress, downloadedBytes, totalBytes, state })
    }

    if (model.type === 'single') {
      const filename = (model as { filename: string }).filename
      const partialFile = this.partialPath(model.id)
      await this._downloadFile(model.downloadUrl, partialFile, task, report, signal)
      if (signal.aborted) throw new Error(task.pausing ? '已暂停' : '已取消')
      fs.renameSync(partialFile, path.join(targetDir, filename))
      log.info(`[_downloadModel] ${model.name} 下载完成`)
    } else {
      const tarPartial = this.partialPath(model.id)
      const tarFile = path.join(this.tempDir, `${model.id}.tar.bz2`)
      await this._downloadFile(model.downloadUrl, tarPartial, task, report, signal)
      if (signal.aborted) throw new Error(task.pausing ? '已暂停' : '已取消')

      // 下载完成：partial → 正式 tar 名再解压
      if (fs.existsSync(tarFile)) {
        try {
          fs.unlinkSync(tarFile)
        } catch {
          /* ignore */
        }
      }
      fs.renameSync(tarPartial, tarFile)

      task.state = 'extracting'
      report(task.totalBytes || model.sizeBytes, task.totalBytes || model.sizeBytes, 'extracting')
      log.info(`[_downloadModel] 解压 ${model.name}...`)
      const tarExe = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
      await execFileAsync(tarExe, ['-xf', tarFile, '-C', this.tempDir])

      const extractedDir = path.join(this.tempDir, (model as { extractedDir: string }).extractedDir)
      for (const file of model.files) {
        const src = path.join(extractedDir, file)
        const dst = path.join(targetDir, file)
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, dst)
        } else {
          log.warn(`[_downloadModel] 文件不存在: ${src}`)
        }
      }

      for (const fst of ['date.fst', 'phone.fst', 'number.fst']) {
        const src = path.join(extractedDir, fst)
        if (fs.existsSync(src)) {
          fs.copyFileSync(src, path.join(targetDir, fst))
        }
      }

      try {
        fs.rmSync(tarFile, { force: true })
        fs.rmSync(extractedDir, { recursive: true, force: true })
      } catch {
        /* ignore */
      }

      log.info(`[_downloadModel] ${model.name} 下载并解压完成`)
    }
  }

  /**
   * 依次尝试镜像与直连；支持 Range 续传
   */
  private async _downloadFile(
    url: string,
    destPartialPath: string,
    task: TaskRuntime,
    onProgress: (downloadedBytes: number, totalBytes: number, state: VoiceModelDownloadState) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const errors: string[] = []
    const prefixes = [...DOWNLOAD_MIRROR_PREFIXES]
    if (task.lastMirrorPrefix !== undefined) {
      const idx = prefixes.indexOf(task.lastMirrorPrefix)
      if (idx > 0) {
        prefixes.splice(idx, 1)
        prefixes.unshift(task.lastMirrorPrefix)
      }
    }

    for (const prefix of prefixes) {
      if (signal.aborted) throw new Error(task.pausing ? '已暂停' : '已取消')
      const mirrorUrl = prefix ? `${prefix}${url}` : url
      const label = prefix ? new URL(prefix).hostname : 'github.com'
      try {
        await this._downloadFileOnce(mirrorUrl, destPartialPath, task, onProgress, signal)
        task.lastMirrorPrefix = prefix
        log.info(`[_downloadFile] 下载成功 (${label}): ${path.basename(destPartialPath)}`)
        return
      } catch (err) {
        if (signal.aborted) throw err
        const msg = err instanceof Error ? err.message : String(err)
        log.warn(`[_downloadFile] ${label} 失败: ${msg}`)
        errors.push(`${label}: ${msg}`)
        // 不支持 Range 或损坏时删掉 partial 整文件重试下一镜像
        if (msg.includes('不支持断点续传') || msg.includes('HTTP 416') || msg.includes('范围无效')) {
          try {
            fs.unlinkSync(destPartialPath)
          } catch {
            /* ignore */
          }
        }
      }
    }

    throw new Error(`所有下载源均失败，请检查网络:\n${errors.join('\n')}`)
  }

  /**
   * 单 URL 下载（支持重定向、Range 续传、连接/数据双超时）
   */
  private _downloadFileOnce(
    url: string,
    destPartialPath: string,
    task: TaskRuntime,
    onProgress: (downloadedBytes: number, totalBytes: number, state: VoiceModelDownloadState) => void,
    signal: AbortSignal,
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error(task.pausing ? '已暂停' : '已取消'))
        return
      }

      let settled = false
      let idleTimer: ReturnType<typeof setTimeout> | undefined
      let connectTimer: ReturnType<typeof setTimeout> | undefined
      let currentReq: http.ClientRequest | null = null
      let fileStream: fs.WriteStream | null = null

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

      const existingBytes =
        fs.existsSync(destPartialPath) ? fs.statSync(destPartialPath).size : 0

      const doRequest = (reqUrl: string, redirectCount = 0): void => {
        if (redirectCount > 5) {
          finish(new Error('重定向次数过多'))
          return
        }

        const headers: Record<string, string> = { 'User-Agent': 'lumii-client' }
        if (existingBytes > 0) {
          headers.Range = `bytes=${existingBytes}-`
        }

        const protocol = reqUrl.startsWith('https') ? https : http
        const req = protocol.get(reqUrl, { headers }, (res) => {
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

          // 续传但服务端不支持 Range：回落整文件重下
          if (existingBytes > 0 && res.statusCode === 200) {
            res.resume()
            try {
              fs.unlinkSync(destPartialPath)
            } catch {
              /* ignore */
            }
            finish(new Error('不支持断点续传'))
            return
          }

          if (existingBytes > 0 && res.statusCode === 416) {
            res.resume()
            finish(new Error('HTTP 416'))
            return
          }

          const ok =
            res.statusCode === 200 || (existingBytes > 0 && res.statusCode === 206)
          if (!ok) {
            res.resume()
            finish(new Error(`HTTP ${res.statusCode}`))
            return
          }

          let totalBytes = 0
          if (res.statusCode === 206 && res.headers['content-range']) {
            const m = /\/(\d+)\s*$/.exec(res.headers['content-range'])
            totalBytes = m ? parseInt(m[1], 10) : existingBytes + parseInt(res.headers['content-length'] ?? '0', 10)
          } else {
            totalBytes = parseInt(res.headers['content-length'] ?? '0', 10)
          }

          let downloadedBytes = existingBytes
          const append = existingBytes > 0 && res.statusCode === 206
          fileStream = fs.createWriteStream(destPartialPath, { flags: append ? 'a' : 'w' })

          const onAbort = () => {
            req.destroy()
            fileStream?.close()
            finish(new Error(task.pausing ? '已暂停' : '已取消'))
          }
          signal.addEventListener('abort', onAbort, { once: true })

          resetIdleTimer()
          onProgress(downloadedBytes, totalBytes || task.totalBytes, 'downloading')

          res.on('data', (chunk: Buffer) => {
            downloadedBytes += chunk.length
            resetIdleTimer()
            onProgress(downloadedBytes, totalBytes || downloadedBytes, 'downloading')
          })

          res.pipe(fileStream)

          fileStream.on('finish', () => {
            fileStream?.close(() => {
              signal.removeEventListener('abort', onAbort)
              finish()
            })
          })

          fileStream.on('error', (e) => {
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
