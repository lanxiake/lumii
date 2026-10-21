import type { PluginHost, PluginState } from '@mtbot/plugin-core'

import type { ExternalExtensionRuntime } from './extension-loader'
import type { MainEvents } from './kernel/events'
import {
  readExtensionPrefs,
  setClientExtensionEnabled,
  setMainExtensionEnabled,
  resolveExtensionsConfigPath,
} from './kernel/extension-store'
import { BUILTIN_EXTENSIONS, type BuiltinExtension } from './plugin-host'

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
  /** 外部扩展才有 */
  dir?: string
  enabled: boolean
  state: PluginState | 'disabled' | 'unknown'
  activationMs?: number
  error?: string
  /** 开关已改但进程还是启动时的那份配置——需要重启才生效 */
  pendingRestart: boolean
}

export interface ExtensionControl {
  list(): ExtensionInfo[]
  /** 主进程扩展开关（内置与外部共用一张禁用表） */
  setEnabled(id: string, enabled: boolean): { ok: true; restartRequired: true } | { ok: false; error: string }
  /** 客户端插件开关（写盘后渲染层下一轮轮询即生效） */
  setClientEnabled(id: string, enabled: boolean): { ok: true } | { ok: false; error: string }
}

export interface ExtensionControlDeps {
  host: PluginHost<MainEvents>
  external?: ExternalExtensionRuntime | null
  /** 可注入：单测用它替掉真实清单（真实清单会连带 import voice/onnx 整条依赖链） */
  builtins?: BuiltinExtension[]
  storeFile?: string
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

  return { list, setEnabled, setClientEnabled }
}

/** 模块级单例：IPC 处理器需要它，而它要在 S1b 之后才存在。 */
let current: ExtensionControl | null = null

export function setExtensionControl(control: ExtensionControl | null): void {
  current = control
}

export function getExtensionControl(): ExtensionControl | null {
  return current
}
