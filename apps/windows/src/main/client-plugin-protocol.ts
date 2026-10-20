import fs from 'node:fs'
import path from 'node:path'

import { protocol } from 'electron'

import { resolveClientStateDir } from './paths'

/**
 * 渲染层插件的文件通道：`lumii-plugin://local/<插件目录>/<文件>`
 *
 * ## 为什么用协议而不是 IPC
 *
 * 插件清单与代码都是**文件**。走 IPC 要为「列清单 / 读文件 / 变更通知」各开一个通道，
 * 每个通道都要登记归属、写 preload 包装、加守卫。用自定义协议后，渲染层只需要
 * `fetch('lumii-plugin://local/list.json')`——没有新通道、没有 preload 改动，
 * 变更检测退化成轮询同一个 URL（与主进程的扩展加载器同一套思路）。
 *
 * ## 目录约定
 *
 * ```
 * ~/.lumii/plugins/<目录>/
 *   ├── client.js      必需，导出/注册插件
 *   └── plugin.json    可选，{ id, name, version }；缺省时 id = 目录名
 * ```
 *
 * 注意：插件与宿主**同上下文执行**（决策 D2），不做沙箱。
 */

export const CLIENT_PLUGIN_SCHEME = 'lumii-plugin'
const HOST = 'local'

export interface ClientPluginDescriptor {
  /** 插件根目录名（URL 用它定位文件；id 可被 plugin.json 覆盖，两者可能不同） */
  dir: string
  id: string
  name: string
  version: string
  /** 相对插件根的入口文件 */
  entry: string
  /** mtime+size，渲染层据此判断是否需要重新加载 */
  revision: string
}

export function resolveClientPluginsDir(): string {
  return path.join(resolveClientStateDir(), 'plugins')
}

/** 扫描客户端插件目录；目录不存在或条目损坏时跳过，不抛错。 */
export function discoverClientPlugins(): ClientPluginDescriptor[] {
  const root = resolveClientPluginsDir()
  let dirs: string[]
  try {
    dirs = fs.readdirSync(root)
  } catch {
    return []
  }

  const found: ClientPluginDescriptor[] = []
  for (const dirName of dirs) {
    const dir = path.join(root, dirName)
    const entryFile = path.join(dir, 'client.js')
    try {
      if (!fs.statSync(dir).isDirectory()) continue
      const stat = fs.statSync(entryFile)
      const meta = readMeta(dir, dirName)
      found.push({
        dir: dirName,
        id: meta.id,
        name: meta.name,
        version: meta.version,
        entry: 'client.js',
        revision: `${Math.floor(stat.mtimeMs)}-${stat.size}`,
      })
    } catch {
      continue
    }
  }
  return found.sort((a, b) => a.id.localeCompare(b.id))
}

function readMeta(dir: string, dirName: string): { id: string; name: string; version: string } {
  const fallback = { id: dirName, name: dirName, version: '0.0.0' }
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'plugin.json'), 'utf8')) as Partial<{
      id: string
      name: string
      version: string
    }>
    return {
      id: typeof raw.id === 'string' && raw.id ? raw.id : fallback.id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : fallback.name,
      version: typeof raw.version === 'string' && raw.version ? raw.version : fallback.version,
    }
  } catch {
    return fallback
  }
}

/**
 * 须在 app ready 后调用。
 *
 * 只提供两类资源：`list.json`（清单）与插件目录内的文件。
 * 路径经过 `path.resolve` + 前缀校验，杜绝 `../` 穿越。
 */
export function registerClientPluginProtocolHandler(): void {
  const root = path.resolve(resolveClientPluginsDir())

  protocol.handle(CLIENT_PLUGIN_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('bad url', { status: 400 })
    }
    if (url.hostname !== HOST) return new Response('not found', { status: 404 })

    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')

    if (rel === 'list.json') {
      return jsonResponse(discoverClientPlugins())
    }

    const target = path.resolve(root, rel)
    // 只允许插件根目录内的文件
    if (target !== root && !target.startsWith(root + path.sep)) {
      return new Response('forbidden', { status: 403 })
    }

    try {
      const body = await fs.promises.readFile(target)
      return new Response(body, {
        status: 200,
        headers: { 'content-type': contentTypeFor(target), 'cache-control': 'no-store' },
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

function jsonResponse(data: unknown): Response {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  })
}

function contentTypeFor(file: string): string {
  if (file.endsWith('.js') || file.endsWith('.mjs')) return 'text/javascript'
  if (file.endsWith('.css')) return 'text/css'
  if (file.endsWith('.json')) return 'application/json'
  if (file.endsWith('.svg')) return 'image/svg+xml'
  return 'application/octet-stream'
}
