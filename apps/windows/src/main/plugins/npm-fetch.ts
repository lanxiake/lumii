/**
 * 从 npm registry 取一个包，抽出里面的单个文件落到目标路径。
 *
 * 为什么走 npm 而不是自建 OSS：插件所需的二进制（ffmpeg 等）本来就是 npm 包，
 * **npmmirror 是国内全量镜像**（CDN 覆盖全国），无需另建托管。
 *
 * 流程：packument（取版本 + integrity）→ 流式下载（`.part` 续传）→ 校验 integrity
 * → 从 tgz 抽 `entry` → 原子落位。多 registry 依次回退，任一可达即用。
 * （下载与校验的实现在 `download.ts`，与 GitHub Releases 源共用。）
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import * as tar from 'tar'
import { downloadToFile, verifyIntegrity } from './download'
import type { PluginProgress } from './plugin-manager'

/** registry 回退链：**国内镜像放首选**（大部分用户在国内） */
const REGISTRIES = ['https://registry.npmmirror.com', 'https://registry.npmjs.org']

type DistInfo = { tarball?: string; integrity?: string; shasum?: string }
type VersionInfo = { dist?: DistInfo }
type Packument = { 'dist-tags'?: Record<string, string>; versions?: Record<string, VersionInfo> }

/** 拉 packument（元数据很小），按 registry 顺序试到第一个可达的，并回报用的是哪个 registry */
async function fetchPackument(
  pkg: string,
  signal?: AbortSignal,
): Promise<{ packument: Packument; base: string }> {
  let lastErr: unknown
  for (const base of REGISTRIES) {
    try {
      const res = await fetch(`${base}/${pkg}`, { signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return { packument: (await res.json()) as Packument, base }
    } catch (err) {
      lastErr = err
    }
  }
  throw new Error(`无法获取包元数据 ${pkg}：${lastErr instanceof Error ? lastErr.message : lastErr}`)
}

/** 从 tgz 抽出 `entry`（归档内路径，如 `package/ffmpeg.exe`）到 `destFile` */
async function extractEntry(tgzPath: string, entry: string, destFile: string): Promise<void> {
  const tmp = `${destFile}.extract`
  await fs.rm(tmp, { recursive: true, force: true })
  await fs.mkdir(tmp, { recursive: true })
  try {
    let found = false
    await tar.x({
      file: tgzPath,
      cwd: tmp,
      filter: (p: string) => {
        const hit = p.replace(/\\/g, '/') === entry
        if (hit) found = true
        return hit
      },
    })
    if (!found) throw new Error(`tgz 内找不到 ${entry}`)
    await fs.copyFile(path.join(tmp, entry), destFile)
  } finally {
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

/**
 * 安装：把 npm 包里指定的单个文件落到 `destFile`。
 * @returns 实际落地的包版本（供记录/展示）
 */
export async function installNpmFile(opts: {
  packageName: string
  version?: string
  /** tgz 归档内路径，如 `package/ffmpeg.exe` */
  entry: string
  destFile: string
  onProgress: (p: PluginProgress) => void
  signal?: AbortSignal
}): Promise<{ version: string }> {
  const { packageName, entry, destFile, onProgress, signal } = opts
  onProgress({ phase: 'checking' })

  const { packument, base: packumentBase } = await fetchPackument(packageName, signal)
  const version = opts.version ?? packument['dist-tags']?.latest
  if (!version) throw new Error(`${packageName} 无可用版本`)
  const dist = packument.versions?.[version]?.dist
  const tarballName = `${path.basename(packageName)}-${version}.tgz`
  // 候选 registry：先用在 packument 上成功的那个，再轮流回退其余
  const bases = [packumentBase, ...REGISTRIES.filter((b) => b !== packumentBase)]

  const tgz = `${destFile}.tgz`
  let lastErr: unknown
  let ok = false
  for (const base of bases) {
    try {
      await downloadToFile(`${base}/${packageName}/-/${tarballName}`, tgz, onProgress, signal)
      ok = true
      break
    } catch (err) {
      lastErr = err
      if (signal?.aborted) throw err
    }
  }
  if (!ok) throw new Error(`下载失败：${lastErr instanceof Error ? lastErr.message : lastErr}`)

  try {
    await verifyIntegrity(tgz, dist?.integrity, dist?.shasum)
    onProgress({ phase: 'extracting' })
    await fs.mkdir(path.dirname(destFile), { recursive: true })
    await extractEntry(tgz, entry, destFile)
  } finally {
    await fs.rm(tgz, { force: true })
  }

  onProgress({ phase: 'done', version })
  return { version }
}
