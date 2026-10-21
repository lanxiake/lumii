import { readFileSync } from 'node:fs'
import path from 'node:path'

import { validateManifest } from '@mtbot/plugin-core'

/**
 * 客户端插件（`~/.lumii/plugins/<dir>/plugin.json`）的清单解析与校验。
 *
 * 刻意不放在 `client-plugin-protocol.ts`：那个模块 import 了 electron
 * （`app` / `protocol`），而静态体检与单测只需要读文件，不该被 electron 拖下水。
 *
 * 校验复用主进程扩展的 `validateManifest`（结构 + engines），只把客户端不要求的
 * 字段补上默认值：`engines` 缺省 `*`、`kind` 固定 code、入口固定 client.js。
 * 这样两端只有一套清单校验，不会出现「主进程管、客户端不管」。
 */

export interface ClientPluginMeta {
  id: string
  name: string
  version: string
  description?: string
  author?: string
  /** 来源：Agent 自举开发 / 用户手写（只是标记，不是权限） */
  origin: 'agent' | 'user'
  /** 清单可解析、engines 满足当前客户端 */
  compatible: boolean
  /** 清单本身有问题（JSON 坏了 / 字段非法） */
  manifestError?: string
  /** engines.lumii 不满足当前客户端版本 */
  incompatibleReason?: string
}

export interface ParseClientPluginMetaOptions {
  /** 宿主版本；给了才校验 engines.lumii */
  appVersion?: string
}

/**
 * 解析一个客户端插件的 `plugin.json`。
 *
 * 失败**不抛给扫描循环**：插件仍然要出现在列表里，并如实说明为什么没加载。
 */
export function parseClientPluginMeta(
  dir: string,
  dirName: string,
  options: ParseClientPluginMetaOptions = {},
): ClientPluginMeta {
  const fallback: ClientPluginMeta = {
    id: dirName,
    name: dirName,
    version: '0.0.0',
    origin: 'user',
    compatible: true,
  }

  const file = path.join(dir, 'plugin.json')
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return fallback
    return {
      ...fallback,
      compatible: false,
      manifestError: `读取 plugin.json 失败：${(err as Error).message}`,
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch (err) {
    return {
      ...fallback,
      compatible: false,
      manifestError: `plugin.json 不是合法 JSON：${(err as Error).message}`,
    }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...fallback, compatible: false, manifestError: 'plugin.json 必须是对象' }
  }

  const r = raw as Record<string, unknown>
  const id = typeof r.id === 'string' && r.id ? r.id : dirName
  const name = typeof r.name === 'string' && r.name ? r.name : id
  const version = typeof r.version === 'string' && r.version ? r.version : '0.0.0'
  const description = typeof r.description === 'string' && r.description ? r.description : undefined
  const author = typeof r.author === 'string' && r.author ? r.author : undefined
  const origin = r.origin === 'agent' ? 'agent' : 'user'

  const base: ClientPluginMeta = {
    id,
    name,
    version,
    origin,
    compatible: true,
    ...(description ? { description } : {}),
    ...(author ? { author } : {}),
  }

  if (r.origin !== undefined && r.origin !== 'agent' && r.origin !== 'user') {
    return { ...base, compatible: false, manifestError: 'origin 只能是 "agent" 或 "user"' }
  }

  /**
   * 客户端插件的 id 规则比主进程扩展**宽松**：历史上允许直接用目录名（如 `today-overview`、
   * `myplugin`），强制反向域名会让已有插件在升级后突然不加载。这里只拦真正的坏 id
   * （空、路径分隔符、大写/空格），其余交给共享的 validateManifest 校验结构与 engines。
   * 共享 schema 的 id 收紧规则用一个合法占位 id 绕过，校验完仍使用原 id。
   */
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(id)) {
    return {
      ...base,
      compatible: false,
      manifestError: 'id 只能包含小写字母、数字、点、下划线与连字符，且不能以符号开头',
    }
  }

  try {
    const manifest = validateManifest(
      {
        ...r,
        id: 'client.plugin',
        name,
        version,
        // 客户端插件不强制声明 engines：缺省视为任意版本
        engines: r.engines === undefined ? { lumii: '*' } : r.engines,
        kind: 'code',
        client: { entry: 'client.js' },
      },
      { appVersion: options.appVersion },
    )
    return {
      ...base,
      description: manifest.description ?? description,
      author: manifest.author ?? author,
    }
  } catch (err) {
    const message = (err as Error)?.message ?? String(err)
    // 区分「版本不兼容」与「清单写坏了」：面板上前者是「不兼容」，后者是「失败」
    const incompatible = /engines\.lumii/.test(message)
    return {
      ...base,
      compatible: false,
      ...(incompatible ? { incompatibleReason: message } : { manifestError: message }),
    }
  }
}
