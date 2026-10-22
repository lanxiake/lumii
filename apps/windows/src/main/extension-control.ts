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
import { BUILTIN_EXTENSIONS, HOT_SWAPPABLE_BUILTINS, type BuiltinExtension } from './plugin-host'
import { resolveClientPluginsDir } from './plugin-paths'
import { readInstalledOfficial, type OfficialCatalogEntry } from './official-extensions'

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
  /** 一句话说明（官方可选扩展来自 catalog） */
  description?: string
  /** 运行时组件依赖（只用于展示与安装引导） */
  requires?: LumiiPluginManifest['requires']
  /** 外部扩展才有 */
  dir?: string
  enabled: boolean
  /** available = 官方清单里有、但还没下载安装 */
  state: PluginState | 'disabled' | 'available' | 'unknown'
  /** 显示「安装」按钮（按需下载的官方扩展） */
  installable?: boolean
  /** 已装的官方扩展与当前清单 sha256 不同 → 显示「更新」 */
  updatable?: boolean
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
  /**
   * 主进程扩展开关（内置与外部共用一张禁用表）。
   *
   * `restartRequired: false` 表示**已经生效**（内置插件里接线在 `apply()` 的那批）。
   * 外部扩展与尚未迁移的内置插件仍返回 true——它们的初始化散在核心启动路径上。
   */
  setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<{ ok: true; restartRequired: boolean } | { ok: false; error: string }>
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
  /** 可注入：哪些内置插件支持运行期启停（默认 `HOT_SWAPPABLE_BUILTINS`） */
  hotSwappable?: ReadonlySet<string>
  storeFile?: string
  /** 客户端插件根目录；测试注入临时目录 */
  clientPluginsRoot?: string
  /** 官方扩展清单（安装包里只有清单，代码按需下载） */
  officialCatalog?: OfficialCatalogEntry[]
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function createExtensionControl(deps: ExtensionControlDeps): ExtensionControl {
  const builtins = deps.builtins ?? BUILTIN_EXTENSIONS
  const builtinIds = new Set(builtins.map(({ manifest }) => manifest.id))
  const hotSwappable = deps.hotSwappable ?? HOT_SWAPPABLE_BUILTINS
  const storeFile = deps.storeFile ?? resolveExtensionsConfigPath()

  function list(): ExtensionInfo[] {
    const { disabled } = readExtensionPrefs(storeFile)

    const builtinItems: ExtensionInfo[] = builtins.map(({ manifest }) => {
      const live = deps.host.get(manifest.id)
      const enabled = !disabled.has(manifest.id)
      /**
       * 内置插件**总是**登记在宿主里（禁用的只是不激活，见 plugin-host.ts），
       * 所以判「有没有在跑」只能看 state：registered/stopped = 没跑；
       * failed 算「已经尝试过」，不该一直挂着「待重启」。
       */
      const running = live?.state === 'active' || live?.state === 'failed'
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
        pendingRestart: enabled !== running,
      }
    })

    const catalogById = new Map((deps.officialCatalog ?? []).map((entry) => [entry.id, entry]))

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
      // 官方扩展：已装 marker 的 sha256 与当前清单不同 → 可更新（安装包不会自动覆盖）
      const catalogEntry = entry.origin === 'official' ? catalogById.get(entry.id) : undefined
      const installedSha = catalogEntry ? readInstalledOfficial(entry.dir)?.sha256 : undefined
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
        ...(catalogEntry && installedSha && installedSha !== catalogEntry.sha256
          ? { updatable: true }
          : {}),
        activationMs: entry.activationMs,
        error: entry.error,
        pendingRestart: enabled !== enabledAtStartup,
      }
    })

    /**
     * 官方清单里有、但用户目录里没有的：显示成「可安装」。
     *
     * 判据用运行时列表而不是文件系统：装坏了/加载失败的条目已经在 externalItems 里
     * （state=failed），不能同时再出现一个「可安装」的重复行。
     */
    const known = new Set([...builtinItems, ...externalItems].map((item) => item.id))
    const availableItems: ExtensionInfo[] = (deps.officialCatalog ?? [])
      .filter((entry) => !known.has(entry.id))
      .map((entry) => ({
        id: entry.id,
        name: entry.name,
        version: entry.version,
        kind: 'external',
        origin: 'official',
        description: entry.description,
        enabled: false,
        state: 'available',
        installable: true,
        pendingRestart: false,
      }))

    return [...builtinItems, ...externalItems, ...availableItems]
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

  async function setEnabled(
    id: string,
    enabled: boolean,
  ): Promise<ReturnType<ExtensionControl['setEnabled']> extends Promise<infer R> ? R : never> {
    const known = list().some((item) => item.id === id)
    if (!known) return { ok: false, error: `未知扩展：${id}` }
    try {
      setMainExtensionEnabled(id, enabled, storeFile)
    } catch (err) {
      return { ok: false, error: `写入偏好失败：${messageOf(err)}` }
    }

    // 外部扩展由 ExternalExtensionRuntime 管（有自己的一套加载/回滚），这里不碰
    if (!builtinIds.has(id) || !hotSwappable.has(id)) {
      return { ok: true, restartRequired: true }
    }

    try {
      if (enabled) {
        const error = await deps.host.activate(id)
        if (error) return { ok: false, error: `启用失败：${messageOf(error)}` }
      } else {
        await deps.host.stop(id)
      }
      return { ok: true, restartRequired: false }
    } catch (err) {
      return { ok: false, error: `切换失败：${messageOf(err)}` }
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
