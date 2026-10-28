import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import path from 'node:path'

import { resolveClientStateDir } from '../paths'

/**
 * 扩展启用状态。
 *
 * 只存**偏离默认的项**：绝大多数扩展默认全开，用户显式关掉的才落盘；少数扩展
 * （见 `DEFAULT_DISABLED`）默认关闭，用户显式打开的才落盘。这样新增扩展不需要
 * 迁移任何配置文件。
 *
 * 为什么不用 AppConfig：配置管理器要等 S6 才就绪，而「是否启用」在激活前就要知道；
 * 且配置文件损坏时不能连带让扩展全灭——所以这里是独立的、容错的读取。
 *
 * 两个集合而不是一个带前缀的集合：主进程与渲染层的 id 是**两个独立命名空间**
 * （同名插件可以各存在一个），前缀约定迟早被忘掉。
 */

/**
 * 默认**关闭**的内置扩展集合由调用方传入（见 `plugins/registry.ts` 的
 * `DEFAULT_DISABLED_EXTENSIONS`，那份从各插件 manifest 的 `defaultEnabled` 派生）。
 *
 * 本模块是**机制**，不认识任何具体插件 id：哪个插件默认关是插件自己的声明，
 * 写死在这里等于 kernel 反向认识业务，加一个默认关闭的插件就要改一次内核。
 */
export type DefaultDisabledIds = ReadonlySet<string>

export interface ExtensionStoreFile {
  version: 2
  /** 主进程扩展的 manifest id（内置与外部共用） */
  disabled: string[]
  /** 渲染层客户端插件的 id */
  disabledClient: string[]
  /**
   * 显式**打开**的默认关闭项（主进程扩展 id）。
   *
   * 只有「默认关闭」的 id 会出现在这里——也就是说这个名字指「用户推翻了默认」，
   * 而不是「当前启用清单」。其余扩展不用记（默认就是开）。老文件没这个字段是正常情况。
   */
  enabled?: string[]
}

export interface ExtensionPrefs {
  disabled: Set<string>
  disabledClient: Set<string>
  warning?: string
}

export function resolveExtensionsConfigPath(): string {
  return path.join(resolveClientStateDir(), 'extensions.json')
}

/** 文件里的原始三份表，不含默认值合成（写回时必须用这个，否则默认项会被固化进文件） */
interface RawPrefs {
  disabled: string[]
  disabledClient: string[]
  enabled: string[]
  warning?: string
}

function readRaw(file: string): RawPrefs {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { disabled: [], disabledClient: [], enabled: [] }
    return {
      disabled: [],
      disabledClient: [],
      enabled: [],
      warning: `读取 ${file} 失败：${(err as Error).message}`,
    }
  }

  let parsed: Partial<ExtensionStoreFile>
  try {
    parsed = JSON.parse(raw) as Partial<ExtensionStoreFile>
  } catch (err) {
    return {
      disabled: [],
      disabledClient: [],
      enabled: [],
      warning: `${file} 不是合法 JSON，已忽略：${(err as Error).message}`,
    }
  }

  if (!Array.isArray(parsed.disabled)) {
    return {
      disabled: [],
      disabledClient: [],
      enabled: [],
      warning: `${file} 缺少 disabled 数组，已忽略`,
    }
  }

  return {
    disabled: toStrings(parsed.disabled),
    // disabledClient / enabled 都是后来加的：老文件没有这些字段是正常情况，不算错误
    disabledClient: Array.isArray(parsed.disabledClient) ? toStrings(parsed.disabledClient) : [],
    enabled: Array.isArray(parsed.enabled) ? toStrings(parsed.enabled) : [],
  }
}

/**
 * 读取禁用列表（已合成默认值）。
 *
 * 任何异常（文件不存在 / JSON 损坏 / 结构不对）一律当作「没有偏离默认的项」，
 * 并交由调用方记 warn——坏掉的偏好文件不该让应用失去功能。注意默认关闭的扩展
 * 在坏文件下仍然是关的：那是默认值，不是偏好。
 */
export function readExtensionPrefs(
  file: string = resolveExtensionsConfigPath(),
  defaultDisabled: DefaultDisabledIds = EMPTY,
): ExtensionPrefs {
  const raw = readRaw(file)
  const enabled = new Set(raw.enabled)
  const disabled = new Set(raw.disabled)
  // 显式打开优先于「用户关过」——两项同时存在时以 `enabled` 为准（见 setMainExtensionEnabled）
  for (const id of enabled) disabled.delete(id)
  for (const id of defaultDisabled) {
    if (!enabled.has(id)) disabled.add(id)
  }
  return {
    disabled,
    disabledClient: new Set(raw.disabledClient),
    ...(raw.warning ? { warning: raw.warning } : {}),
  }
}

const EMPTY: DefaultDisabledIds = new Set()

function toStrings(values: unknown[]): string[] {
  return values.filter((id): id is string => typeof id === 'string')
}

/** 主进程扩展开关。外部扩展与内置扩展共用同一张禁用表。 */
export function setMainExtensionEnabled(
  id: string,
  enabled: boolean,
  file: string = resolveExtensionsConfigPath(),
  defaultDisabled: DefaultDisabledIds = EMPTY,
): void {
  updateStore(file, (store) => {
    if (defaultDisabled.has(id)) {
      // 默认关闭项：**在 enabled 里 = 开**，不在 = 关（不必写进 disabled）
      store.enabled = mark(store.enabled ?? [], id, enabled)
      store.disabled = store.disabled.filter((x) => x !== id)
    } else {
      store.disabled = mark(store.disabled, id, !enabled)
      store.enabled = (store.enabled ?? []).filter((x) => x !== id)
    }
  })
}

/** 渲染层客户端插件开关（写完后宿主会在 ≤1 秒的轮询里看到）。 */
export function setClientExtensionEnabled(
  id: string,
  enabled: boolean,
  file: string = resolveExtensionsConfigPath(),
): void {
  updateStore(file, (store) => {
    store.disabledClient = mark(store.disabledClient, id, !enabled)
  })
}

/** 让 id 在列表里的出现与否等于 `present`（出现即「坏了默认」的标记，不重复写） */
function mark(list: string[], id: string, present: boolean): string[] {
  const next = list.filter((x) => x !== id)
  if (present) next.push(id)
  return next
}

/**
 * 读-改-写。读的是**原始**表（不是合成后的）：否则默认关闭项会被当成用户的选择
 * 写回 `disabled`，之后把它从 `DEFAULT_DISABLED_EXTENSIONS` 删掉就再也开不起来了。
 *
 * 先写临时文件再 `rename`：Windows 上 `renameSync` 覆盖已有文件是原子的，
 * 写一半崩掉也不会把偏好文件变成坏 JSON（那会让所有禁用项静默失效）。
 */
function updateStore(file: string, mutate: (store: ExtensionStoreFile) => void): void {
  const raw = readRaw(file)
  const store: ExtensionStoreFile = {
    version: 2,
    disabled: raw.disabled,
    disabledClient: raw.disabledClient,
    ...(raw.enabled.length > 0 ? { enabled: raw.enabled } : {}),
  }
  mutate(store)

  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}
