/**
 * CloakBrowser 下载器
 *
 * 从 GitHub Releases 下载反检测 Chromium 二进制到 ~/.cloakbrowser/。
 * 支持国内镜像加速，依次尝试多个源，第一个成功的就用。
 * 已存在对应版本则跳过下载，直接返回。
 */

import fs from 'node:fs'
import https from 'node:https'
import http from 'node:http'
import path from 'node:path'
import os from 'node:os'
import { Transform } from 'node:stream'

const log = {
  info: (...args: unknown[]) => console.log('[CloakBrowser]', ...args),
  error: (...args: unknown[]) => console.error('[CloakBrowser]', ...args),
  warn: (...args: unknown[]) => console.warn('[CloakBrowser]', ...args),
}

const CLOAK_DIR = path.join(os.homedir(), '.cloakbrowser')

// GitHub Releases API（ghfast.top 不代理 api.github.com，会返回 "Invalid input."，故只用直连）
const RELEASES_API_URLS = [
  'https://api.github.com/repos/CloakHQ/CloakBrowser/releases/latest',
]

// 下载镜像前缀列表（候选池，下载前会并发测速选最快的源；测速失败时按此顺序兜底）
const DOWNLOAD_MIRROR_PREFIXES = [
  'https://gh.ddlc.top/',  // 国内镜像（实测较快）
  'https://gh-proxy.com/', // 国内镜像
  '',                      // 直连 GitHub
  'https://ghfast.top/',   // 国内镜像（兜底，大文件较慢）
]

// 测速参数：每个源各拉取一小段，按耗时排序选最快
const SPEED_TEST_RANGE_BYTES = 2 * 1024 * 1024 // 探测下载 2MB
const SPEED_TEST_TIMEOUT_MS = 8000

// 硬编码已知稳定版本，API 不通（国内常墙 api.github.com）时作为兜底。
// 注意：必须是完整 release tag（含 chromium- 前缀），否则下载 URL 404。
// 升级方式：查 https://github.com/CloakHQ/CloakBrowser/releases/latest 的 tag_name 更新。
const FALLBACK_VERSION = process.env.CLOAK_FALLBACK_VERSION ?? 'chromium-v146.0.7680.177.5'

// 数据流静默超时：超过此时间没收到任何数据则中断
const DATA_IDLE_TIMEOUT_MS = 30_000

export type DownloadProgress = {
  phase: 'checking' | 'downloading' | 'extracting' | 'done' | 'skipped' | 'error' | 'cancelled'
  percent?: number
  downloadedBytes?: number
  totalBytes?: number
  version?: string
  error?: string
  mirror?: string
}

export type ProgressCallback = (progress: DownloadProgress) => void

type GitHubAsset = {
  name: string
  browser_download_url: string
  size: number
}

type GitHubRelease = {
  tag_name: string
  assets: GitHubAsset[]
}

// ============================================================================
// AbortController（Node 14+ 内置，兼容写法）
// ============================================================================

export class DownloadAbortError extends Error {
  constructor() {
    super('下载已取消')
    this.name = 'DownloadAbortError'
  }
}

// ============================================================================
// HTTP 工具
// ============================================================================

function getClient(url: string) {
  return url.startsWith('https://') ? https : http
}

function resolveLocation(location: string | undefined, base: string): string | null {
  if (!location) return null
  try {
    return new URL(location, base).toString()
  } catch {
    return null
  }
}

function httpsGetRaw(
  url: string,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ data: Buffer; statusCode: number; location?: string }> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new DownloadAbortError()); return }

    const client = getClient(url)
    const req = client.get(url, { headers: { 'User-Agent': 'mtbot-client' } }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        resolve({ data: Buffer.alloc(0), statusCode: res.statusCode, location: res.headers.location })
        return
      }
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => resolve({ data: Buffer.concat(chunks), statusCode: res.statusCode ?? 200 }))
      res.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`请求超时: ${url}`)))

    signal?.addEventListener('abort', () => {
      req.destroy(new DownloadAbortError())
      reject(new DownloadAbortError())
    }, { once: true })
  })
}

