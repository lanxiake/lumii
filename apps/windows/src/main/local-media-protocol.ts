/**
 * lumii-local 自定义协议：按 path 流式提供本地媒体，避免大文件整包 base64。
 * 须在 app.whenReady 前调用 registerLocalMediaSchemePrivileged。
 *
 * 必须自己实现 Range/206：把请求原样交给 net.fetch(file://) 会丢掉 Range，
 * 返回整段 200。`<video>` 的续缓冲与 seek 依赖 206 分片，缺失时播几秒就卡住，
 * 且失败分片会被 Chromium 媒体缓存下来，重开仍在原位卡住。
 */
import fs, { createReadStream } from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { resolveRecordingsDir, resolveScreenshotTempDir } from './workspace-paths'
import { isAllowedPreviewPath } from './preview-path-acl'

export const LOCAL_MEDIA_SCHEME = 'lumii-local'

let workspaceCwdGetter: (() => string) | null = null

/** Wiki 原文件可能在工作区外：预览 IPC 校验侧车后登记，供 lumii-local 流式读取 */
const extraAllowedLocalMediaPaths = new Set<string>()

/**
 * 注入 Agent 工作区 cwd 获取器（bridge 就绪后设置），供协议 ACL 使用。
 */
export function setLocalMediaWorkspaceCwdGetter(getter: () => string): void {
  workspaceCwdGetter = getter
}

/**
 * 构造渲染进程可加载的 lumii-local URL。
 */
export function buildLocalMediaUrl(absPath: string): string {
  const resolved = path.resolve(absPath)
  return `${LOCAL_MEDIA_SCHEME}://media/?path=${encodeURIComponent(resolved)}`
}

/**
 * 目录相对写法：`lumii-local://local/E:/ws/outputs/x/preview/page.html`。
 *
 * HTML 产物里的 `images/a.png` 这类相对引用由内核按文档 URL 解析，
 * 只有路径式 URL 才能让它们落到同一目录（`?path=` 的 query 形式解析出来是
 * `lumii-local://media/images/a.png`，必然 404 → 满屏破图）。
 */
export function buildLocalMediaFileUrl(absPath: string): string {
  const posix = path.resolve(absPath).replace(/\\/g, '/')
  return `${LOCAL_MEDIA_SCHEME}://local/${posix}`
}

/** 从路径式 URL 还原磁盘路径；非该形态返回 null */
export function resolveLocalMediaFilePath(requestUrl: string): string | null {
  let u: URL
  try {
    u = new URL(requestUrl)
  } catch {
    return null
  }
  const raw = decodeURIComponent(u.pathname)
  const candidate = raw.replace(/^\/+/, '')
  return /^[A-Za-z]:\//.test(candidate) || candidate.startsWith('//') ? candidate : null
}

/**
 * 所在目录的路径式 URL（带末尾斜杠），给 HTML 预览当 `<base href>`。
 * 有了它，产物里的 `images/a.png`、CSS 的 `url(...)` 都能落到正确目录。
 */
export function buildLocalMediaDirUrl(absDir: string): string {
  const posix = path.resolve(absDir).replace(/\\/g, '/').replace(/\/+$/, '')
  return `${LOCAL_MEDIA_SCHEME}://local/${posix}/`
}

/**
 * 允许 lumii-local 读取工作区外的预览目标（须先由 files 预览 IPC 完成路径校验）。
 */
export function allowLocalMediaPreviewPath(absPath: string): void {
  extraAllowedLocalMediaPaths.add(path.resolve(absPath))
}

/**
 * 解析当前预览 ACL 目录集合。
 */
function resolveAclDirs(): {
  workspaceCwd: string
  recordingsDir: string
  screenshotDir: string
} {
  const workspaceCwd = path.resolve(workspaceCwdGetter?.() ?? process.cwd())
  const recordingsDir = path.resolve(resolveRecordingsDir())
  const screenshotDir = path.resolve(resolveScreenshotTempDir())
  return { workspaceCwd, recordingsDir, screenshotDir }
}

/**
 * 判断路径是否允许经 lumii-local 提供。
 *
 * `extraAllowedLocalMediaPaths` 里既可能登记单文件（预览目标本身），也可能登记
 * 目录（HTML 预览登记所在目录，好让 `images/a.png` 读得到），目录按前缀放行。
 */
