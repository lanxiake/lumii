/**
 * 图片处理策略模式（前端）
 *
 * 将图片上传后的后续动作（识别 / 美化 / 风格化 / 抠图等）抽象为独立策略。
 * 每个策略实现 `ImageProcessingStrategy` 接口，在 `STRATEGY_REGISTRY` 中注册。
 *
 * 当前已实现：
 *   - recognizeStrategy: 通过多模态模型（优先国内小模型）识别图片内容，
 *     生成描述 + OCR，便于纯文本模型的 Agent 理解图片含义
 *
 * 预留策略：
 *   - beautifyStrategy: 图片美化（滤镜 / 光线 / 皮肤等）- 占位
 *   - upscaleStrategy: 分辨率提升 - 占位
 *   - bgRemoveStrategy: 智能抠图去背景 - 占位
 *
 * 调用路径：前端策略 → window.electronAPI.agentRuntime.sendCommand(image:xxx)
 * → 主进程 bridge.recognizeImage() / imageProcessors[op] → Gateway
 */

import type { AttachedFile } from './file-attachment-strategy'

const logger = {
  info: (...args: unknown[]) => console.log('[ImageProcessing]', ...args),
  warn: (...args: unknown[]) => console.warn('[ImageProcessing]', ...args),
  error: (...args: unknown[]) => console.error('[ImageProcessing]', ...args),
}

/** 策略通用上下文 */
export interface ImageProcessingContext {
  /** 当前选中的 Agent 可能对应的 vision 模型（可选） */
  visionModelId?: string
  /** 是否包含 OCR 文字提取 */
  includeOcr?: boolean
  /** 自定义提示词（仅 recognize 策略使用） */
  prompt?: string
}

/** 识别结果 */
export interface RecognitionResult {
  kind: 'recognize'
  description: string
  ocrText: string
  modelId: string
  provider: string
}

/** 处理类结果（美化 / 抠图 / 超分等），输出新图片路径 */
export interface TransformResult {
  kind: 'transform'
  operation: string
  outputPath: string
  meta?: Record<string, unknown>
}

/** 策略执行失败的结果（不抛异常，让调用方决定如何展示） */
export interface FailedResult {
  kind: 'failed'
  strategy: string
  errorCode?: string
  errorMessage: string
}

export type ImageProcessingResult = RecognitionResult | TransformResult | FailedResult

export interface ImageProcessingStrategy {
  /** 策略名称（唯一），作为注册表 key 和后端 operation 名 */
  readonly name: string
  /** 策略描述（UI 展示） */
  readonly description: string
  /** 是否默认启用（UI 默认勾选） */
  readonly defaultEnabled: boolean
  /** 判断该策略是否适用当前附件（通常只处理 image 类） */
  accepts(file: AttachedFile): boolean
  /** 执行策略 */
  run(file: AttachedFile, ctx: ImageProcessingContext): Promise<ImageProcessingResult>
}

// ---------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------

/**
 * 发送 IPC 命令的封装；通过 window.electronAPI.agentRuntime.sendCommand 进入主进程
 */
async function sendCommand<TResult>(payload: Record<string, unknown>): Promise<TResult> {
  const api = window.electronAPI?.agentRuntime
  if (!api?.sendCommand) {
    throw new Error('agentRuntime.sendCommand 不可用（非 Electron 环境？）')
  }
  return (await api.sendCommand(payload)) as TResult
}

// ---------------------------------------------------------------
// 具体策略
// ---------------------------------------------------------------

/** 图片识别策略（OCR + 图文描述，默认启用） */
export const recognizeStrategy: ImageProcessingStrategy = {
  name: 'recognize',
  description: '使用多模态模型识别图片内容并提取文字（OCR）',
  defaultEnabled: true,
  accepts(file) {
    return file.category === 'image'
  },
  async run(file, ctx) {
    logger.info(`[recognize] 开始识别 ${file.fileName}`)
    const result = await sendCommand<{
      description: string
      ocrText: string
      modelId: string
      provider: string
    }>({
      type: 'image:recognize',
      imagePath: file.filePath,
      modelId: ctx.visionModelId,
      prompt: ctx.prompt,
      includeOcr: ctx.includeOcr !== false,
    })
    logger.info(`[recognize] 完成 ${file.fileName} model=${result.modelId}`)
    return { kind: 'recognize', ...result }
  },
}

/** 图片美化策略（占位，尚未实现） */
export const beautifyStrategy: ImageProcessingStrategy = {
  name: 'beautify',
  description: '智能美化（亮度 / 色调 / 降噪），开发中',
  defaultEnabled: false,
  accepts(file) {
    return file.category === 'image'
  },
  async run(file) {
    logger.warn(`[beautify] ${file.fileName} 美化策略暂未实现`)
    return sendCommand<{ outputPath: string; operation: string }>({
      type: 'image:process',
      imagePath: file.filePath,
      operation: 'beautify',
    }).then((r) => ({ kind: 'transform', ...r }))
  },
}