async function fetchWithRedirects(url: string, timeoutMs = 10000, signal?: AbortSignal): Promise<Buffer> {
  let current = url
  for (let i = 0; i < 5; i++) {
    const result = await httpsGetRaw(current, timeoutMs, signal)
    if (result.statusCode === 301 || result.statusCode === 302) {
      const next = resolveLocation(result.location, current)
      if (!next) throw new Error(`重定向无有效 Location: ${current}`)
      current = next
      continue
    }
    if (result.statusCode < 200 || result.statusCode >= 300) {
      throw new Error(`HTTP ${result.statusCode}: ${current}`)
    }
    return result.data
  }
  throw new Error(`重定向次数超限: ${url}`)
}

// ============================================================================
// 版本获取（多源依次尝试）
// ============================================================================

async function tryFetchRelease(apiUrl: string, signal?: AbortSignal): Promise<GitHubRelease> {
  const data = await fetchWithRedirects(apiUrl, 8000, signal)
  const parsed = JSON.parse(data.toString('utf8')) as GitHubRelease
  if (!parsed.tag_name) throw new Error('响应缺少 tag_name')
  return parsed
}

async function fetchLatestRelease(signal?: AbortSignal): Promise<GitHubRelease> {
  const errors: string[] = []
  for (const url of RELEASES_API_URLS) {
    if (signal?.aborted) throw new DownloadAbortError()
    try {
      const release = await tryFetchRelease(url, signal)
      log.info(`[fetchLatestRelease] 成功: ${url}，版本: ${release.tag_name}`)
      return release
    } catch (err) {
      if (err instanceof DownloadAbortError) throw err
      const msg = String(err instanceof Error ? err.message : err)
      log.warn(`[fetchLatestRelease] 失败 ${url}: ${msg}`)
      errors.push(msg)
    }
  }
  log.warn(`[fetchLatestRelease] 所有 API 不可达，使用兜底版本 ${FALLBACK_VERSION}`)
  return buildFallbackRelease(FALLBACK_VERSION)
}

function buildFallbackRelease(version: string): GitHubRelease {
  const { os, arch, ext } = getPlatformAssetPattern()
  const assetName = `cloakbrowser-${os}-${arch}${ext}`
  const baseUrl = `https://github.com/CloakHQ/CloakBrowser/releases/download/${version}/${assetName}`
  return {
    tag_name: version,
    assets: [{ name: assetName, browser_download_url: baseUrl, size: 0 }],
  }
}

// ============================================================================
// 平台工具
// ============================================================================

function getPlatformAssetPattern(): { os: string; arch: string; ext: string } {
  if (process.platform === 'win32') {
    return { os: 'windows', arch: 'x64', ext: '.zip' }
  }
  if (process.platform === 'darwin') {
    return { os: 'mac', arch: process.arch === 'arm64' ? 'arm64' : 'x64', ext: '.tar.gz' }
  }
  if (process.arch === 'arm64') {
    throw new Error('Linux ARM64 暂不支持 CloakBrowser 自动下载')
  }
  return { os: 'linux', arch: 'x64', ext: '.tar.gz' }
}

function findAssetForPlatform(assets: GitHubAsset[]): GitHubAsset | null {
  const { os, arch, ext } = getPlatformAssetPattern()
  return (
    assets.find((a) => a.name.includes(os) && a.name.includes(arch) && a.name.endsWith(ext)) ?? null
  )
}

/** 目录名统一为 chromium-<纯版本>，去掉 tag_name 自带的 chromium- 前缀避免双重前缀 */
export function versionDirPath(version: string): string {
  const bare = version.replace(/^chromium-/, '')
  return path.join(CLOAK_DIR, `chromium-${bare}`)
}

export function exeFilename(): string {
  return process.platform === 'win32' ? 'chrome.exe' : 'chrome'
}

export function exePath(version: string): string {
  return path.join(versionDirPath(version), exeFilename())
}

function isAlreadyInstalled(version: string): boolean {
  return fs.existsSync(exePath(version))
}