function isAllowedLocalMediaPath(resolvedAbs: string): boolean {
  const abs = path.resolve(resolvedAbs)
  if (extraAllowedLocalMediaPaths.has(abs)) return true
  for (const extra of extraAllowedLocalMediaPaths) {
    if (abs.startsWith(extra + path.sep)) return true
  }
  return isAllowedPreviewPath(abs, resolveAclDirs())
}

/**
 * 只需覆盖会直接用 <video>/<audio>/<img> 加载的类型；
 * 其余（office/zip 等）走 fetch 取字节，octet-stream 无影响。
 * 与 agent-runtime-ipc 的 inferPreviewMimeFromFileName 图片/音视频段保持一致。
 */
const MIME_BY_EXT: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.ogv': 'video/ogg',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.3gp': 'video/3gpp',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/opus',
  '.weba': 'audio/webm',
  '.flac': 'audio/flac',
  '.aac': 'audio/aac',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.tiff': 'image/tiff',
  '.tif': 'image/tiff',
  '.avif': 'image/avif',
  '.pdf': 'application/pdf',
}

export function mimeForLocalMedia(filePath: string): string {
  return MIME_BY_EXT[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream'
}

/**
 * 解析单个字节区间。返回 null 表示头非法或区间不可满足（应回 416）。
 * 支持 `bytes=start-end` / `bytes=start-` / `bytes=-suffix`，end 越界按 RFC 收窄到 size-1。
 */
export function parseByteRange(
  header: string,
  size: number,
): { start: number; end: number } | null {
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m) return null
  const [, rawStart, rawEnd] = m
  if (rawStart === '' && rawEnd === '') return null
  let start: number
  let end: number
  if (rawStart === '') {
    // 后缀区间：最后 N 字节
    const suffix = Number(rawEnd)
    if (!Number.isFinite(suffix) || suffix <= 0) return null
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(rawStart)
    end = rawEnd === '' ? size - 1 : Number(rawEnd)
    if (end >= size) end = size - 1
  }
  if (!Number.isFinite(start) || start > end || start >= size) return null
  return { start, end }
}

/**
 * 构造本地文件的 200/206 响应。
 */
function buildLocalFileResponse(
  resolved: string,
  rangeHeader: string | null,
  method: string,
): Response {
  const size = fs.statSync(resolved).size
  const contentType = mimeForLocalMedia(resolved)
  const headers: Record<string, string> = {
    'Content-Type': contentType,
    'Accept-Ranges': 'bytes',
  }
  // 音视频不走内核缓存：旧版本回过整段 200，那份响应被缓存后重开仍在原位卡住
  if (contentType.startsWith('video/') || contentType.startsWith('audio/')) {
    headers['Cache-Control'] = 'no-cache'
  }

  let status = 200
  let start = 0
  let end = size - 1
  if (rangeHeader) {
    const range = parseByteRange(rangeHeader, size)
    if (!range) {
      return new Response(null, {
        status: 416,
        headers: { 'Content-Range': `bytes */${size}`, 'Accept-Ranges': 'bytes' },
      })
    }
    start = range.start
    end = range.end
    status = 206
    headers['Content-Range'] = `bytes ${start}-${end}/${size}`
  }
  headers['Content-Length'] = String(size === 0 ? 0 : end - start + 1)

  if (method === 'HEAD' || size === 0) {
    return new Response(null, { status, headers })
  }
  const nodeStream = createReadStream(resolved, { start, end })
  // 播放中被删/被占用：吞掉 error 事件，否则 Node 会把它抛成未捕获异常带走主进程
  nodeStream.on('error', () => nodeStream.destroy())
  const body = Readable.toWeb(nodeStream) as unknown as ReadableStream<Uint8Array>
  return new Response(body, { status, headers })
}

/**
 * app ready 后注册协议处理器，按 ACL 流式返回本地文件（带 Range）。
 */
export function registerLocalMediaProtocolHandler(): void {
  protocol.handle(LOCAL_MEDIA_SCHEME, (request) => {
    try {
      const raw =
        new URL(request.url).searchParams.get('path') ?? resolveLocalMediaFilePath(request.url)
      if (!raw) {
        return new Response('missing path', { status: 400 })
      }
      const resolved = path.resolve(raw)
      if (!isAllowedLocalMediaPath(resolved)) {
        return new Response('forbidden', { status: 403 })
      }
      if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
        return new Response('not found', { status: 404 })
      }
      return buildLocalFileResponse(resolved, request.headers.get('range'), request.method)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(msg, { status: 500 })
    }
  })
}
