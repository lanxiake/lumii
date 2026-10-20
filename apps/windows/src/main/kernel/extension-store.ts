import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { resolveClientStateDir } from '../paths'

/**
 * 扩展启用状态。
 *
 * 只存**偏离默认的禁用项**：默认全开，用户显式关掉的才落盘。
 * 这样新增扩展不需要迁移任何配置文件。
 *
 * 为什么不用 AppConfig：配置管理器要等 S6 才就绪，而「是否启用」在激活前就要知道；
 * 且配置文件损坏时不能连带让扩展全灭——所以这里是独立的、容错的读取。
 *
 * 两个集合而不是一个带前缀的集合：主进程与渲染层的 id 是**两个独立命名空间**
 * （同名插件可以各存在一个），前缀约定迟早被忘掉。
 */

export interface ExtensionStoreFile {
  version: 2
  /** 主进程扩展的 manifest id（内置与外部共用） */
  disabled: string[]
  /** 渲染层客户端插件的 id */
  disabledClient: string[]
}

export interface ExtensionPrefs {
  disabled: Set<string>
  disabledClient: Set<string>
  warning?: string
}

export function resolveExtensionsConfigPath(): string {
  return path.join(resolveClientStateDir(), 'extensions.json')
}

/**
 * 读取禁用列表。
 *
 * 任何异常（文件不存在 / JSON 损坏 / 结构不对）一律当作「没有禁用项」，
 * 并交由调用方记 warn——坏掉的偏好文件不该让应用失去功能。
 */
export function readExtensionPrefs(
  file: string = resolveExtensionsConfigPath(),
): ExtensionPrefs {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { disabled: new Set(), disabledClient: new Set() }
    return {
      disabled: new Set(),
      disabledClient: new Set(),
      warning: `读取 ${file} 失败：${(err as Error).message}`,
    }
  }

  let parsed: Partial<ExtensionStoreFile>
  try {
    parsed = JSON.parse(raw) as Partial<ExtensionStoreFile>
  } catch (err) {
    return {
      disabled: new Set(),
      disabledClient: new Set(),
      warning: `${file} 不是合法 JSON，已忽略：${(err as Error).message}`,
    }
  }

  if (!Array.isArray(parsed.disabled)) {
    return {
      disabled: new Set(),
      disabledClient: new Set(),
      warning: `${file} 缺少 disabled 数组，已忽略`,
    }
  }

  return {
    disabled: toStringSet(parsed.disabled),
    // disabledClient 是 v2 新增的：老文件没有这个字段是正常情况，不算错误
    disabledClient: Array.isArray(parsed.disabledClient) ? toStringSet(parsed.disabledClient) : new Set(),
  }
}

function toStringSet(values: unknown[]): Set<string> {
  return new Set(values.filter((id): id is string => typeof id === 'string'))
}

/** 主进程扩展开关。外部扩展与内置扩展共用同一张禁用表。 */
export function setMainExtensionEnabled(
  id: string,
  enabled: boolean,
  file: string = resolveExtensionsConfigPath(),
): void {
  updateStore(file, (store) => {
    store.disabled = toggle(store.disabled, id, enabled)
  })
}

/** 渲染层客户端插件开关（写完后宿主会在 ≤1 秒的轮询里看到）。 */
export function setClientExtensionEnabled(
  id: string,
  enabled: boolean,
  file: string = resolveExtensionsConfigPath(),
): void {
  updateStore(file, (store) => {
    store.disabledClient = toggle(store.disabledClient, id, enabled)
  })
}

function toggle(list: string[], id: string, enabled: boolean): string[] {
  const next = list.filter((x) => x !== id)
  if (!enabled) next.push(id)
  return next
}

/**
 * 读-改-写。
 *
 * 先写临时文件再 `rename`：Windows 上 `renameSync` 覆盖已有文件是原子的，
 * 写一半崩掉也不会把偏好文件变成坏 JSON（那会让所有禁用项静默失效）。
 */
function updateStore(file: string, mutate: (store: ExtensionStoreFile) => void): void {
  const { disabled, disabledClient } = readExtensionPrefs(file)
  const store: ExtensionStoreFile = {
    version: 2,
    disabled: [...disabled],
    disabledClient: [...disabledClient],
  }
  mutate(store)

  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}
