/**
 * Wiki 嵌入模型默认环境配置：国内镜像 + 默认启用向量检索与启动预下载。
 */

import { DEFAULT_WIKI_EMBEDDING_MIRROR } from './wiki-embedding-model-downloader'

/** 默认启用 Wiki 向量检索（设为 0 可关闭并跳过模型下载） */
export const DEFAULT_LUMII_WIKI_VECTOR = '1'

/**
 * 写入 Wiki 嵌入相关环境变量默认值（仅当用户未配置时生效）。
 * 应在主进程尽早调用，早于 Agent Runtime 初始化。
 */
export function applyWikiEmbeddingEnvDefaults(): void {
  if (!process.env.HF_ENDPOINT?.trim() && !process.env.LUMII_HF_ENDPOINT?.trim()) {
    process.env.HF_ENDPOINT = DEFAULT_WIKI_EMBEDDING_MIRROR
    process.env.LUMII_HF_ENDPOINT = DEFAULT_WIKI_EMBEDDING_MIRROR
  } else if (!process.env.HF_ENDPOINT?.trim() && process.env.LUMII_HF_ENDPOINT?.trim()) {
    process.env.HF_ENDPOINT = process.env.LUMII_HF_ENDPOINT.trim()
  } else if (process.env.HF_ENDPOINT?.trim() && !process.env.LUMII_HF_ENDPOINT?.trim()) {
    process.env.LUMII_HF_ENDPOINT = process.env.HF_ENDPOINT.trim()
  }

  if (process.env.LUMII_WIKI_VECTOR === undefined || process.env.LUMII_WIKI_VECTOR === '') {
    process.env.LUMII_WIKI_VECTOR = DEFAULT_LUMII_WIKI_VECTOR
  }
}

/**
 * 是否启用 Wiki 向量检索（含启动预下载）。
 */
export function isWikiVectorEnabled(): boolean {
  return process.env.LUMII_WIKI_VECTOR !== '0'
}