/** 校验文件是否为合法 zip（文件头 PK\x03\x04） */
function isValidZip(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r')
    try {
      const buf = Buffer.alloc(4)
      const read = fs.readSync(fd, buf, 0, 4, 0)
      if (read < 4) return false
      // 本地文件头 50 4B 03 04；空归档 50 4B 05 06
      return buf[0] === 0x50 && buf[1] === 0x4b && (buf[2] === 0x03 || buf[2] === 0x05)
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return false
  }
}

/** 清理 CLOAK_DIR 下所有 .part 半成品文件 */
function cleanupPartFiles(): void {
  try {
    for (const name of fs.readdirSync(CLOAK_DIR)) {
      if (name.endsWith('.part')) {
        try { fs.rmSync(path.join(CLOAK_DIR, name), { force: true }) } catch { /* ignore */ }
      }
    }
  } catch { /* ignore */ }
}

// ============================================================================
// 下载（多镜像顺序尝试，支持取消和数据流超时）
// ============================================================================

function applyMirrorPrefix(originalUrl: string, prefix: string): string {
  if (!prefix) return originalUrl
  return `${prefix}${originalUrl}`
}

function mirrorLabelOf(prefix: string): string {
  if (!prefix) return 'github.com（直连）'
  try {
    return `${new URL(prefix).hostname}（镜像）`
  } catch {
    return `${prefix}（镜像）`
  }
}

/**
 * 对单个源做 Range 测速：拉取前 SPEED_TEST_RANGE_BYTES 字节，返回 B/s（失败返回 null）。
 */
function probeMirrorSpeed(url: string, signal?: AbortSignal): Promise<number | null> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(null); return }

    let settled = false
    const finish = (v: number | null) => { if (!settled) { settled = true; resolve(v) } }

    const start = Date.now()
    let received = 0

    const doRequest = (requestUrl: string, redirects = 0): void => {
      if (redirects > 5) { finish(null); return }
      const client = getClient(requestUrl)
      const req = client.get(
        requestUrl,
        { headers: { 'User-Agent': 'mtbot-client', Range: `bytes=0-${SPEED_TEST_RANGE_BYTES - 1}` } },
        (res) => {
          if (res.statusCode === 301 || res.statusCode === 302) {
            const next = resolveLocation(res.headers.location, requestUrl)
            res.resume()
            if (!next) { finish(null); return }
            doRequest(next, redirects + 1)
            return
          }
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            res.resume()
            finish(null)
            return
          }
          res.on('data', (chunk: Buffer) => {
            received += chunk.length
            if (received >= SPEED_TEST_RANGE_BYTES) {
              req.destroy()
              const elapsed = (Date.now() - start) / 1000
              finish(elapsed > 0 ? received / elapsed : null)
            }
          })
          res.on('end', () => {
            const elapsed = (Date.now() - start) / 1000
            finish(received > 0 && elapsed > 0 ? received / elapsed : null)
          })
          res.on('error', () => finish(null))
        },
      )
      req.on('error', () => finish(null))
      req.setTimeout(SPEED_TEST_TIMEOUT_MS, () => { req.destroy(); finish(received > 0 ? received / ((Date.now() - start) / 1000) : null) })
      signal?.addEventListener('abort', () => { req.destroy(); finish(null) }, { once: true })
    }
    doRequest(url)
  })
}

/**
 * 并发测速所有镜像，返回按速度降序排列的 prefix 列表（测速全失败时回退到原始顺序）。
 */
async function rankMirrorsBySpeed(originalUrl: string, signal?: AbortSignal): Promise<string[]> {
  log.info('[rankMirrors] 开始并发测速所有下载源...')
  const results = await Promise.all(
    DOWNLOAD_MIRROR_PREFIXES.map(async (prefix) => {
      const speed = await probeMirrorSpeed(applyMirrorPrefix(originalUrl, prefix), signal)
      const mbps = speed != null ? (speed / 1024 / 1024).toFixed(2) : 'N/A'
      log.info(`[rankMirrors] ${mirrorLabelOf(prefix)}: ${speed != null ? `${mbps} MB/s` : '失败/超时'}`)
      return { prefix, speed }
    }),
  )

  const ranked = results
    .filter((r) => r.speed != null)
    .sort((a, b) => (b.speed as number) - (a.speed as number))
    .map((r) => r.prefix)

  if (ranked.length === 0) {
    log.warn('[rankMirrors] 所有源测速失败，回退到默认顺序')
    return [...DOWNLOAD_MIRROR_PREFIXES]
  }

  // 把测速成功的源排前面，再追加测速失败的源作为兜底（去重）
  const failed = DOWNLOAD_MIRROR_PREFIXES.filter((p) => !ranked.includes(p))
  const order = [...ranked, ...failed]
  log.info(`[rankMirrors] 最终下载顺序: ${order.map(mirrorLabelOf).join(' > ')}`)
  return order
}

