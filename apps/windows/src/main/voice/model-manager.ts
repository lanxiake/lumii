/**
 * 语音模型管理器
 * VAD 优先 ModelScope SDK；ASR/TTS 优先 hf-mirror 上的 sherpa 兼容包；
 * 失败再回退 GitHub Releases + 镜像。支持分项下载、暂停、取消与 HTTP Range 断点续传。
 */
import { app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { resolveWindowsClientDataRoot } from '../client-data-root.js'
import {
  downloadViaModelScopeSdk,
  type ModelScopeDownloadSpec,
} from './modelscope-downloader.js'
import {
  installPytorchCudaFromWheelDir,
  uninstallPytorchFromBundledPython,
} from './qwen3-tts-client.js'

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

/** snapshot/dir 模型下载成功后写入，避免仅有 config.json 就误判就绪 */
const DOWNLOAD_COMPLETE_MARKER = '.lumii-complete'

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
  /** Qwen3 Tokenizer-12Hz 目录 */
  qwen3Tokenizer?: string
  /** Qwen3 CustomVoice 0.6B */
  qwen3Custom06?: string
  /** Qwen3 CustomVoice 1.7B */
  qwen3Custom17?: string
  /** Qwen3 Base 0.6B（克隆） */
  qwen3Base06?: string
  /** Qwen3 Base 1.7B（克隆） */
  qwen3Base17?: string
}

/** 模型在设置页中的分组（下载区分区展示） */
export type VoiceModelUiGroup = 'asr-core' | 'tts-synth' | 'tts-clone'

/** 国内 HTTP 直链文件映射（不经 GitHub）；可多源回退 + 按字节估进度 */
interface HttpFileMapping {
  /** 主下载 URL */
  url: string
  /** 备用 URL（主源失败时依次尝试） */
  urls?: readonly string[]
  local: string
  /** 已知文件大小（用于多文件加权进度；缺省则按文件个数均分） */
  sizeBytes?: number
}

/** PyTorch CUDA 运行时（与语音模型同 UI：进度 / 暂停 / 续传 / 取消） */
export const PYTORCH_CUDA_RUNTIME_ID = 'runtime-pytorch-cu121' as const

const TORCH_CU121_WHL = 'torch-2.5.1+cu121-cp311-cp311-win_amd64.whl'
const TORCHAUDIO_CU121_WHL = 'torchaudio-2.5.1+cu121-cp311-cp311-win_amd64.whl'
const TORCH_CU121_SIZE = 2_449_385_544
const TORCHAUDIO_CU121_SIZE = 4_136_125
const PYTORCH_CUDA_RUNTIME_SIZE = TORCH_CU121_SIZE + TORCHAUDIO_CU121_SIZE

/**
 * 解析 HTTP 条目的全部候选 URL（主源 + 备用）
 */
function httpFileCandidateUrls(item: HttpFileMapping): string[] {
  const list = [item.url, ...(item.urls ?? [])]
  return [...new Set(list.filter(Boolean))]
}

/**
 * sherpa Offline Paraformer 的 ONNX 必须带 vocab_size 等元数据。
 * 魔搭 FunASR 原版没有，OfflineRecognizer 构造会原生 abort 拖垮进程。
 */
function hasSherpaParaformerMetadata(modelPath: string): boolean {
  try {
    const size = fs.statSync(modelPath).size
    if (size < 1_000_000) return false
    const readLen = Math.min(131_072, size)
    const buf = Buffer.alloc(readLen)
    const fd = fs.openSync(modelPath, 'r')
    try {
      fs.readSync(fd, buf, 0, readLen, Math.max(0, size - readLen))
    } finally {
      fs.closeSync(fd)
    }
    return buf.includes(Buffer.from('vocab_size')) && buf.includes(Buffer.from('paraformer'))
  } catch {
    return false
  }
}

/**
 * 目录内是否存在模型权重（避免 snapshot 中途仅有 config.json 误判完成）
 */
function hasModelWeightFiles(modelDir: string): boolean {
  if (!fs.existsSync(modelDir)) return false
  try {
    const entries = fs.readdirSync(modelDir)
    return entries.some((name) => {
      const lower = name.toLowerCase()
      return (
        lower.endsWith('.safetensors') ||
        lower.endsWith('.bin') ||
        lower.endsWith('.onnx') ||
        lower.endsWith('.pt') ||
        lower.endsWith('.ckpt') ||
        lower === 'model.safetensors.index.json' ||
        lower.includes('pytorch_model')
      )
    })
  } catch {
    return false
  }
}

/**
 * 递归统计目录占用字节（用于 snapshot 暂停时估算进度）
 */
