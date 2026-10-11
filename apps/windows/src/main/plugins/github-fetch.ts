/**
 * 从 GitHub Releases 下载资产（exe / zip）。
 *
 * **为什么不用 GitHub API 解析「最新版」**：国内常墙 `api.github.com`。
 * 因此调用方给**确定的 tag**（随 App 版本走：`v<appVersion>`）。
 *
 * **为什么必须先测速**：gh 镜像质量悬殊且会飘（实测 ghfast.top 直接挂、gh.ddlc.top 限流 429、
 * gh-proxy.com 能连但可能极慢）。只按顺序取第一个「能连上」的，会挑到一个 6 KB/s 的镜像，
 * 37MB 要下一小时。这里对所有镜像**并发 Range 探测**、按吞吐选最快的，再按快→慢回退。
 * 镜像前缀可用 `LUMII_GH_MIRROR_PREFIXES` 覆盖（逗号分隔，空串表示直连）。
 */
import { promises as fs } from 'node:fs'
import { downloadToFile, verifySha256 } from './download'
import { extractZip } from './zip'
import type { PluginProgress } from './plugin-manager'

/**
 * gh 镜像前缀：国内加速用；最后一项空串 = 直连 GitHub。
 * 顺序仅作**测速前的**初始列表（真正顺序由 rankMirrors 的实测决定）。
 */
const DEFAULT_MIRROR_PREFIXES = [
  'https://gh-proxy.com/',
  'https://ghfast.top/',
  'https://gh.ddlc.top/',
  '',
]

/** 单次下载的空闲超时：这么久没数据就判挂死、换下一个源 */
const IDLE_TIMEOUT_MS = 20_000
/** 测速探测的字节数（取一小段估吞吐，别把整个文件拉下来） */
const PROBE_BYTES = 512 * 1024
/** 单个镜像的探测超时 */
const PROBE_TIMEOUT_MS = 10_000

function resolveMirrorPrefixes(): string[] {
  const raw = process.env.LUMII_GH_MIRROR_PREFIXES?.trim()
  if (!raw) return [...DEFAULT_MIRROR_PREFIXES]
  return raw.split(',').map((p) => p.trim())
}

/** 带独立超时的 Range 探测（不依赖 AbortSignal.any，避免 lib 版本差异） */
async function probe(prefix: string, rawUrl: string, parent?: AbortSignal): Promise<number> {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS)
  const onParentAbort = () => ac.abort()
  parent?.addEventListener('abort', onParentAbort, { once: true })
  try {
    const t = Date.now()
    const res = await fetch(`${prefix}${rawUrl}`, {
      headers: { Range: `bytes=0-${PROBE_BYTES - 1}` },
      signal: ac.signal,
    })
    if (res.status !== 206 && res.status !== 200) return -1
    const buf = await res.arrayBuffer()
    const secs = Math.max((Date.now() - t) / 1000, 0.001)
    return buf.byteLength / secs
  } catch {
    return -1
  } finally {
    clearTimeout(timer)
    parent?.removeEventListener('abort', onParentAbort)
  }
}

/**
 * 并发测速所有镜像，返回按快→慢排序的前缀列表。
 * 探测全失败时也**不放弃**：退回原顺序再试（可能探测被限流但实际下载可行）。
 */
async function rankMirrors(rawUrl: string, prefixes: string[], signal?: AbortSignal): Promise<string[]> {
  const scored = await Promise.all(prefixes.map(async (p) => ({ p, speed: await probe(p, rawUrl, signal) })))
  const ok = scored.filter((s) => s.speed > 0).sort((a, b) => b.speed - a.speed).map((s) => s.p)
  if (ok.length === 0) return prefixes
  return [...ok, ...prefixes.filter((p) => !ok.includes(p))]
}

/** 逐镜像下载 `repo/tag/asset` 到 `destFile`（测速选源 + 空闲超时回退） */
async function downloadRanked(
  repo: string,
  tag: string,
  asset: string,
  destFile: string,
  onProgress: (p: PluginProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  onProgress({ phase: 'checking' })
  const rawUrl = `https://github.com/${repo}/releases/download/${tag}/${asset}`
  const ordered = await rankMirrors(rawUrl, resolveMirrorPrefixes(), signal)

  let lastErr: unknown
  let ok = false
  for (const prefix of ordered) {
    const mirror = prefix || 'github.com'
    try {
      await downloadToFile(`${prefix}${rawUrl}`, destFile, (p) => onProgress({ ...p, mirror }), signal, {
        idleTimeoutMs: IDLE_TIMEOUT_MS,
      })
      ok = true
      break
    } catch (err) {
      lastErr = err
      if (signal?.aborted) throw err
    }
  }
  if (!ok) throw new Error(`下载失败：${lastErr instanceof Error ? lastErr.message : lastErr}`)
}

/** 安装：把 GitHub Release 资产（exe 等）下载到 `destFile`，可选校验 sha256。 */
export async function installGithubAsset(opts: {
  /** 形如 `lanxiake/lumii` */
  repo: string
  /** 形如 `v0.1.4` */
  tag: string
  /** 资产文件名，如 `wechat-mcp.exe` */
  asset: string
  destFile: string
  sha256?: string
  onProgress: (p: PluginProgress) => void
  signal?: AbortSignal
}): Promise<void> {
  const { repo, tag, asset, destFile, sha256, onProgress, signal } = opts
  await downloadRanked(repo, tag, asset, destFile, onProgress, signal)
  if (sha256) await verifySha256(destFile, sha256)
  onProgress({ phase: 'done' })
}

/** 安装：把 GitHub Release 的 zip 资产下载并解压到 `destDir`（宠物包等）。 */
export async function installGithubZip(opts: {
  repo: string
  tag: string
  /** 资产文件名，如 `pet-demo_cartoon_cat.zip` */
  asset: string
  destDir: string
  onProgress: (p: PluginProgress) => void
  signal?: AbortSignal
}): Promise<void> {
  const { repo, tag, asset, destDir, onProgress, signal } = opts
  await fs.mkdir(destDir, { recursive: true })
  const tmpZip = `${destDir}.zip`
  try {
    await downloadRanked(repo, tag, asset, tmpZip, onProgress, signal)
    onProgress({ phase: 'extracting' })
    await extractZip(tmpZip, destDir)
  } finally {
    await fs.rm(tmpZip, { force: true })
  }
  onProgress({ phase: 'done' })
}