async function downloadWithProgress(
  originalUrl: string,
  destPath: string,
  totalBytes: number,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<void> {
  const errors: string[] = []

  // 下载前并发测速，按速度排序选源
  const mirrorOrder = await rankMirrorsBySpeed(originalUrl, signal)
  if (signal?.aborted) throw new DownloadAbortError()

  const partPath = `${destPath}.part`

  for (const prefix of mirrorOrder) {
    if (signal?.aborted) { try { fs.rmSync(partPath, { force: true }) } catch { /* ignore */ } ; throw new DownloadAbortError() }
    const url = applyMirrorPrefix(originalUrl, prefix)
    const mirrorLabel = mirrorLabelOf(prefix)
    log.info(`[download] 尝试镜像: ${mirrorLabel}`)

    // 每次切换镜像前清理上一次的半成品 .part，避免污染
    try { fs.rmSync(partPath, { force: true }) } catch { /* ignore */ }

    try {
      // 下载到临时 .part 文件，校验通过后才 rename 为最终 zip
      await downloadFromUrl(url, partPath, totalBytes, (p) =>
        onProgress({ ...p, mirror: mirrorLabel }),
        signal,
      )

      // 校验 zip 头：镜像可能返回错误页面（小文件，进度仍 100%）
      if (!isValidZip(partPath)) {
        try { fs.rmSync(partPath, { force: true }) } catch { /* ignore */ }
        throw new Error('下载内容不是有效的 zip（可能是镜像返回了错误页面）')
      }

      // 校验通过：原子替换最终 zip
      try { fs.rmSync(destPath, { force: true }) } catch { /* ignore */ }
      fs.renameSync(partPath, destPath)
      log.info(`[download] 下载成功: ${mirrorLabel}`)
      return
    } catch (err) {
      if (err instanceof DownloadAbortError) {
        try { fs.rmSync(partPath, { force: true }) } catch { /* ignore */ }
        throw err
      }
      const msg = String(err instanceof Error ? err.message : err)
      log.warn(`[download] 镜像失败 ${mirrorLabel}: ${msg}`)
      errors.push(`${mirrorLabel}: ${msg}`)
      try { fs.rmSync(partPath, { force: true }) } catch { /* ignore */ }
    }
  }

  throw new Error(`所有下载源均失败:\n${errors.join('\n')}`)
}

function downloadFromUrl(
  url: string,
  destPath: string,
  totalBytes: number,
  onProgress: ProgressCallback,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) { reject(new DownloadAbortError()); return }

    const doRequest = (requestUrl: string, redirects = 0): void => {
      if (redirects > 5) { reject(new Error('重定向次数超限')); return }
      if (signal?.aborted) { reject(new DownloadAbortError()); return }

      const client = getClient(requestUrl)
      const req = client.get(requestUrl, { headers: { 'User-Agent': 'mtbot-client' } }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          const next = resolveLocation(res.headers.location, requestUrl)
          if (!next) { reject(new Error(`重定向无有效 Location: ${requestUrl}`)); return }
          doRequest(next, redirects + 1)
          return
        }
        if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`HTTP ${res.statusCode}: ${requestUrl}`))
          return
        }

        const actualTotal = totalBytes || Number(res.headers['content-length'] ?? 0)
        let downloaded = 0
        const fileStream = fs.createWriteStream(destPath)

        // 数据流静默超时：超过 DATA_IDLE_TIMEOUT_MS 没有新数据则中断
        let idleTimer: ReturnType<typeof setTimeout> | null = null
        const resetIdleTimer = () => {
          if (idleTimer) clearTimeout(idleTimer)
          idleTimer = setTimeout(() => {
            req.destroy(new Error(`数据流超时（${DATA_IDLE_TIMEOUT_MS / 1000}s 无数据）`))
          }, DATA_IDLE_TIMEOUT_MS)
        }
        resetIdleTimer()

        const cleanup = () => {
          if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
        }

        const progress = new Transform({
          transform(chunk: Buffer, _enc, cb) {
            resetIdleTimer()
            downloaded += chunk.length
            onProgress({
              phase: 'downloading',
              downloadedBytes: downloaded,
              totalBytes: actualTotal,
              percent: actualTotal > 0 ? Math.round((downloaded / actualTotal) * 100) : undefined,
            })
            cb(null, chunk)
          },
        })

        res.pipe(progress).pipe(fileStream)

        const removePartial = () => {
          try { fs.rmSync(destPath, { force: true }) } catch { /* ignore */ }
        }

        fileStream.on('finish', () => { cleanup(); resolve() })
        fileStream.on('error', (err) => { cleanup(); removePartial(); reject(err) })
        res.on('error', (err) => { cleanup(); removePartial(); reject(err) })
        progress.on('error', (err) => { cleanup(); removePartial(); reject(err) })

        // 取消信号处理：销毁流并删除半成品文件
        signal?.addEventListener('abort', () => {
          cleanup()
          req.destroy(new DownloadAbortError())
          fileStream.destroy()
          removePartial()
          reject(new DownloadAbortError())
        }, { once: true })
      })

      req.on('error', reject)
      // 连接建立超时（不是数据超时）
      req.setTimeout(15_000, () => req.destroy(new Error(`连接超时: ${requestUrl}`)))

      signal?.addEventListener('abort', () => {
        req.destroy(new DownloadAbortError())
        reject(new DownloadAbortError())
      }, { once: true })
    }
    doRequest(url)
  })
}

