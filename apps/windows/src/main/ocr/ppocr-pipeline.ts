/**
 * PP-OCR mobile 推理封装（utility 进程内调用）。
 * 通过 esearch-ocr + 注入的 ort 运行；主进程禁止 import 本模块的 ort 路径。
 */
import fs from 'node:fs'
import path from 'node:path'
import type { OcrLine, OcrPreferredBackend, OcrRecognizeResult } from './types.js'

export type PpocrPipelineDeps = {
  /** onnxruntime 命名空间（由 worker 私有加载） */
  ort: {
    InferenceSession: {
      create: (
        modelPath: string,
        options?: Record<string, unknown>,
      ) => Promise<unknown>
    }
    env?: { wasm?: { numThreads?: number } }
  }
  /** esearch-ocr.init */
  initOcr: (options: Record<string, unknown>) => Promise<{
    ocr: (input: string | Buffer) => Promise<{
      parragraphs?: Array<{ text: string }>
      // 兼容字段
      paragraphs?: Array<{ text: string }>
      text?: string
      // 行级（若库提供）
      lines?: Array<{ text: string; score?: number; box?: number[] }>
    }>
  }>
  readFile?: typeof fs.readFileSync
  now?: () => number
}

export type PpocrRunOptions = {
  imagePath: string
  modelDir: string
  maxSide?: number
  preferredBackend: OcrPreferredBackend
  forceCpu?: boolean
}

/**
 * 解析 ORT executionProviders：auto 时尝试 DML 再 CPU。
 */
export function resolveExecutionProviders(
  preferredBackend: OcrPreferredBackend,
  forceCpu?: boolean,
): string[] {
  if (forceCpu || preferredBackend === 'cpu') return ['cpu']
  if (preferredBackend === 'dml') return ['DmlExecutionProvider', 'cpu']
  return ['DmlExecutionProvider', 'cpu']
}

/**
 * 将 esearch 结果归一为 OcrRecognizeResult。
 */
export function normalizeOcrOutput(
  raw: {
    parragraphs?: Array<{ text: string }>
    paragraphs?: Array<{ text: string }>
    text?: string
    lines?: Array<{ text: string; score?: number; box?: number[] }>
  },
  backend: 'dml' | 'cpu',
  durationMs: number,
): OcrRecognizeResult {
  const lines: OcrLine[] = (raw.lines ?? []).map((line) => ({
    text: line.text,
    score: typeof line.score === 'number' ? line.score : 1,
    box: (line.box && line.box.length >= 4
      ? [line.box[0], line.box[1], line.box[2], line.box[3]]
      : [0, 0, 0, 0]) as [number, number, number, number],
  }))

  const paragraphText = (raw.paragraphs ?? raw.parragraphs ?? [])
    .map((p) => p.text)
    .filter(Boolean)
    .join('\n')
  const text = (raw.text && raw.text.trim()) || paragraphText || lines.map((l) => l.text).join('\n')
  const confidence =
    lines.length > 0 ? lines.reduce((sum, l) => sum + l.score, 0) / lines.length : text ? 0.8 : 0

  return {
    text,
    lines: lines.length > 0 ? lines : text ? [{ text, score: confidence, box: [0, 0, 0, 0] }] : [],
    confidence,
    backend,
    source: 'local',
    durationMs,
  }
}

/**
 * 创建可复用的 PP-OCR 流水线（缓存 ocr 实例）。
 */
export function createPpocrPipeline(deps: PpocrPipelineDeps) {
  const readFile = deps.readFile ?? fs.readFileSync
  const now = deps.now ?? Date.now
  let cached:
    | {
        key: string
        backend: 'dml' | 'cpu'
        api: Awaited<ReturnType<PpocrPipelineDeps['initOcr']>>
      }
    | null = null

  /**
   * 按模型目录与 backend 初始化（或复用）OCR 引擎。
   */
  async function ensureEngine(modelDir: string, preferredBackend: OcrPreferredBackend, forceCpu?: boolean) {
    const providers = resolveExecutionProviders(preferredBackend, forceCpu)
    const backend: 'dml' | 'cpu' = providers[0]?.toLowerCase().includes('dml') ? 'dml' : 'cpu'
    const key = `${modelDir}::${backend}`
    if (cached?.key === key) return cached

    const detPath = path.join(modelDir, 'det.onnx')
    const recPath = path.join(modelDir, 'rec.onnx')
    const dicPath = path.join(modelDir, 'ppocr_keys_v1.txt')
    for (const p of [detPath, recPath, dicPath]) {
      if (!fs.existsSync(p)) throw new Error(`缺少 OCR 模型文件: ${p}`)
    }
    const decodeDic = readFile(dicPath, 'utf-8')

    try {
      const api = await deps.initOcr({
        det: { input: detPath },
        rec: { input: recPath, decodeDic },
        ort: deps.ort,
        // 部分版本使用扁平字段
        detPath,
        recPath,
        dic: decodeDic,
        onnxOptions: {
          executionProviders: providers,
          enableCpuMemArena: false,
        },
      })
      cached = { key, backend, api }
      return cached
    } catch (error) {
      if (backend === 'cpu') throw error
      // DML 失败回退 CPU
      const api = await deps.initOcr({
        det: { input: detPath },
        rec: { input: recPath, decodeDic },
        ort: deps.ort,
        detPath,
        recPath,
        dic: decodeDic,
        onnxOptions: {
          executionProviders: ['cpu'],
          enableCpuMemArena: false,
        },
      })
      cached = { key: `${modelDir}::cpu`, backend: 'cpu', api }
      return cached
    }
  }

  /**
   * 对单张图片跑 OCR。
   */
  async function run(options: PpocrRunOptions): Promise<OcrRecognizeResult> {
    const started = now()
    if (!fs.existsSync(options.imagePath)) {
      throw new Error(`图片不存在: ${options.imagePath}`)
    }
    const engine = await ensureEngine(options.modelDir, options.preferredBackend, options.forceCpu)
    const raw = await engine.api.ocr(options.imagePath)
    return normalizeOcrOutput(raw, engine.backend, Math.max(0, now() - started))
  }

  /**
   * 释放缓存实例引用（进程退出前可选调用）。
   */
  function dispose(): void {
    cached = null
  }

  return { run, dispose, resolveExecutionProviders }
}

export type PpocrPipeline = ReturnType<typeof createPpocrPipeline>
