/**
 * AgentRuntimeBridge 图片识别与生成服务
 *
 * 拆自 bridge.ts，封装 recognizeImage / generateImage 两个面向 UI 的能力。
 * 不持有自身状态，仅通过 deps 注入 Gateway 配置、ModelRouter 与 stream 引用。
 */

import path from 'node:path'
import fs from 'node:fs'
import {
  createGatewayStreamFn,
  createDirectStreamFn,
  DEFAULT_GATEWAY_STREAM_PATH,
  ModelRouter,
} from '@mtbot/agent-runtime'
import { resizeImageIfNeeded } from './image-resizer'
import { generateImageViaRightCodesDraw } from './right-codes-draw-client'
import { generateImageViaGateway } from './gateway-image-client'
import { agentRuntimeLog as log } from './bridge-utils'
import { loadSlotConfig, applyImageSlotToDrawEnv, ensureProviderBaseUrl } from '../provider-config'

export interface BridgeImageServicesDeps {
  /** Gateway 基础 URL（不含 stream 路径） */
  getGatewayUrl: () => string
  /** 获取最新 Auth Token */
  getAuthToken: () => Promise<string>
  /** 获取设备 ID（可选） */
  getDeviceId?: () => string | undefined
  /** 模型路由器，用于按 tier / 显式 ID 解析模型 */
  getModelRouter: () => ModelRouter
  /** 当前工作目录（图片路径相对解析） */
  getCwd: () => string
}

export class BridgeImageServices {
  /**
   * 图片识别专用的独立 stream（懒创建，缓存）。
   *
   * 不依赖任何 Agent 实例，仅在 recognizeImage 调用时按需创建。
   * 解决：新建会话首条消息就上传图片时，主 Agent 尚未初始化导致识别失败的问题。
   */
  private recognitionStream: ReturnType<typeof createGatewayStreamFn> | null = null

  constructor(private readonly deps: BridgeImageServicesDeps) {}

  /**
   * 懒创建图片识别专用 GatewayStream（不依赖任何 Agent 实例）。
   */
  private getOrCreateRecognitionStream(): ReturnType<typeof createGatewayStreamFn> {
    if (this.recognitionStream) return this.recognitionStream
    const streamPathOverride = process.env.MTBOT_GATEWAY_STREAM_PATH?.trim()
    log.info(`[getOrCreateRecognitionStream] 创建图片识别专用 stream`)
    this.recognitionStream = createGatewayStreamFn({
      gatewayUrl: this.deps.getGatewayUrl(),
      streamPath: streamPathOverride || DEFAULT_GATEWAY_STREAM_PATH,
      getAuthToken: this.deps.getAuthToken,
      getDeviceId: this.deps.getDeviceId,
      log: (msg) => log.info(`[recognitionStream] ${msg}`),
      getMetadata: () => ({
        channel: 'windows-agent-runtime-image-recognition',
      }),
    })
    return this.recognitionStream
  }

