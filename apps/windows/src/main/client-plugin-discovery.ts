import fs from 'node:fs'
import path from 'node:path'

import { readExtensionPrefs } from './kernel/extension-store'
import { parseClientPluginMeta, type ClientPluginMeta } from './client-plugin-meta'
import { resolveClientPluginsDir, resolveExtensionsDir } from '../plugins/external/paths'

/**
 * 渲染层插件目录扫描。
 *
 * 与 `client-plugin-protocol.ts`（electron 协议）分开：扫描只读文件系统，
 * 静态体检与单测都要用它，不该被 electron 拖下水。
 *
 * ## 两个根目录（2026-10-23 起）
 *
 * 一个插件包可以同时有主进程半边（`main.js`）与渲染层半边（`client.js`）。
 * 因此这里不只看 `~/.lumii/plugins/`，也扫 `~/.lumii/extensions/` 下**带 client.js 的**：
 *
 * - `plugins` 根：只有渲染层半边（历史形态），仍然合法；
 * - `extensions` 根：主进程半边由扩展加载器负责，这里只挑出带 `client.js` 的。
 *
 * 启停判据跟着来源走：`plugins` 用 `disabledClient`，`extensions` 用扩展的 `disabled`。
 */

export type ClientPluginRoot = 'plugins' | 'extensions'

export interface ClientPluginDescriptor extends ClientPluginMeta {
  /** 插件根目录名（URL 用它定位文件；id 可被 plugin.json 覆盖，两者可能不同） */
  dir: string
  /** 来自哪个根：URL 的第一段，也是启停判据的依据 */
  root: ClientPluginRoot
  /** 相对插件根的入口文件 */
  entry: string
  /** client.js 与 plugin.json 的 mtime+size，渲染层据此判断是否需要重新加载 */
  revision: string
  /**
   * 是否启用（`plugins` 根读 `disabledClient`，`extensions` 根读扩展的 `disabled`）。
   *
   * 放在清单里而不是单开一条 IPC：渲染层本来就每秒拉一次清单，
   * 开关也就随同一轮轮询生效，不需要额外通道、额外 preload。
   */
  enabled: boolean
}

export interface DiscoverClientPluginsOptions {
  /**
   * 扫描哪些根。缺省只扫 `~/.lumii/plugins`（保持旧行为）。
   * `extensions` 根的目录必须带 `client.js` 才会被收进来。
   */
  roots?: Array<{ kind: ClientPluginRoot; dir: string }>
  /** 单根旧参数：等价于 `roots: [{ kind: 'plugins', dir: root }]`（测试与旧调用方） */
  root?: string
  /** `engines.lumii` 的比对基准；缺省不校验版本 */
  appVersion?: string
  /** 禁用表文件；测试用 */
  storeFile?: string
}

/**
 * 已告警过的重复 id。清单每秒被拉一次，不去重会把同一句话刷满日志
 * （与扩展加载器的 revision 去重、渲染层宿主去重是同一条教训）。
 */
let warnedDuplicateKeys = new Set<string>()

function fileRevision(file: string): string {
  try {
    const stat = fs.statSync(file)
    return `${Math.floor(stat.mtimeMs)}-${stat.size}`
  } catch {
    return '0'
  }
}

/** 默认根：客户端插件目录 + 扩展目录（后者只收带 client.js 的） */
export function defaultClientPluginRoots(): Array<{ kind: ClientPluginRoot; dir: string }> {
  return [
    { kind: 'plugins', dir: resolveClientPluginsDir() },
    { kind: 'extensions', dir: resolveExtensionsDir() },
  ]
}

/** 扫描客户端插件目录；目录不存在或条目损坏时跳过，不抛错。 */
export function discoverClientPlugins(
  options: DiscoverClientPluginsOptions = {},
): ClientPluginDescriptor[] {
  const roots =
    options.roots ??
    (options.root
      ? [{ kind: 'plugins' as const, dir: options.root }]
      : [{ kind: 'plugins' as const, dir: resolveClientPluginsDir() }])
  // 每秒被 list.json 拉一次，读一个小 JSON 的代价可以忽略（已经在 readdir+stat）
  const { disabled, disabledClient } = readExtensionPrefs(options.storeFile)

  const found: ClientPluginDescriptor[] = []
  /** id → 已经用它的目录名：**复制插件时忘了改 id** 是最常见的配置错误 */
  const idToDir = new Map<string, string>()
  const dupKeys = new Set<string>()

  for (const { kind, dir: root } of roots) {
    let dirs: string[]
    try {
      dirs = fs.readdirSync(root)
    } catch {
      continue
    }

    for (const dirName of [...dirs].sort()) {
      const dir = path.join(root, dirName)
      const entryFile = path.join(dir, 'client.js')
      try {
        if (!fs.statSync(dir).isDirectory()) continue
        fs.statSync(entryFile)
        const meta = parseClientPluginMeta(dir, dirName, { appVersion: options.appVersion })
        const taken = idToDir.get(meta.id)
        if (taken) {
          // 不静默丢：同一 id 的两个目录只会加载一个，另一个永远不会生效，
          // 而界面上看不出任何异常（复制目录后忘改 plugin.json 的典型现场）。
          const key = `${meta.id}|${taken}|${dirName}`
          dupKeys.add(key)
          if (!warnedDuplicateKeys.has(key)) {
            console.warn(
              `[client-plugin] 插件 id 重复："${meta.id}" 同时出现在 ${taken}/ 与 ${dirName}/，` +
                `只加载 ${taken}/。要两个都跑，请改其中一个的 plugin.json id。`,
            )
          }
          continue
        }
        idToDir.set(meta.id, dirName)
        // 启停判据跟着来源走：扩展根的开关是主进程扩展那份
        const disabledForKind = kind === 'extensions' ? disabled : disabledClient
        found.push({
          dir: dirName,
          root: kind,
          id: meta.id,
          name: meta.name,
          version: meta.version,
          ...(meta.description ? { description: meta.description } : {}),
          ...(meta.author ? { author: meta.author } : {}),
          origin: meta.origin,
          entry: 'client.js',
          // 清单也算 revision：只改 plugin.json（比如补 engines/origin）也要重新加载
          revision: `${fileRevision(entryFile)}|${fileRevision(path.join(dir, 'plugin.json'))}`,
          enabled: !disabledForKind.has(meta.id),
          compatible: meta.compatible,
          ...(meta.manifestError ? { manifestError: meta.manifestError } : {}),
          ...(meta.incompatibleReason ? { incompatibleReason: meta.incompatibleReason } : {}),
        })
      } catch {
        continue
      }
    }
  }
  // 本轮还在的重复对保留告警记录；不再重复的（已修好）清掉，下次再犯会重新告警
  warnedDuplicateKeys = dupKeys
  return found.sort((a, b) => a.id.localeCompare(b.id))
}
