import { rmSync } from 'node:fs'
import path from 'node:path'

import type { LumiiPluginManifest, PluginHost, PluginState } from '@mtbot/plugin-core'

import type { ExternalExtensionRuntime } from './extension-loader'
import type { MainEvents } from './kernel/events'
import {
  readExtensionPrefs,
  setClientExtensionEnabled,
  setMainExtensionEnabled,
  resolveExtensionsConfigPath,
} from './kernel/extension-store'
import { BUILTIN_EXTENSIONS, type BuiltinExtension } from './plugin-host'
import { resolveClientPluginsDir } from './plugin-paths'

/**
 * 扩展控制面：给设置页「扩展」页签提供**统一列表**与**启用开关**。
 *
 * 两类扩展的生效时机不同，这个差别必须写在 UI 上（见 P5 计划 §1）：
 *
 * - 主进程扩展（内置 + 外部）：开关写入 `extensions.json`，**重启后生效**。
 *   原因是启动时取出的 `performanceMonitor` 等单例被十余处直接引用，
 *   运行时卸载后变量仍指向旧实例；语音扩展更硬——ONNX 顺序闸不可逆。
 * - 客户端插件：渲染层宿主每秒轮询 `list.json`，**≤1 秒生效**。
 */

export type ExtensionKind = 'builtin' | 'external'

export interface ExtensionInfo {
  id: string
  name: string
  version: string
  kind: ExtensionKind
  /** 来源：内置 / 用户手写 / Agent 自举开发 / 官方可选扩展（只是展示，不是权限） */
  origin: 'builtin' | 'user' | 'agent' | 'official'
  /** 运行时组件依赖（只用于展示与安装引导） */
  requires?: LumiiPluginManifest['requires']
  /** 外部扩展才有 */
  dir?: string
  enabled: boolean
  state: PluginState | 'disabled' | 'unknown'
  activationMs?: number
  error?: string
  /** 开关已改但进程还是启动时的那份配置——需要重启才生效 */
  pendingRestart: boolean
}

export type PluginTargetKind = 'builtin' | 'external' | 'client'

export interface PluginTarget {
  kind: PluginTargetKind
  /** 主进程扩展的 manifest id / 客户端插件的 id */
  id: string
  /** 客户端插件目录名（id 可被 plugin.json 覆盖，删除/打开要用目录名） */
  dir?: string
}

export interface ExtensionControl {
  list(): ExtensionInfo[]
  /** 主进程扩展开关（内置与外部共用一张禁用表） */
  setEnabled(id: string, enabled: boolean): { ok: true; restartRequired: true } | { ok: false; error: string }
  /** 客户端插件开关（写盘后渲染层下一轮轮询即生效） */
  setClientEnabled(id: string, enabled: boolean): { ok: true } | { ok: false; error: string }
  /** 可打开/删除的绝对目录；内置或找不到时 null */
  dirOf(target: PluginTarget): string | null
  /** 删除插件目录。内置只允许禁用，不能删除。 */
  remove(target: PluginTarget): Promise<{ ok: true; dir: string } | { ok: false; error: string }>
}