  /**
   * 图片识别：调用多模态模型对图片内容进行理解，返回描述 + OCR。
   *
   * 使用独立的 recognitionStream（不依赖主 Agent 是否已初始化），
   * 即便用户在新会话首条消息就上传图片也能正常识别。
   *
   * 若 `modelId` 省略则使用 `balanced` tier 的默认模型（一般是国内小模型）。
   */
  async recognizeImage(options: {
    imagePath: string
    modelId?: string
    prompt?: string
    includeOcr?: boolean
  }): Promise<{ description: string; ocrText: string; modelId: string; provider: string }> {
    const visionSlot = loadSlotConfig('vision')
    const useDirectVision = visionSlot.enabled && !!visionSlot.modelId
    const router = this.deps.getModelRouter()

    // 解析实际使用的 Model：优先 explicit → vision 槽 → balanced
    const resolvedModelId = options.modelId || (useDirectVision ? visionSlot.modelId : undefined)
    const model = resolvedModelId
      ? router.resolveExplicitModelId(resolvedModelId)
      : router.resolve('balanced')

    // 直连时补全 image input，避免 pi-ai 拒绝
    if (useDirectVision && !model.input?.includes('image')) {
      ;(model as { input?: string[] }).input = ['text', 'image']
    }

    // 验证模型是否支持视觉输入（网关路径）
    if (!useDirectVision && !model.input?.includes('image')) {
      throw Object.assign(
        new Error(
          `模型 ${model.id} 不支持图像输入（input=${JSON.stringify(model.input)}），请在「模型配置 → 视觉理解」中配置支持 vision 的模型`,
        ),
        { code: 'MODEL_NO_VISION' as const },
      )
    }

    const stream = useDirectVision
      ? createDirectStreamFn({
          credentials: {
            baseUrl: ensureProviderBaseUrl(visionSlot.baseUrl, visionSlot.type),
            apiKey: visionSlot.apiKey,
          },
          log: (msg) => log.info(`[visionDirect] ${msg}`),
        })
      : this.getOrCreateRecognitionStream()

    // 读取图片 + 格式嗅探 + 自动压缩
    const cwd = this.deps.getCwd()
    const absPath = path.isAbsolute(options.imagePath)
      ? options.imagePath
      : path.join(cwd, options.imagePath)
    if (!fs.existsSync(absPath)) {
      throw Object.assign(new Error(`图片不存在: ${absPath}`), { code: 'IMAGE_NOT_FOUND' as const })
    }
    const raw = await fs.promises.readFile(absPath)
    const { buffer: processedBuf, mimeType } = await resizeImageIfNeeded(raw, path.extname(absPath))
    const base64 = processedBuf.toString('base64')

    const includeOcr = options.includeOcr !== false
    const promptText = options.prompt
      ?? `请用中文简要描述这张图片的主要内容、结构和关键元素${includeOcr ? '，并把图片中可见的所有文字逐条列出（OCR 原文）' : ''}。` +
         `\n\n请严格按以下 JSON 返回，不要包含额外说明：\n` +
         `{"description":"<图片描述>","ocrText":"<图中文字，无则空串>"}`

    const context: import('@mariozechner/pi-ai').Context = {
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: promptText },
            { type: 'image', data: base64, mimeType },
          ],
          timestamp: Date.now(),
        },
      ],
    }

    const streamResult = await stream(model, context, {})
    let text = ''
    for await (const ev of streamResult) {
      if (ev.type === 'text_delta') {
        text += ev.delta
      }
    }

    // 解析 JSON 结果：容忍模型在 JSON 前后添加 markdown 代码块 ```json...```
    let description = ''
    let ocrText = ''
    const jsonMatch = text.match(/\{[\s\S]*"description"[\s\S]*\}/)
    if (jsonMatch) {
      try {
        const parsed = JSON.parse(jsonMatch[0]) as { description?: unknown; ocrText?: unknown }
        description = typeof parsed.description === 'string' ? parsed.description : ''
        ocrText = typeof parsed.ocrText === 'string' ? parsed.ocrText : ''
      } catch {
        description = text.trim()
      }
    } else {
      description = text.trim()
    }

    const provider = useDirectVision ? visionSlot.type : ((model.api as string) ?? 'unknown')
    return { description, ocrText, modelId: model.id, provider }
  }

  /**
   * 根据文字描述生成图片，保存到 workspace/outputs/YYYYMMDD/ 目录。
   *
   * 优先经 Gateway POST /v1/image/generate（流式上游 + 服务端 IMAGE_UPSTREAM 配置）；
   * 无 token 或 MTBOT_IMAGE_DIRECT_ONLY=true 时直连上游（统一流式 chat/completions）。
   */
  async generateImage(params: {
    prompt: string
    modelId?: string
    width?: number
    height?: number
    filename?: string
    signal?: AbortSignal
  }): Promise<{ filePath: string; width: number; height: number; model: string; revisedPrompt: string }> {
    applyImageSlotToDrawEnv()
    const modelId = params.modelId ?? (() => {
      const image = loadSlotConfig('image')
      if (image.enabled && image.modelId) return image.modelId
      return 'gpt-image-2'
    })()
    log.info(`[generateImage] 开始: modelId=${modelId} prompt="${params.prompt.slice(0, 80)}..."`)

    if (params.signal?.aborted) {
      throw Object.assign(new Error('图片生成已被用户中断'), { code: 'ABORTED' })
    }

    const directOnly = process.env.MTBOT_IMAGE_DIRECT_ONLY === 'true'
    let data: {
      imageBase64: string
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
      width: number
      height: number
      revisedPrompt: string
      effectiveModelId: string
    }

    if (!directOnly) {
      try {
        data = await generateImageViaGateway({
          gatewayUrl: this.deps.getGatewayUrl(),
          getAuthToken: this.deps.getAuthToken,
          getDeviceId: this.deps.getDeviceId,
          prompt: params.prompt,
          modelId,
          width: params.width ?? 1024,
          height: params.height ?? 1024,
          signal: params.signal,
        })
        log.info(`[generateImage] Gateway 生图成功 model=${data.effectiveModelId}`)
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === 'AUTH_REQUIRED' || code === 'GATEWAY_NETWORK_ERROR') {
          log.warn(
            `[generateImage] Gateway 不可用 (${code})，回退直连上游: ${err instanceof Error ? err.message : String(err)}`,
          )
          data = await generateImageViaRightCodesDraw({
            prompt: params.prompt,
            modelId,
            width: params.width ?? 1024,
            height: params.height ?? 1024,
            signal: params.signal,
          })
        } else {
          throw err
        }
      }
    } else {
      data = await generateImageViaRightCodesDraw({
        prompt: params.prompt,
        modelId,
        width: params.width ?? 1024,
        height: params.height ?? 1024,
        signal: params.signal,
      })
    }

    // 落盘到 workspace/outputs/YYYYMMDD/<name>_<dateStr>_<uuid>.<ext>
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '')
    const uuid = crypto.randomUUID().slice(0, 8)
    const extMap: Record<string, string> = {
      'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp',
    }
    const ext = extMap[data.mimeType] ?? 'png'
    const rawName = params.filename?.trim().replace(/[^\w一-鿿\-]/g, '_').slice(0, 40)
    const baseName = rawName ? `${rawName}_${dateStr}_${uuid}` : `generated_${uuid}`
    const relPath = `outputs/${dateStr}/${baseName}.${ext}`
    const absPath = path.join(this.deps.getCwd(), relPath)
    await fs.promises.mkdir(path.dirname(absPath), { recursive: true })
    await fs.promises.writeFile(absPath, Buffer.from(data.imageBase64, 'base64'))

    log.info(`[generateImage] 已保存: ${relPath} (${data.width}x${data.height}, model=${data.effectiveModelId})`)
    return {
      filePath: relPath,
      width: data.width,
      height: data.height,
      model: data.effectiveModelId,
      revisedPrompt: data.revisedPrompt,
    }
  }
}