// ============================================================================
// 解压
// ============================================================================

async function extractZip(zipPath: string, destDir: string): Promise<void> {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)

  fs.mkdirSync(destDir, { recursive: true })

  if (process.platform === 'win32') {
    await execFileAsync(
      'powershell',
      ['-NoProfile', '-Command', 'Expand-Archive -LiteralPath $env:CLOAK_ZIP -DestinationPath $env:CLOAK_DEST -Force'],
      { env: { ...process.env, CLOAK_ZIP: zipPath, CLOAK_DEST: destDir } },
    )
  } else if (zipPath.endsWith('.tar.gz')) {
    await execFileAsync('tar', ['-xzf', zipPath, '-C', destDir])
  } else {
    await execFileAsync('unzip', ['-o', zipPath, '-d', destDir])
  }
}

function findExeInDir(dir: string, exeName: string): string | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === exeName.toLowerCase()) return fullPath
    if (entry.isDirectory()) {
      const found = findExeInDir(fullPath, exeName)
      if (found) return found
    }
  }
  return null
}

// ============================================================================
// 公开 API
// ============================================================================

/**
 * 确保 CloakBrowser 已安装。支持通过 AbortSignal 取消。
 */
export async function ensureCloakBrowser(
  onProgress?: ProgressCallback,
  signal?: AbortSignal,
): Promise<string | null> {
  const report = (p: DownloadProgress) => {
    const pct = p.percent != null ? ` ${p.percent}%` : ''
    const mirror = p.mirror ? ` [${p.mirror}]` : ''
    log.info(`[ensureCloakBrowser] phase=${p.phase}${pct}${mirror}`)
    onProgress?.(p)
  }

  try {
    if (signal?.aborted) throw new DownloadAbortError()
    report({ phase: 'checking' })

    const release = await fetchLatestRelease(signal)
    const version = release.tag_name

    if (isAlreadyInstalled(version)) {
      report({ phase: 'skipped', version })
      return exePath(version)
    }

    const asset = findAssetForPlatform(release.assets)
    if (!asset) {
      const { os, arch } = getPlatformAssetPattern()
      const msg = `未找到平台 ${os}-${arch} 的发布包`
      log.warn(`[ensureCloakBrowser] ${msg}`)
      report({ phase: 'error', error: msg })
      return null
    }

    fs.mkdirSync(CLOAK_DIR, { recursive: true })

    const zipPath = path.join(CLOAK_DIR, asset.name)
    const destDir = versionDirPath(version)

    // 复用已下载的合法包：大小匹配（或 size 未知但 > 1MB）且 zip 头有效则跳过下载
    let reuseZip = false
    if (fs.existsSync(zipPath) && isValidZip(zipPath)) {
      const localSize = fs.statSync(zipPath).size
      const sizeOk = asset.size > 0 ? localSize === asset.size : localSize > 1024 * 1024
      if (sizeOk) {
        reuseZip = true
        log.info(`[ensureCloakBrowser] 复用已下载包 ${zipPath}（${Math.round(localSize / 1024 / 1024)} MB），跳过下载`)
      } else {
        log.warn(`[ensureCloakBrowser] 本地包大小不符（${localSize} vs ${asset.size}），重新下载`)
        fs.rmSync(zipPath, { force: true })
      }
    } else if (fs.existsSync(zipPath)) {
      log.warn('[ensureCloakBrowser] 本地包非法 zip，删除后重新下载')
      fs.rmSync(zipPath, { force: true })
    }

    if (!reuseZip) {
      const sizeMb = asset.size > 0 ? `${Math.round(asset.size / 1024 / 1024)} MB` : '未知大小'
      log.info(`[ensureCloakBrowser] 开始下载 ${asset.name}（${sizeMb}）`)
      await downloadWithProgress(asset.browser_download_url, zipPath, asset.size, report, signal)

      // 下载后校验 zip 头，防止镜像返回错误页面（小文件，进度仍 100%）
      if (!isValidZip(zipPath)) {
        fs.rmSync(zipPath, { force: true })
        throw new Error('下载内容不是有效的 zip（可能是镜像返回了错误页面），请重试或更换网络环境')
      }
    }

    // 解压/安装：失败时清理半成品目录与坏 zip，并明确上抛错误
    try {
      report({ phase: 'extracting', version })
      // 清理可能残留的半成品目录，确保解压干净
      fs.rmSync(destDir, { recursive: true, force: true })
      await extractZip(zipPath, destDir)

      const exe = exeFilename()
      const foundExe = findExeInDir(destDir, exe)
      if (!foundExe) {
        throw new Error(`解压后未找到 ${exe}，请检查 ${destDir} 目录结构`)
      }

      const expectedPath = exePath(version)
      if (foundExe !== expectedPath) {
        fs.mkdirSync(path.dirname(expectedPath), { recursive: true })
        fs.renameSync(foundExe, expectedPath)
      }

      if (process.platform !== 'win32') {
        fs.chmodSync(expectedPath, 0o755)
      }

      report({ phase: 'done', version })
      log.info(`[ensureCloakBrowser] 安装完成: ${expectedPath}（zip 保留以便复用）`)
      return expectedPath
    } catch (installErr) {
      if (installErr instanceof DownloadAbortError) throw installErr
      // 自愈：清理半成品目录与坏 zip，下次点击安装可重新下载
      log.warn('[ensureCloakBrowser] 解压/安装失败，清理半成品目录与坏 zip')
      try { fs.rmSync(destDir, { recursive: true, force: true }) } catch { /* ignore */ }
      try { if (!isValidZip(zipPath)) fs.rmSync(zipPath, { force: true }) } catch { /* ignore */ }
      throw installErr
    }
  } catch (err) {
    if (err instanceof DownloadAbortError) {
      log.info('[ensureCloakBrowser] 已取消')
      cleanupPartFiles()
      report({ phase: 'cancelled' })
      return null
    }
    const msg = String(err instanceof Error ? err.message : err)
    log.error(`[ensureCloakBrowser] 失败: ${msg}`)
    report({ phase: 'error', error: msg })
    return null
  }
}