export interface ExtensionControlDeps {
  host: PluginHost<MainEvents>
  external?: ExternalExtensionRuntime | null
  /** 可注入：单测用它替掉真实清单（真实清单会连带 import voice/onnx 整条依赖链） */
  builtins?: BuiltinExtension[]
  storeFile?: string
  /** 客户端插件根目录；测试注入临时目录 */
  clientPluginsRoot?: string
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createExtensionControl(deps: ExtensionControlDeps): ExtensionControl {
  const builtins = deps.builtins ?? BUILTIN_EXTENSIONS
  const storeFile = deps.storeFile ?? resolveExtensionsConfigPath()

  function list(): ExtensionInfo[] {
    const { disabled } = readExtensionPrefs(storeFile)

    const builtinItems: ExtensionInfo[] = builtins.map(({ manifest }) => {
      const live = deps.host.get(manifest.id)
      const enabled = !disabled.has(manifest.id)
      return {
        id: manifest.id,
        name: manifest.name,
        version: manifest.version,
        kind: 'builtin',
        origin: 'builtin',
        ...(manifest.requires ? { requires: manifest.requires } : {}),
        enabled,
        state: enabled ? (live?.state ?? 'unknown') : 'disabled',
        activationMs: live?.activationMs,
        error: live?.error ? messageOf(live.error) : undefined,
        /**
         * 宿主里是否存在该条目 = 启动时是否启用。
         * 不能用 `state`：激活失败的内置扩展也会留下条目（state='failed'）。
         */
        pendingRestart: enabled !== Boolean(live),
      }
    })

    const externalItems: ExtensionInfo[] = (deps.external?.inspect() ?? []).map((entry) => {
      /**
       * `enabled` 以**偏好文件**为准，不以运行时为准。
       *
       * `inspect().enabled` 是启动时冻结的；用户点了开关之后它会一直是旧值，
       * 于是按钮和状态徽标毫无反馈（实测：同一页上内置行翻了、外部行没翻）。
       * 主进程扩展的开关本来就是「写盘、重启后生效」，按内置行的口径显示即可。
       */
      const enabled = !disabled.has(entry.id)
      // 启动快照里的禁用表；运行时 `entry.enabled` 会被导入失败影响，不能拿来比
      const enabledAtStartup = !deps.external?.startupDisabledIds().has(entry.id)
      return {
        id: entry.id,
        name: entry.name,
        version: entry.version,
        kind: 'external',
        origin: entry.origin,
        ...(entry.requires ? { requires: entry.requires } : {}),
        dir: entry.dir,
        enabled,
        state: enabled ? (entry.state as ExtensionInfo['state']) : 'disabled',
        activationMs: entry.activationMs,
        error: entry.error,
        pendingRestart: enabled !== enabledAtStartup,
      }
    })

    return [...builtinItems, ...externalItems]
  }

  const clientRoot = deps.clientPluginsRoot ?? resolveClientPluginsDir()

  /** 客户端插件目录名 → 绝对路径，拒绝分隔符与 `..` */
  function resolveClientDir(name: string): string | null {
    if (!name || name === '.' || name === '..') return null
    if (name.includes('/') || name.includes('\\')) return null
    const root = path.resolve(clientRoot)
    const dir = path.resolve(root, name)
    if (dir !== root && !dir.startsWith(root + path.sep)) return null
    return dir
  }

  function dirOf(target: PluginTarget): string | null {
    if (target.kind === 'builtin') return null
    if (target.kind === 'external') return deps.external?.dirOf(target.id) ?? null
    return resolveClientDir(target.dir ?? target.id)
  }

  async function remove(
    target: PluginTarget,
  ): Promise<{ ok: true; dir: string } | { ok: false; error: string }> {
    if (target.kind === 'builtin') {
      return { ok: false, error: '内置扩展不能删除；不需要时可以禁用' }
    }

    if (target.kind === 'external') {
      if (!deps.external) return { ok: false, error: '外部扩展运行时尚未就绪' }
      const result = await deps.external.remove(target.id)
      if (!result.ok) return result
      // 目录都没了，禁用记录留着只会让以后同名插件莫名其妙处于禁用态
      try {
        setMainExtensionEnabled(target.id, true, storeFile)
      } catch {
        /* 偏好清理失败不影响删除本身 */
      }
      return result
    }

    const dir = resolveClientDir(target.dir ?? target.id)
    if (!dir) return { ok: false, error: `非法的插件目录：${target.dir ?? target.id}` }
    try {
      rmSync(dir, { recursive: true, force: true })
      try {
        setClientExtensionEnabled(target.id, true, storeFile)
      } catch {
        /* 同上 */
      }
      return { ok: true, dir }
    } catch (err) {
      return { ok: false, error: `删除失败：${(err as Error).message}` }
    }
  }

  function setEnabled(id: string, enabled: boolean): ReturnType<ExtensionControl['setEnabled']> {
    const known = list().some((item) => item.id === id)
    if (!known) return { ok: false, error: `未知扩展：${id}` }
    try {
      setMainExtensionEnabled(id, enabled, storeFile)
      return { ok: true, restartRequired: true }
    } catch (err) {
      return { ok: false, error: `写入偏好失败：${messageOf(err)}` }
    }
  }

  function setClientEnabled(id: string, enabled: boolean): ReturnType<ExtensionControl['setClientEnabled']> {
    try {
      setClientExtensionEnabled(id, enabled, storeFile)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: `写入偏好失败：${messageOf(err)}` }
    }
  }

  return { list, setEnabled, setClientEnabled, dirOf, remove }
}

/** 模块级单例：IPC 处理器需要它，而它要在 S1b 之后才存在。 */
let current: ExtensionControl | null = null

export function setExtensionControl(control: ExtensionControl | null): void {
  current = control
}

export function getExtensionControl(): ExtensionControl | null {
  return current
}