/** 分辨率提升策略（占位） */
export const upscaleStrategy: ImageProcessingStrategy = {
  name: 'upscale',
  description: '超分辨率（2x / 4x），开发中',
  defaultEnabled: false,
  accepts(file) {
    return file.category === 'image'
  },
  async run(file) {
    return sendCommand<{ outputPath: string; operation: string }>({
      type: 'image:process',
      imagePath: file.filePath,
      operation: 'upscale',
    }).then((r) => ({ kind: 'transform', ...r }))
  },
}

/** 智能抠图策略（占位） */
export const bgRemoveStrategy: ImageProcessingStrategy = {
  name: 'bg-remove',
  description: '智能抠图去背景，开发中',
  defaultEnabled: false,
  accepts(file) {
    return file.category === 'image'
  },
  async run(file) {
    return sendCommand<{ outputPath: string; operation: string }>({
      type: 'image:process',
      imagePath: file.filePath,
      operation: 'bg-remove',
    }).then((r) => ({ kind: 'transform', ...r }))
  },
}

// ---------------------------------------------------------------
// 策略注册表
// ---------------------------------------------------------------

const STRATEGY_REGISTRY: ImageProcessingStrategy[] = [
  recognizeStrategy,
  beautifyStrategy,
  upscaleStrategy,
  bgRemoveStrategy,
]

/** 注册自定义策略（后续扩展） */
export function registerImageProcessingStrategy(strategy: ImageProcessingStrategy): void {
  const existing = STRATEGY_REGISTRY.findIndex((s) => s.name === strategy.name)
  if (existing >= 0) {
    logger.warn(`[register] 覆盖已存在策略: ${strategy.name}`)
    STRATEGY_REGISTRY.splice(existing, 1, strategy)
  } else {
    STRATEGY_REGISTRY.push(strategy)
  }
}

/** 列出所有注册的策略 */
export function listImageProcessingStrategies(): readonly ImageProcessingStrategy[] {
  return STRATEGY_REGISTRY
}

/** 获取默认启用的策略（一般是 recognize） */
export function getDefaultStrategies(): readonly ImageProcessingStrategy[] {
  return STRATEGY_REGISTRY.filter((s) => s.defaultEnabled)
}

/**
 * 对附件列表按策略批量处理（仅处理 image 类附件，非 image 直接跳过）
 *
 * 出错不抛异常：单个附件失败只记录 warn 并返回 null，避免一张图失败阻塞整批上传
 */
export async function runImageProcessing(
  files: readonly AttachedFile[],
  strategies: readonly ImageProcessingStrategy[],
  ctx: ImageProcessingContext = {},
): Promise<Map<string, ImageProcessingResult[]>> {
  const results = new Map<string, ImageProcessingResult[]>()
  for (const file of files) {
    if (file.category !== 'image') continue
    const outcomes: ImageProcessingResult[] = []
    for (const strategy of strategies) {
      if (!strategy.accepts(file)) continue
      try {
        const r = await strategy.run(file, ctx)
        outcomes.push(r)
      } catch (err) {
        const errorCode = (err as { code?: string }).code
        const errorMessage = err instanceof Error ? err.message : String(err)
        logger.warn(`[runImageProcessing] ${strategy.name} 处理 ${file.fileName} 失败 (code=${errorCode ?? 'none'}):`, err)
        outcomes.push({ kind: 'failed', strategy: strategy.name, errorCode, errorMessage })
      }
    }
    if (outcomes.length > 0) {
      results.set(file.filePath, outcomes)
    }

  }
  return results
}

/**
 * 将识别结果序列化为"附加信息块"，追加到消息文本。
 * Agent 可直接看到图片描述和 OCR 内容，无需再调用工具读取。
 */
export function serializeRecognitionResults(
  results: Map<string, ImageProcessingResult[]>,
  fileNameMap: Map<string, string>,
): string {
  if (results.size === 0) return ''
  const lines: string[] = []
  for (const [filePath, outcomes] of results) {
    const recognition = outcomes.find((o): o is RecognitionResult => o.kind === 'recognize')
    if (!recognition) continue
    const fileName = fileNameMap.get(filePath) ?? filePath
    lines.push(`[image recognition: ${fileName}]`)
    if (recognition.description) {
      lines.push(`描述: ${recognition.description}`)
    }
    if (recognition.ocrText) {
      lines.push(`OCR: ${recognition.ocrText}`)
    }
    lines.push('')
  }
  return lines.join('\n').trim()
}
