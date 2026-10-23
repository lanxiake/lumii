import fs from 'node:fs'
import path from 'node:path'

import { app, protocol } from 'electron'

import {
  defaultClientPluginRoots,
  discoverClientPlugins,
  type ClientPluginRoot,
} from './client-plugin-discovery'

/**
 * 渲染层插件的文件通道：`lumii-plugin://local/<根>/<插件目录>/<文件>`
 *
 * `<根>` 是 `plugins`（`~/.lumii/plugins`，只有渲染层半边）或
 * `extensions`（`~/.lumii/extensions`，主进程半边 + 可选的 `client.js`）。
 * 旧 URL `lumii-plugin://local/<目录>/<文件>` 仍按 `plugins` 根解析。
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
 * ~/.lumii/plugins/<目录>/        或  ~/.lumii/extensions/<目录>/
 *   ├── client.js      渲染层入口（必需，才会计入清单）
 *   └── plugin.json    可选，{ id, name, version }；缺省时 id = 目录名
 * ```
 *
 * 注意：插件与宿主**同上下文执行**（决策 D2），不做沙箱。
 */

export const CLIENT_PLUGIN_SCHEME = 'lumii-plugin'
const HOST = 'local'
const ROOTS: readonly ClientPluginRoot[] = ['plugins', 'extensions']

function isRoot(value: string): value is ClientPluginRoot {
  return (ROOTS as readonly string[]).includes(value)
}

/**
 * 须在 app ready 后调用。
 *
 * 只提供两类资源：`list.json`（清单）与插件目录内的文件。
 * 路径经过 `path.resolve` + 前缀校验，杜绝 `../` 穿越。
 */
export function registerClientPluginProtocolHandler(): void {
  const roots = new Map<string, string>(
    defaultClientPluginRoots().map(({ kind, dir }) => [kind, path.resolve(dir)]),
  )

  protocol.handle(CLIENT_PLUGIN_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return new Response('bad url', { status: 400 })
    }
    if (url.hostname !== HOST) return new Response('not found', { status: 404 })

    let rel = decodeURIComponent(url.pathname).replace(/^\/+/, '')

    if (rel === 'list.json') {
      return jsonResponse(
        discoverClientPlugins({ appVersion: app.getVersion(), roots: defaultClientPluginRoots() }),
      )
    }

    // `<根>/<rel>`；旧 URL 没有根段，默认 plugins
    const slash = rel.indexOf('/')
    const maybeRoot = slash > 0 ? rel.slice(0, slash) : rel
    const kind: ClientPluginRoot = isRoot(maybeRoot) ? maybeRoot : 'plugins'
    if (isRoot(maybeRoot)) rel = rel.slice(slash + 1)

    const root = roots.get(kind)
    if (!root) return new Response('not found', { status: 404 })

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
