/**
 * lumii-local 自定义协议：按 path 流式提供本地媒体，避免大文件整包 base64。
 * 须在 app.whenReady 前调用 registerLocalMediaSchemePrivileged。
 */
import fs from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { net, protocol } from 'electron'
import { resolveRecordingsDir, resolveScreenshotTempDir } from './workspace-paths'
import { isAllowedPreviewPath } from './preview-path-acl'

export const LOCAL_MEDIA_SCHEME = 'lumii-local'

let workspaceCwdGetter: (() => string) | null = null

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
 */
export function isAllowedLocalMediaPath(resolvedAbs: string): boolean {
  return isAllowedPreviewPath(path.resolve(resolvedAbs), resolveAclDirs())
}

/**
 * 在 app ready 前注册 privileged scheme（否则 renderer 无法 fetch/播放）。
 */
export function registerLocalMediaSchemePrivileged(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: LOCAL_MEDIA_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        stream: true,
        bypassCSP: true,
        corsEnabled: true,
      },
    },
  ])
}

/**
 * app ready 后注册协议处理器，按 ACL 流式返回本地文件。
 */
export function registerLocalMediaProtocolHandler(): void {
  protocol.handle(LOCAL_MEDIA_SCHEME, (request) => {
    try {
      const u = new URL(request.url)
      const raw = u.searchParams.get('path')
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
      return net.fetch(pathToFileURL(resolved).href)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return new Response(msg, { status: 500 })
    }
  })
}
