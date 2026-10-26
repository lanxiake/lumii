/**
 * 产物缩略图（renderer 薄封装）
 *
 * 主进程已做磁盘缓存与并发 2；这里只负责渲染侧的重复请求合并与并发闸，
 * 避免一屏几十张卡同时打 IPC。
 */

import type { ArtifactThumbResult } from '../../shared/artifact-thumbs-types'

const MAX_CONCURRENT = 8
/** 主进程自身有 60s 放弃；这里再兜一层，避免 IPC 永不回包时占死渲染侧 8 个槽 */
const REQUEST_TIMEOUT_MS = 65_000
const inflight = new Map<string, Promise<ArtifactThumbResult>>()
let active = 0
const waiters: Array<() => void> = []

async function withSlot<T>(job: () => Promise<T>): Promise<T> {
  while (active >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => waiters.push(resolve))
  }
  active += 1
  try {
    return await job()
  } finally {
    active -= 1
    waiters.shift()?.()
  }
}

/** 超时算「放弃等待」：底层 IPC 可能永远不回，但槽位必须还回去 */
function withTimeout(promise: Promise<ArtifactThumbResult>): Promise<ArtifactThumbResult> {
  return new Promise<ArtifactThumbResult>((resolve) => {
    const timer = setTimeout(() => resolve({ ok: false, error: '缩略图请求超时' }), REQUEST_TIMEOUT_MS)
    promise.then(
      (result) => {
        clearTimeout(timer)
        resolve(result)
      },
      (err) => {
        clearTimeout(timer)
        resolve({ ok: false, error: err instanceof Error ? err.message : '缩略图失败' })
      },
    )
  })
}

/** 同一路径同一版本只发一次 IPC；失败不缓存（下次挂载时可重试，主进程另有 60s 负缓存） */
export function requestArtifactThumb(relPath: string, version?: number): Promise<ArtifactThumbResult> {
  const key = version === undefined ? relPath : `${relPath}|${version}`
  const existing = inflight.get(key)
  if (existing) return existing
  const api = window.electronAPI?.artifact
  if (!api?.thumb) return Promise.resolve({ ok: false, error: '不支持' })
  const job = withSlot(() => withTimeout(api.thumb(relPath))).finally(() => {
    inflight.delete(key)
  })
  inflight.set(key, job)
  return job
}
