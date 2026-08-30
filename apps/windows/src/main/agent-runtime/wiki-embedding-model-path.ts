/**
 * Wiki 多语言嵌入模型：路径解析与就绪检测。
 *
 * Transformers.js 约定 localModelPath 下为 `{org}/{model}/` 目录树。
 */

import * as fs from 'node:fs'
import * as path from 'node:path'
import { resolveWindowsClientDataRoot } from '../client-data-root'

/** Transformers.js 模型 ID，与 pipeline 调用一致 */
export const TRANSFORMERS_E5_MODEL_ID = 'Xenova/multilingual-e5-small'

/** 用户数据目录下的模型缓存子路径 */
export const WIKI_EMBEDDING_CACHE_SUBDIR = path.join('models', 'wiki-embeddings')

/** 量化 ONNX 权重（Transformers.js quantized:true） */
export const WIKI_EMBEDDING_QUANTIZED_ONNX = path.join('onnx', 'model_quantized.onnx')

/** 下载完成后写入的标记文件 */
export const WIKI_EMBEDDING_COMPLETE_MARKER = '.lumii-complete'

/**
 * 解析 Wiki 嵌入模型缓存根目录（localModelPath）。
 * 默认 ~/.lumii/models/wiki-embeddings
 */
export function resolveWikiEmbeddingCacheDir(): string {
  return path.join(resolveWindowsClientDataRoot(), WIKI_EMBEDDING_CACHE_SUBDIR)
}

/**
 * 解析单个模型目录（含 config、tokenizer、ONNX）。
 */
export function resolveWikiEmbeddingModelDir(modelsRoot?: string): string {
  const root = modelsRoot ?? resolveWikiEmbeddingCacheDir()
  return path.join(root, TRANSFORMERS_E5_MODEL_ID)
}

/**
 * 检测目录内是否已有完整量化模型。
 */
export async function isWikiEmbeddingModelReady(modelsRoot?: string): Promise<boolean> {
  const modelDir = resolveWikiEmbeddingModelDir(modelsRoot)
  const required = [
    path.join(modelDir, 'config.json'),
    path.join(modelDir, 'tokenizer.json'),
    path.join(modelDir, WIKI_EMBEDDING_QUANTIZED_ONNX),
  ]
  const checks = await Promise.all(
    required.map(async (filePath) => {
      try {
        await fs.promises.access(filePath, fs.constants.R_OK)
        return true
      } catch {
        return false
      }
    }),
  )
  return checks.every(Boolean)
}

/** @deprecated 使用 isWikiEmbeddingModelReady */
export const isBundledWikiEmbeddingModelReady = isWikiEmbeddingModelReady

/** @deprecated 使用 resolveWikiEmbeddingCacheDir */
export function resolveWikiEmbeddingModelsDir(): string {
  return resolveWikiEmbeddingCacheDir()
}

/** @deprecated 使用 resolveWikiEmbeddingModelDir */
export const resolveBundledWikiEmbeddingModelDir = resolveWikiEmbeddingModelDir
