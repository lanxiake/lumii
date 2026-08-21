/**
 * AgentRuntimeBridge 图片识别与生成服务
 *
 * 拆自 bridge.ts，封装 recognizeImage / generateImage 两个面向 UI 的能力。
 * 不持有自身状态，仅通过 deps 注入 ModelRouter 与工作目录。
 */

import path from 'node:path'
import fs from 'node:fs'
import {
  createDirectStreamFn,
  ModelRouter,
  resolveAgentFilePath,
} from '@mtbot/agent-runtime'
import { resizeImageIfNeeded } from './image-resizer'
import { generateImageViaRightCodesDraw } from './right-codes-draw-client'
import { generateImageViaRightApi, DEFAULT_RIGHTAPI_BASE_URL } from './rightapi-image-client'
import { agentRuntimeLog as log } from './bridge-utils'
import { loadSlotConfig, applyImageSlotToDrawEnv, ensureProviderBaseUrl } from '../provider-config'

export interface BridgeImageServicesDeps {
  /** 模型路由器，用于按 tier / 显式 ID 解析模型 */
  getModelRouter: () => ModelRouter
  /** 当前工作目录（图片路径相对解析） */
  getCwd: () => string
}

export class BridgeImageServices {
  constructor(private readonly deps: BridgeImageServicesDeps) {}

  /**
   * 图片识别：调用多模态模型对图片内容进行理解，返回描述 + OCR。
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

    if (!useDirectVision) {
      throw Object.assign(
        new Error('请先在设置中配置视觉理解模型（模型配置 → 视觉理解）'),
        { code: 'MODEL_NO_VISION' as const },
      )
    }

    // 解析实际使用的 Model：优先 explicit → vision 槽
    const resolvedModelId = options.modelId || visionSlot.modelId
    const model = resolvedModelId
      ? router.resolveExplicitModelId(resolvedModelId)
      : router.resolve('balanced')

    // 直连时补全 image input，避免 pi-ai 拒绝
    if (!model.input?.includes('image')) {
      ;(model as { input?: string[] }).input = ['text', 'image']
    }

    const stream = createDirectStreamFn({
      credentials: {
        baseUrl: ensureProviderBaseUrl(visionSlot.baseUrl, visionSlot.type),
        apiKey: visionSlot.apiKey,
      },
      log: (msg) => log.info(`[visionDirect] ${msg}`),
    })

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

    const provider = visionSlot.type
    return { description, ocrText, modelId: model.id, provider }
  }

  /**
   * 读取参考图并转为 data URL 数组（供图生图使用）。
   *
   * 逐张做格式嗅探与压缩，避免超大原图把请求体撑爆。
   * 路径经 resolveAgentFilePath 校验：参考图内容会上传到第三方生图服务商，
   * 必须挡住 ../ 穿越与工作区外的绝对路径，避免本地任意图片被外传。
   */
  private async loadReferenceImages(paths: string[]): Promise<string[]> {
    const cwd = this.deps.getCwd()
    const dataUrls: string[] = []

    for (const p of paths) {
      const trimmed = p?.trim()
      if (!trimmed) continue
      let absPath: string
      try {
        absPath = resolveAgentFilePath(trimmed, cwd)
      } catch (err) {
        throw Object.assign(
          new Error(`参考图路径不合法: ${err instanceof Error ? err.message : String(err)}`),
          { code: 'REFERENCE_IMAGE_PATH_INVALID' },
        )
      }
      if (!fs.existsSync(absPath)) {
        throw Object.assign(new Error(`参考图不存在: ${trimmed}`), {
          code: 'REFERENCE_IMAGE_NOT_FOUND',
        })
      }
      const raw = await fs.promises.readFile(absPath)
      const { buffer, mimeType, wasResized } = await resizeImageIfNeeded(
        raw,
        path.extname(absPath),
      )
      log.info(
        `[loadReferenceImages] 已加载参考图 ${trimmed} (${Math.round(buffer.byteLength / 1024)}KB, ` +
          `mime=${mimeType}, 压缩=${wasResized})`,
      )
      dataUrls.push(`data:${mimeType};base64,${buffer.toString('base64')}`)
    }

    return dataUrls
  }

  /**
   * 根据文字描述生成图片，保存到 workspace/outputs/YYYYMMDD/ 目录。
   *
   * 两条上游路径：
   * - image 槽 type=rightapi：RightAPI 异步任务（提交 → 轮询 → 下载），支持参考图
   * - 其余：直连 OpenAI 兼容上游（RightCodesDraw）
   */
  async generateImage(params: {
    prompt: string
    modelId?: string
    width?: number
    height?: number
    filename?: string
    /** 参考图的 workspace 相对路径（仅 rightapi 支持） */
    referenceImagePaths?: string[]
    signal?: AbortSignal
  }): Promise<{ filePath: string; width: number; height: number; model: string; revisedPrompt: string }> {
    applyImageSlotToDrawEnv()
    const imageSlot = loadSlotConfig('image')
    const useRightApi = imageSlot.enabled && imageSlot.type === 'rightapi'
    const modelId = params.modelId ?? (() => {
      if (imageSlot.enabled && imageSlot.modelId) return imageSlot.modelId
      return 'gpt-image-2'
    })()
    const refPaths = params.referenceImagePaths?.filter((p) => p?.trim()) ?? []
    log.info(
      `[generateImage] 开始: provider=${useRightApi ? 'rightapi' : imageSlot.type} ` +
        `modelId=${modelId} 参考图=${refPaths.length} prompt="${params.prompt.slice(0, 80)}..."`,
    )

    if (params.signal?.aborted) {
      throw Object.assign(new Error('图片生成已被用户中断'), { code: 'ABORTED' })
    }

    if (refPaths.length > 0 && !useRightApi) {
      throw Object.assign(
        new Error(
          '当前生图提供商不支持参考图（图生图）。请在「设置 → 模型配置 → 图片生成」中把 Provider 类型切换为「RightAPI 异步生图」后重试。',
        ),
        { code: 'REFERENCE_IMAGE_UNSUPPORTED' },
      )
    }

    let data: {
      imageBase64: string
      mimeType: 'image/png' | 'image/jpeg' | 'image/webp'
      width: number
      height: number
      revisedPrompt: string
      effectiveModelId: string
    }

    if (useRightApi) {
      data = await generateImageViaRightApi({
        prompt: params.prompt,
        modelId,
        baseUrl: imageSlot.baseUrl?.trim() || DEFAULT_RIGHTAPI_BASE_URL,
        apiKey: imageSlot.apiKey,
        width: params.width ?? 1024,
        height: params.height ?? 1024,
        referenceImageDataUrls:
          refPaths.length > 0 ? await this.loadReferenceImages(refPaths) : undefined,
        signal: params.signal,
      })
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
