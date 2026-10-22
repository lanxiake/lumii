/**
 * 通用 HTTP 下载：`.part` 续传 + 进度上报 + 完整性校验。
 * npm tarball 与 GitHub Releases 资产两条插件源共用。
 */
import { promises as fs } from 'node:fs'
import { createHash } from 'node:crypto'
import path from 'node:path'
import type { PluginProgress } from './plugin-manager'

/**
 * 流式下载到 `dest`（先写 `.part`，支持续传；完成后原子 rename）。
 *
 * 用 `fs.open` + `fh.write` 而非 `createWriteStream`：后者打开不存在的目录会以
 * **异步 'error' 事件**报错，没挂监听器就变成未捕获异常、直接崩主进程（踩过一次）。
 * 这里所有 I/O 都以 Promise 拒绝形式抛出，由 IPC handler 统一捕获成 `{success:false,error}`。
 */
export async function downloadToFile(
  url: string,
  dest: string,
  onProgress: (p: PluginProgress) => void,
  signal?: AbortSignal,
  opts?: { idleTimeoutMs?: number },
): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true })
  const part = `${dest}.part`
  let offset = 0
  try {
    offset = (await fs.stat(part)).size
  } catch {
    /* 无半成品，从头下 */
  }

  const headers: Record<string, string> = {}
  if (offset > 0) headers.Range = `bytes=${offset}-`
  const res = await fetch(url, { headers, signal })
  // 206 = 续传成功；200 = 服务端不支持 Range，从头来（需把已有字节丢掉）
  if (res.status !== 206 && res.status !== 200) throw new Error(`下载失败 HTTP ${res.status}`)
  if (res.status === 200 && offset > 0) offset = 0

  const contentLength = Number(res.headers.get('content-length') ?? 0)
  const total = contentLength > 0 ? offset + contentLength : undefined
  onProgress({ phase: 'downloading', downloadedBytes: offset, totalBytes: total, percent: total ? 0 : undefined })

  const reader = res.body?.getReader()
  if (!reader) throw new Error('响应无 body')
  const fh = await fs.open(part, offset > 0 ? 'a' : 'w')
  let downloaded = offset

  // 空闲超时：超过 idleTimeoutMs 没收到任何数据就判「挂死」，中止当前源（保留 .part 供下次续传），
  // 抛错让上层回退到下一个镜像。没有它时，一个「连上但不再吐数据」的镜像会把下载永久卡住。
  const idleMs = opts?.idleTimeoutMs ?? 0
  let stalled = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const armIdle = () => {
    if (idleMs <= 0) return
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      stalled = true
      reader.cancel().catch(() => {})
    }, idleMs)
  }
  const clearIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = null
  }

  const onAbort = () => {
    reader.cancel().catch(() => {})
  }
  signal?.addEventListener('abort', onAbort, { once: true })
  armIdle()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) {
        armIdle()
        await fh.write(Buffer.from(value))
        downloaded += value.byteLength
        onProgress({
          phase: 'downloading',
          downloadedBytes: downloaded,
          totalBytes: total,
          percent: total ? Math.round((downloaded / total) * 100) : undefined,
        })
      }
    }
  } finally {
    clearIdle()
    signal?.removeEventListener('abort', onAbort)
    await fh.close()
  }
  if (stalled) throw new Error('下载超时（镜像无响应）')
  if (signal?.aborted) throw new Error('已取消')

  await fs.rename(part, dest)
}

/** 校验 integrity（`sha512-<b64>` / `sha1-<b64>`）或裸 shasum（sha1 hex）。不符抛错。 */
export async function verifyIntegrity(file: string, integrity?: string, shasum?: string): Promise<void> {
  if (!integrity && !shasum) return
  const buf = await fs.readFile(file)
  if (integrity) {
    const [algo, b64] = integrity.split('-')
    const actual = createHash(algo).update(buf).digest('base64')
    if (actual !== b64) throw new Error(`校验失败（${algo}）`)
    return
  }
  const actual = createHash('sha1').update(buf).digest('hex')
  if (actual !== shasum) throw new Error('校验失败（sha1）')
}

/** 校验文件的 sha256（十六进制）。不符抛错。 */
export async function verifySha256(file: string, expect: string): Promise<void> {
  const buf = await fs.readFile(file)
  const actual = createHash('sha256').update(buf).digest('hex')
  if (actual.toLowerCase() !== expect.toLowerCase()) throw new Error('sha256 校验失败')
}
