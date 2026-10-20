import { readFileSync } from 'node:fs'
import path from 'node:path'

import { resolveClientStateDir } from '../paths'

/**
 * 扩展启用状态。
 *
 * 只存**偏离默认的禁用项**：内置扩展默认全开，用户显式关掉的才落盘。
 * 这样新增内置扩展不需要迁移任何配置文件。
 *
 * 为什么不用 AppConfig：配置管理器要等 S6 才就绪，而「是否启用」在激活前就要知道；
 * 且配置文件损坏时不能连带让扩展全灭——所以这里是独立的、容错的读取。
 */

export interface ExtensionStoreFile {
  version: 1
  disabled: string[]
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
export function readDisabledExtensionIds(
  file: string = resolveExtensionsConfigPath(),
): { disabled: Set<string>; warning?: string } {
  let raw: string
  try {
    raw = readFileSync(file, 'utf8')
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'ENOENT') return { disabled: new Set() }
    return { disabled: new Set(), warning: `读取 ${file} 失败：${(err as Error).message}` }
  }

  try {
    const parsed = JSON.parse(raw) as Partial<ExtensionStoreFile>
    if (!Array.isArray(parsed.disabled)) {
      return { disabled: new Set(), warning: `${file} 缺少 disabled 数组，已忽略` }
    }
    return { disabled: new Set(parsed.disabled.filter((id): id is string => typeof id === 'string')) }
  } catch (err) {
    return { disabled: new Set(), warning: `${file} 不是合法 JSON，已忽略：${(err as Error).message}` }
  }
}