function dirSizeBytes(dir: string): number {
  if (!fs.existsSync(dir)) return 0
  let total = 0
  const walk = (d: string) => {
    let entries: fs.Dirent[]
    try {
      entries = fs.readdirSync(d, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      if (ent.name === DOWNLOAD_COMPLETE_MARKER) continue
      const p = path.join(d, ent.name)
      try {
        if (ent.isDirectory()) walk(p)
        else if (ent.isFile()) total += fs.statSync(p).size
      } catch {
        /* ignore */
      }
    }
  }
  walk(dir)
  return total
}

const MODEL_CATALOG = {
  vad: {
    id: 'vad',
    name: 'Silero VAD',
    description: '语音活动检测：区分说话与静音（通话必下）',
    group: 'asr-core' as const,
    filename: 'silero_vad.onnx',
    sizeBytes: 1_900_000,
    dir: 'vad',
    downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/silero_vad.onnx',
    type: 'single' as const,
    modelscope: {
      modelId: 'pengzhendong/silero-vad',
      files: [{ remote: 'v4/silero_vad.onnx', local: 'silero_vad.onnx' }],
    } satisfies Omit<ModelScopeDownloadSpec, 'outDir'>,
  },
  'asr-paraformer-zh': {
    id: 'asr-paraformer-zh',
    name: 'Paraformer 中文离线 ASR (Small)',
    description: '语音转文字：听懂你说的话（通话必下）',
    group: 'asr-core' as const,
    sizeBytes: 78_000_000,
    dir: 'asr/paraformer-zh-small',
    files: ['model.int8.onnx', 'tokens.txt', 'am.mvn'],
    downloadUrl: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-paraformer-zh-small-2024-03-09.tar.bz2',
    extractedDir: 'sherpa-onnx-paraformer-zh-small-2024-03-09',
    type: 'tar' as const,
    /**
     * 必须用 sherpa 注入过 metadata（vocab_size）的版本。
     * 魔搭 crazyant FunASR 原版缺元数据，加载会原生 abort。
     */
    httpFiles: [
      {
        url: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/model.int8.onnx',
        local: 'model.int8.onnx',
      },
      {
        url: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/tokens.txt',
        local: 'tokens.txt',
      },
      {
        url: 'https://hf-mirror.com/csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09/resolve/main/am.mvn',
        local: 'am.mvn',
      },
    ] as HttpFileMapping[],
  },
  'tts-melo-zh-en': {
    id: 'tts-melo-zh-en',
    name: 'MeloTTS 中英双语（离线）',
    description: '本地离线合成，中英混读自然、发音清晰（单音色）',
    group: 'tts-synth' as const,
    sizeBytes: 180_000_000,
    dir: 'tts/melo-zh-en',
    files: ['model.onnx', 'lexicon.txt', 'tokens.txt'],
    /** MeloTTS 需 jieba 分词目录 dict/（解压时整目录拷贝） */
    dirs: ['dict'],
    downloadUrl:
      'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-melo-tts-zh_en.tar.bz2',
    extractedDir: 'vits-melo-tts-zh_en',
    type: 'tar' as const,
  },
  'tts-qwen3-tokenizer-12hz': {
    id: 'tts-qwen3-tokenizer-12hz',
    name: 'Qwen3-TTS Tokenizer 12Hz',
    description: 'Qwen3 共用编解码器（用 Qwen3 合成/克隆前必下）',
    group: 'tts-synth' as const,
    sizeBytes: 500_000_000,
    dir: 'tts/qwen3/tokenizer-12hz',
    files: ['config.json'],
    downloadUrl: '',
    type: 'dir' as const,
    modelscope: {
      modelId: 'Qwen/Qwen3-TTS-Tokenizer-12Hz',
      files: [] as { remote: string; local: string }[],
      mode: 'snapshot' as const,
    } satisfies Omit<ModelScopeDownloadSpec, 'outDir'>,
  },
  'tts-qwen3-0.6b-custom': {
    id: 'tts-qwen3-0.6b-custom',
    name: 'Qwen3-TTS 0.6B CustomVoice（推荐）',
    description: '内置 9 种高级音色，含北京话/四川话等，无需克隆即可用',
    group: 'tts-synth' as const,
    sizeBytes: 2_500_000_000,
    dir: 'tts/qwen3/0.6b-custom',
    files: ['config.json'],
    downloadUrl: '',
    type: 'dir' as const,
    modelscope: {
      modelId: 'Qwen/Qwen3-TTS-12Hz-0.6B-CustomVoice',
      files: [] as { remote: string; local: string }[],
      mode: 'snapshot' as const,
    } satisfies Omit<ModelScopeDownloadSpec, 'outDir'>,
  },
  'tts-qwen3-1.7b-custom': {
    id: 'tts-qwen3-1.7b-custom',
    name: 'Qwen3-TTS 1.7B CustomVoice（高质）',
    description: '更高音质内置音色 + 自然语言风格指令（可选）',
    group: 'tts-synth' as const,
    sizeBytes: 4_500_000_000,
    dir: 'tts/qwen3/1.7b-custom',
    files: ['config.json'],
    downloadUrl: '',
    type: 'dir' as const,
    modelscope: {
      modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice',
      files: [] as { remote: string; local: string }[],
      mode: 'snapshot' as const,
    } satisfies Omit<ModelScopeDownloadSpec, 'outDir'>,
  },
  'tts-qwen3-0.6b-base': {
    id: 'tts-qwen3-0.6b-base',
    name: 'Qwen3-TTS 0.6B Base（声音克隆）',
    description: '可选：3 秒参考音克隆自定义音色（非必须）',
    group: 'tts-clone' as const,
    sizeBytes: 2_500_000_000,
    dir: 'tts/qwen3/0.6b-base',
    files: ['config.json'],
    downloadUrl: '',
    type: 'dir' as const,
    modelscope: {
      modelId: 'Qwen/Qwen3-TTS-12Hz-0.6B-Base',
      files: [] as { remote: string; local: string }[],
      mode: 'snapshot' as const,
    } satisfies Omit<ModelScopeDownloadSpec, 'outDir'>,
  },
  'tts-qwen3-1.7b-base': {
    id: 'tts-qwen3-1.7b-base',
    name: 'Qwen3-TTS 1.7B Base（高质克隆）',
    description: '可选：更高音质声音克隆',
    group: 'tts-clone' as const,
    sizeBytes: 4_500_000_000,
    dir: 'tts/qwen3/1.7b-base',
    files: ['config.json'],
    downloadUrl: '',
    type: 'dir' as const,
    modelscope: {
      modelId: 'Qwen/Qwen3-TTS-12Hz-1.7B-Base',
      files: [] as { remote: string; local: string }[],
      mode: 'snapshot' as const,
    } satisfies Omit<ModelScopeDownloadSpec, 'outDir'>,
  },
  [PYTORCH_CUDA_RUNTIME_ID]: {
    id: PYTORCH_CUDA_RUNTIME_ID,
    name: 'PyTorch CUDA 运行时（GPU 加速）',
    description:
      'Qwen3 GPU 合成依赖（约 2.3GB）。支持断点续传；下载完成后自动安装到内置 Python。仅 CPU 可跳过。',
    group: 'tts-synth' as const,
    sizeBytes: PYTORCH_CUDA_RUNTIME_SIZE,
    dir: 'runtime/pytorch-cu121',
    files: [TORCH_CU121_WHL, TORCHAUDIO_CU121_WHL],
    downloadUrl: '',
    type: 'wheels' as const,
    httpFiles: [
      {
        local: TORCH_CU121_WHL,
        sizeBytes: TORCH_CU121_SIZE,
        url: `https://mirrors.aliyun.com/pytorch-wheels/cu121/${TORCH_CU121_WHL}`,
        urls: [
          `https://download-r2.pytorch.org/whl/cu121/${TORCH_CU121_WHL}`,
          `https://download.pytorch.org/whl/cu121/torch/${TORCH_CU121_WHL}`,
        ],
      },
      {
        local: TORCHAUDIO_CU121_WHL,
        sizeBytes: TORCHAUDIO_CU121_SIZE,
        url: `https://mirrors.aliyun.com/pytorch-wheels/cu121/${TORCHAUDIO_CU121_WHL}`,
        urls: [
          `https://download-r2.pytorch.org/whl/cu121/${TORCHAUDIO_CU121_WHL}`,
          `https://download.pytorch.org/whl/cu121/torchaudio/${TORCHAUDIO_CU121_WHL}`,
        ],
      },
    ] as HttpFileMapping[],
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
  /** 速度估算 */
  lastSpeedAt?: number
  lastSpeedBytes?: number
  bytesPerSecond?: number
}

/**
 * 语音模型本地下载与就绪检测
 */
export class VoiceModelManager {
  private tasks = new Map<string, TaskRuntime>()

  private get baseDir(): string {
    return path.join(resolveWindowsClientDataRoot(), 'models', 'voice')
  }

  private get legacyBaseDir(): string {
    return path.join(app.getPath('userData'), 'models', 'voice')
  }

  private get tempDir(): string {
    return path.join(app.getPath('temp'), 'lumii-voice-models')
  }

  /** 解析模型目录：新路径优先，否则回退 legacy userData */
  private resolveModelDir(relDir: string): string {
    const primary = path.join(this.baseDir, relDir)
    if (fs.existsSync(primary)) return primary
    const legacy = path.join(this.legacyBaseDir, relDir)
    if (fs.existsSync(legacy)) return legacy
    return primary
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
    return {
      vad: path.join(this.resolveModelDir('vad'), 'silero_vad.onnx'),
      asr: this.resolveModelDir('asr/paraformer-zh-small'),
      tts: this.resolveModelDir('tts/melo-zh-en'),
      qwen3Tokenizer: this.resolveModelDir('tts/qwen3/tokenizer-12hz'),
      qwen3Custom06: this.resolveModelDir('tts/qwen3/0.6b-custom'),
      qwen3Custom17: this.resolveModelDir('tts/qwen3/1.7b-custom'),
      qwen3Base06: this.resolveModelDir('tts/qwen3/0.6b-base'),
      qwen3Base17: this.resolveModelDir('tts/qwen3/1.7b-base'),
    }
  }

  isModelDownloaded(modelId: ModelId): boolean {
    const model = MODEL_CATALOG[modelId]
    if (!model) return false

    const tryDir = (root: string): boolean => {
      const modelDir = path.join(root, model.dir)
      if (!fs.existsSync(modelDir)) return false

      // snapshot/dir：必须完成标记 + 清单文件 + 权重，防止暂停后误判就绪
      if (model.type === 'dir') {
        const markerOk = fs.existsSync(path.join(modelDir, DOWNLOAD_COMPLETE_MARKER))
        const filesOk =
          'files' in model ? model.files.every((f) => fs.existsSync(path.join(modelDir, f))) : true
        return markerOk && filesOk && hasModelWeightFiles(modelDir)
      }

      // wheel 运行时：文件齐 + 安装完成标记（pip 装进内置 Python 后写入）
      if (model.type === 'wheels') {
        const markerOk = fs.existsSync(path.join(modelDir, DOWNLOAD_COMPLETE_MARKER))
        const filesOk = model.files.every((f) => {
          const p = path.join(modelDir, f)
          return fs.existsSync(p) && fs.statSync(p).size > 0
        })
        return markerOk && filesOk
      }

      if ('files' in model) {
        const allPresent = model.files.every((f) => fs.existsSync(path.join(modelDir, f)))
        if (!allPresent) return false
        // 需整目录的模型（如 MeloTTS 的 dict/），目录须存在且非空
        if ('dirs' in model && Array.isArray(model.dirs)) {
          const dirsOk = model.dirs.every((d) => {
            const dp = path.join(modelDir, d)
            try {
              return fs.existsSync(dp) && fs.readdirSync(dp).length > 0
            } catch {
              return false
            }
          })
          if (!dirsOk) return false
        }
        if (modelId === 'asr-paraformer-zh') {
          const onnx = path.join(modelDir, 'model.int8.onnx')
          if (!hasSherpaParaformerMetadata(onnx)) {
            log.warn(
              `[isModelDownloaded] ASR 模型缺少 sherpa metadata（vocab_size），已标记未就绪并清理，请重新下载`,
            )
            this.purgeModelDir(modelDir)
            return false
          }
        }
        return true
      }
      const filename = (model as { filename?: string }).filename
      if (!filename) return false
      return fs.existsSync(path.join(root, model.dir, filename))
    }

    return tryDir(this.baseDir) || tryDir(this.legacyBaseDir)
  }

  /**
   * 返回已下载的 PyTorch CUDA wheel 目录（未就绪则 null）
   */
  getPytorchCudaWheelDir(): string | null {
    if (!this.isModelDownloaded(PYTORCH_CUDA_RUNTIME_ID)) return null
    return path.join(this.baseDir, MODEL_CATALOG[PYTORCH_CUDA_RUNTIME_ID].dir)
  }

  /**
   * 统计 httpFiles 模型已落地字节（含 .partial），用于暂停续传进度展示
   */
  private httpFilesProgressBytes(modelId: ModelId): number {
    const model = MODEL_CATALOG[modelId]
    if (!model || !('httpFiles' in model) || !model.httpFiles) return 0
    const targetDir = path.join(this.baseDir, model.dir)
    let bytes = 0
    for (const item of model.httpFiles) {
      const dest = path.join(targetDir, item.local)
      if (fs.existsSync(dest)) {
        try {
          bytes += fs.statSync(dest).size
          continue
        } catch {
          /* ignore */
        }
      }
      const partial = path.join(this.tempDir, `${model.id}-${item.local.replace(/[\\/]/g, '_')}.partial`)
      if (fs.existsSync(partial)) {
        try {
          bytes += fs.statSync(partial).size
        } catch {
          /* ignore */
        }
      }
    }
    return bytes
  }

  /**
   * httpFiles 是否有未完成残留（可继续）
   */
  private hasIncompleteHttpDownload(modelId: ModelId): boolean {
    const model = MODEL_CATALOG[modelId]
    if (!model || !('httpFiles' in model) || !model.httpFiles) return false
    if (this.isModelDownloaded(modelId)) return false
    return this.httpFilesProgressBytes(modelId) > 0
  }

  /**
   * 写入 snapshot 完成标记
   */
  private markDownloadComplete(modelDir: string): void {
    try {
      fs.mkdirSync(modelDir, { recursive: true })
      fs.writeFileSync(
        path.join(modelDir, DOWNLOAD_COMPLETE_MARKER),
        JSON.stringify({ completedAt: Date.now() }),
        'utf8',
      )
    } catch (e) {
      log.warn(`[markDownloadComplete] 写入标记失败 ${modelDir}:`, e)
    }
  }

  /**
   * 目录模型是否存在未完成残留（可继续下载）
   */
  private hasIncompleteDirDownload(modelId: ModelId): boolean {
    const model = MODEL_CATALOG[modelId]
    if (!model || model.type !== 'dir') return false
    const modelDir = path.join(this.baseDir, model.dir)
    if (!fs.existsSync(modelDir)) return false
    if (fs.existsSync(path.join(modelDir, DOWNLOAD_COMPLETE_MARKER))) return false
    return dirSizeBytes(modelDir) > 0
  }

  /**
   * 删除模型目录（用于清除不兼容的缓存）
   */
  private purgeModelDir(modelDir: string): void {
    try {
      if (fs.existsSync(modelDir)) {
        fs.rmSync(modelDir, { recursive: true, force: true })
      }
    } catch (e) {
      log.warn(`[purgeModelDir] 清理失败 ${modelDir}:`, e)
    }
  }

  /**
   * 判断通话所需模型是否就绪。
   * Edge 无需本地 TTS；qwen3 需 Tokenizer + Base；其余要求 VITS。
   */
  areRequiredModelsReady(ttsProvider?: string, qwen3Variant?: string): boolean {
    if (!this.isModelDownloaded('vad') || !this.isModelDownloaded('asr-paraformer-zh')) {
      return false
    }
    if (ttsProvider === 'edge') return true
    if (ttsProvider === 'qwen3') {
      return this.isQwen3Ready(qwen3Variant ?? '0.6b-custom')
    }
    return this.isModelDownloaded('tts-melo-zh-en')
  }

  /**
   * 判断当前 TTS 引擎是否可用
   */
  isTtsReady(provider: string, qwen3Variant?: string): boolean {
    if (provider === 'edge') return true
    if (provider === 'qwen3') {
      return this.isQwen3Ready(qwen3Variant ?? '0.6b-custom')
    }
    return this.isModelDownloaded('tts-melo-zh-en')
  }

  /**
   * Qwen3：Tokenizer + 对应变体均已下载
   */
  isQwen3Ready(variant: string = '0.6b-custom'): boolean {
    if (!this.isModelDownloaded('tts-qwen3-tokenizer-12hz')) return false
    switch (variant) {
      case '1.7b-custom':
        return this.isModelDownloaded('tts-qwen3-1.7b-custom')
      case '0.6b-base':
        return this.isModelDownloaded('tts-qwen3-0.6b-base')
      case '1.7b-base':
        return this.isModelDownloaded('tts-qwen3-1.7b-base')
      case '0.6b-custom':
      default:
        return this.isModelDownloaded('tts-qwen3-0.6b-custom')
    }
  }

  /**
   * 是否已具备可不克隆的 Qwen3 合成（Tokenizer + 任一 CustomVoice）
   */
  isQwen3CustomSynthReady(): boolean {
    return (
      this.isModelDownloaded('tts-qwen3-tokenizer-12hz') &&
      (this.isModelDownloaded('tts-qwen3-0.6b-custom') ||
        this.isModelDownloaded('tts-qwen3-1.7b-custom'))
    )
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
        } else if (!downloaded && this.hasIncompleteDirDownload(id)) {
          // snapshot 暂停/中断：用目录体积估算进度，并标为可继续
          downloadedBytes = dirSizeBytes(path.join(this.baseDir, m.dir))
          if (!task || task.state === 'idle') {
            downloadState = 'paused'
          }
        } else if (!downloaded && this.hasIncompleteHttpDownload(id)) {
          downloadedBytes = this.httpFilesProgressBytes(id)
          if (!task || task.state === 'idle') {
            downloadState = 'paused'
          }
        }
      }
      return {
        id: m.id,
        name: m.name,
        description: 'description' in m ? String((m as { description?: string }).description || '') : undefined,
        sizeBytes: m.sizeBytes,
        downloaded,
        path: path.join(this.baseDir, m.dir),
        downloadState,
        downloadedBytes,
        bytesPerSecond: task?.bytesPerSecond,
        group: 'group' in m ? String((m as { group?: string }).group || '') : undefined,
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
      bytesPerSecond?: number
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
          task.bytesPerSecond = 0
          let partialSize = fs.existsSync(this.partialPath(modelId))
            ? fs.statSync(this.partialPath(modelId)).size
            : task.downloadedBytes
          if (model.type === 'dir') {
            const dirBytes = dirSizeBytes(path.join(this.baseDir, model.dir))
            if (dirBytes > 0) partialSize = dirBytes
          } else if ('httpFiles' in model && model.httpFiles) {
            const httpBytes = this.httpFilesProgressBytes(modelId as ModelId)
            if (httpBytes > 0) partialSize = httpBytes
          }
          task.downloadedBytes = partialSize
          const total = task.totalBytes || model.sizeBytes
          onProgress({
            progress: total > 0 ? Math.min(0.99, partialSize / total) : 0,
            downloadedBytes: partialSize,
            totalBytes: total,
            state: 'paused',
            bytesPerSecond: 0,
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
    const model = MODEL_CATALOG[modelId as ModelId]
    if (model?.type === 'dir') {
      const size = dirSizeBytes(path.join(this.baseDir, model.dir))
      if (size > 0) {
        task.downloadedBytes = size
        task.totalBytes = Math.max(task.totalBytes, model.sizeBytes)
      }
    }
    task.bytesPerSecond = 0
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
    // snapshot 未完成目录一并清理，避免残留 config 误导
    const model = MODEL_CATALOG[modelId as ModelId]
    if (model?.type === 'dir' && !this.isModelDownloaded(modelId as ModelId)) {
      this.purgeModelDir(path.join(this.baseDir, model.dir))
    }
    if (model?.type === 'wheels' && !this.isModelDownloaded(modelId as ModelId)) {
      this.purgeModelDir(path.join(this.baseDir, model.dir))
      // 清理各 wheel 的 .partial
      if ('httpFiles' in model && model.httpFiles) {
        for (const item of model.httpFiles) {
          const partial = path.join(
            this.tempDir,
            `${model.id}-${item.local.replace(/[\\/]/g, '_')}.partial`,
          )
          try {
            if (fs.existsSync(partial)) fs.unlinkSync(partial)
          } catch {
            /* ignore */
          }
        }
      }
    }
    task.state = 'idle'
    task.downloadedBytes = 0
    task.totalBytes = 0
    task.bytesPerSecond = 0
    task.errorMessage = undefined
    log.info(`[cancelDownload] 已取消并清理: ${modelId}`)
    return true
  }

  /**
   * 卸载已下载模型/运行时：取消进行中的下载，删除本地目录与断点文件；
   * PyTorch CUDA 运行时额外从内置 Python pip 卸载 torch 栈。
   */
  async uninstallModel(modelId: string): Promise<{ ok: boolean; error?: string }> {
    const model = MODEL_CATALOG[modelId as ModelId]
    if (!model) {
      return { ok: false, error: `未知模型: ${modelId}` }
    }

    // 先停下载并清 partial（cancel 对已就绪目录不会删）
    this.cancelDownload(modelId)

    try {
      if (modelId === PYTORCH_CUDA_RUNTIME_ID) {
        await uninstallPytorchFromBundledPython()
      }

      this.purgeModelDir(path.join(this.baseDir, model.dir))
      this.purgeModelDir(path.join(this.legacyBaseDir, model.dir))

      // 再清一遍可能残留的 partial / tar
      const partial = this.partialPath(modelId)
      try {
        if (fs.existsSync(partial)) fs.unlinkSync(partial)
      } catch {
        /* ignore */
      }
      if (model.type !== 'single' && model.type !== 'wheels') {
        const tarFile = path.join(this.tempDir, `${model.id}.tar.bz2`)
        try {
          if (fs.existsSync(tarFile)) fs.unlinkSync(tarFile)
        } catch {
          /* ignore */
        }
      }
      if ('httpFiles' in model && model.httpFiles) {
        for (const item of model.httpFiles) {
          const httpPartial = path.join(
            this.tempDir,
            `${model.id}-${item.local.replace(/[\\/]/g, '_')}.partial`,
          )
          try {
            if (fs.existsSync(httpPartial)) fs.unlinkSync(httpPartial)
          } catch {
            /* ignore */
          }
        }
      }

      const task = this.getOrCreateTask(modelId)
      task.state = 'idle'
      task.downloadedBytes = 0
      task.totalBytes = 0
      task.bytesPerSecond = 0
      task.errorMessage = undefined
      task.abort = null

      if (this.isModelDownloaded(modelId as ModelId)) {
        return { ok: false, error: '卸载后仍检测到本地文件，请手动删除后重试' }
      }

      log.info(`[uninstallModel] 已卸载: ${modelId}`)
      return { ok: true }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      log.error(`[uninstallModel] 失败 ${modelId}: ${message}`)
      return { ok: false, error: message }
    }
  }

  private async _downloadModel(
    model: (typeof MODEL_CATALOG)[ModelId],
    task: TaskRuntime,
    onProgress: (p: {
      progress: number
      downloadedBytes: number
      totalBytes: number
      state: VoiceModelDownloadState
      bytesPerSecond?: number
    }) => void,
    signal: AbortSignal,
  ): Promise<void> {
    fs.mkdirSync(this.tempDir, { recursive: true })
    const targetDir = path.join(this.baseDir, model.dir)
    fs.mkdirSync(targetDir, { recursive: true })
    // 重新下载前去掉旧完成标记，避免半成品仍显示就绪
    try {
      const marker = path.join(targetDir, DOWNLOAD_COMPLETE_MARKER)
      if (fs.existsSync(marker)) fs.unlinkSync(marker)
    } catch {
      /* ignore */
    }

    const report = (downloadedBytes: number, totalBytes: number, state: VoiceModelDownloadState) => {
      const now = Date.now()
      if (task.lastSpeedAt != null && task.lastSpeedBytes != null) {
        const dt = (now - task.lastSpeedAt) / 1000
        if (dt >= 0.4) {
          const db = downloadedBytes - task.lastSpeedBytes
          task.bytesPerSecond = Math.max(0, db / dt)
          task.lastSpeedAt = now
          task.lastSpeedBytes = downloadedBytes
        }
      } else {
        task.lastSpeedAt = now
        task.lastSpeedBytes = downloadedBytes
        task.bytesPerSecond = 0
      }
      task.downloadedBytes = downloadedBytes
      task.totalBytes = totalBytes
      task.state = state
      const progress = totalBytes > 0 ? Math.min(1, downloadedBytes / totalBytes) : 0
      onProgress({
        progress,
        downloadedBytes,
        totalBytes,
        state,
        bytesPerSecond: task.bytesPerSecond,
      })
    }

    // 1) ModelScope 官方 SDK（国内高速）
    if ('modelscope' in model && model.modelscope) {
      let dirPoll: ReturnType<typeof setInterval> | null = null
      try {
        log.info(`[_downloadModel] 优先魔搭 SDK: ${model.modelscope.modelId}`)
        // snapshot 下载时 SDK 进度可能稀疏，定时用目录体积刷新速度
        if (model.type === 'dir') {
          dirPoll = setInterval(() => {
            if (signal.aborted) return
            const bytes = dirSizeBytes(targetDir)
            if (bytes > 0) {
              report(Math.min(bytes, model.sizeBytes), model.sizeBytes, 'downloading')
            }
          }, 1000)
        }
        await downloadViaModelScopeSdk(
          {
            modelId: model.modelscope.modelId,
            outDir: targetDir,
            files: [...model.modelscope.files],
            mode:
              'mode' in model.modelscope && model.modelscope.mode
                ? model.modelscope.mode
                : model.modelscope.files.length === 0
                  ? 'snapshot'
                  : 'files',
            extractTokensFromConfig:
              'extractTokensFromConfig' in model.modelscope
                ? Boolean(model.modelscope.extractTokensFromConfig)
                : false,
          },
          (p) => {
            const fromDir = model.type === 'dir' ? dirSizeBytes(targetDir) : 0
            const fromPct = Math.round((p.percent || 0) * model.sizeBytes)
            const bytes = Math.max(fromDir, fromPct)
            report(Math.min(bytes, model.sizeBytes), model.sizeBytes, 'downloading')
          },
          signal,
        )
        if (dirPoll) {
          clearInterval(dirPoll)
          dirPoll = null
        }
        if (signal.aborted) throw new Error(task.pausing ? '已暂停' : '已取消')
        // 清理中间产物
        const cfg = path.join(targetDir, 'config.yaml')
        if (fs.existsSync(cfg)) {
          try {
            fs.unlinkSync(cfg)
          } catch {
            /* ignore */
          }
        }
        if (model.type === 'dir') {
          if (!hasModelWeightFiles(targetDir)) {
            throw new Error('魔搭下载完成但未发现模型权重文件，请重试')
          }
          this.markDownloadComplete(targetDir)
        }
        if (!this.isModelDownloaded(model.id as ModelId)) {
          throw new Error('魔搭下载完成但缺少必需文件')
        }
        log.info(`[_downloadModel] ${model.name} 魔搭 SDK 完成`)
        return
      } catch (e) {
        if (dirPoll) {
          clearInterval(dirPoll)
          dirPoll = null
        }
        if (signal.aborted) throw e
        const msg = e instanceof Error ? e.message : String(e)
        log.warn(`[_downloadModel] 魔搭 SDK 失败，回退 HTTP: ${msg}`)
        // Qwen3 等仅魔搭 snapshot 的条目：无直链/GitHub 包，直接失败
        if (model.type === 'dir' && !model.downloadUrl) {
          throw new Error(`魔搭下载失败（无备用源）: ${msg}`)
        }
      }
    }

    // 2) 国内 HTTP 多文件直链（如 hf-mirror / PyTorch wheel）
    if ('httpFiles' in model && model.httpFiles && model.httpFiles.length > 0) {
      try {
        await this._downloadHttpFiles(model.httpFiles, targetDir, model, task, report, signal)
        if (signal.aborted) throw new Error(task.pausing ? '已暂停' : '已取消')

        // CUDA wheel：下载后本地 pip 安装（仍走模型进度 UI 的 extracting 态）
        if (model.id === PYTORCH_CUDA_RUNTIME_ID) {
          task.state = 'extracting'
          report(model.sizeBytes, model.sizeBytes, 'extracting')
          log.info(`[_downloadModel] 正在从本地 wheel 安装 PyTorch CUDA…`)
          await installPytorchCudaFromWheelDir(targetDir, signal)
          if (signal.aborted) throw new Error(task.pausing ? '已暂停' : '已取消')
          this.markDownloadComplete(targetDir)
        }

        if (!this.isModelDownloaded(model.id as ModelId)) {
          throw new Error('HTTP 多文件下载完成但缺少必需文件')
        }
        log.info(`[_downloadModel] ${model.name} 国内直链完成`)
        return
      } catch (e) {
        if (signal.aborted) throw e
        const msg = e instanceof Error ? e.message : String(e)
        // 纯 wheel 条目无 GitHub 回退
        if (model.type === 'wheels' || !model.downloadUrl) {
          throw e
        }
        log.warn(`[_downloadModel] 国内直链失败，回退 GitHub: ${msg}`)
      }
    }

    // 3) GitHub Releases（镜像 + Range 续传）
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

      // 整目录拷贝（如 MeloTTS 的 dict/ jieba 分词目录）
      if ('dirs' in model && Array.isArray(model.dirs)) {
        for (const d of model.dirs) {
          const src = path.join(extractedDir, d)
          const dst = path.join(targetDir, d)
          if (fs.existsSync(src)) {
            fs.cpSync(src, dst, { recursive: true })
          } else {
            log.warn(`[_downloadModel] 目录不存在: ${src}`)
          }
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
   * 按文件列表直链下载（支持单文件 Range 续传到 .partial、多源回退、按字节加权进度）
   * 核心文件失败则抛错；可选文件（.fst）失败仅告警
   */
  private async _downloadHttpFiles(
    files: readonly HttpFileMapping[],
    targetDir: string,
    model: (typeof MODEL_CATALOG)[ModelId],
    task: TaskRuntime,
    onProgress: (downloadedBytes: number, totalBytes: number, state: VoiceModelDownloadState) => void,
    signal: AbortSignal,
  ): Promise<void> {
    const requiredLocals =
      'files' in model ? new Set(model.files) : new Set<string>(['model.onnx', 'lexicon.txt', 'tokens.txt'])
    const knownTotal = files.reduce((sum, f) => sum + (f.sizeBytes ?? 0), 0)
    const useByteWeights = knownTotal > 0
    const modelTotal = useByteWeights ? knownTotal : model.sizeBytes
    let completedBytes = 0

    for (let i = 0; i < files.length; i++) {
      const item = files[i]!
      if (signal.aborted) throw new Error(task.pausing ? '已暂停' : '已取消')
      const dest = path.join(targetDir, item.local)
      const optional = !requiredLocals.has(item.local)
      const fileWeight = useByteWeights
        ? (item.sizeBytes ?? Math.max(1, Math.floor(modelTotal / files.length)))
        : Math.floor(model.sizeBytes / files.length)

      if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
        completedBytes += useByteWeights ? fs.statSync(dest).size : fileWeight
        onProgress(Math.min(completedBytes, modelTotal), modelTotal, 'downloading')
        continue
      }

      const partial = path.join(this.tempDir, `${model.id}-${item.local.replace(/[\\/]/g, '_')}.partial`)
      const candidates = httpFileCandidateUrls(item)
      let lastErr: unknown
      let ok = false
      for (const candidate of candidates) {
        if (signal.aborted) throw new Error(task.pausing ? '已暂停' : '已取消')
        try {
          await this._downloadFileOnce(
            candidate,
            partial,
            task,
            (downloaded, fileTotal, state) => {
              const curFileTotal = fileTotal > 0 ? fileTotal : fileWeight
              const overall = completedBytes + downloaded
              const total = useByteWeights
                ? Math.max(modelTotal, completedBytes + curFileTotal)
                : model.sizeBytes
              onProgress(Math.min(overall, total), total, state)
            },
            signal,
          )
          ok = true
          break
        } catch (e) {
          lastErr = e
          if (signal.aborted) throw e
          log.warn(
            `[_downloadHttpFiles] ${item.local} 源失败 ${candidate.slice(0, 80)}…: ${
              e instanceof Error ? e.message : e
            }`,
          )
          // Range/损坏时清 partial 换源重试
          const msg = e instanceof Error ? e.message : String(e)
          if (msg.includes('不支持断点续传') || msg.includes('HTTP 416') || msg.includes('范围无效')) {
            try {
              if (fs.existsSync(partial)) fs.unlinkSync(partial)
            } catch {
              /* ignore */
            }
          }
        }
      }

      if (!ok) {
        try {
          if (fs.existsSync(partial)) fs.unlinkSync(partial)
        } catch {
          /* ignore */
        }
        if (optional) {
          log.warn(
            `[_downloadHttpFiles] 可选文件跳过 ${item.local}: ${
              lastErr instanceof Error ? lastErr.message : lastErr
            }`,
          )
          continue
        }
        throw lastErr instanceof Error
          ? lastErr
          : new Error(`下载失败: ${item.local}`)
      }

      if (signal.aborted) throw new Error(task.pausing ? '已暂停' : '已取消')
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.renameSync(partial, dest)
      completedBytes += useByteWeights ? fs.statSync(dest).size : fileWeight
      onProgress(Math.min(completedBytes, modelTotal), modelTotal, 'downloading')
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
