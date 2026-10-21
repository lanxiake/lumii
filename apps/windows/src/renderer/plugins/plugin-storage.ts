/**
 * 客户端插件的持久化（`api.storage`）。
 *
 * 底层就是 localStorage：同源、同步、重启还在，正好够单个插件存偏好与缓存。
 * **按插件 id 加前缀**是这里的全部价值——否则两个插件各写一个 `settings` key，
 * 后加载的会把先加载的静默覆盖，而且谁都查不出来。
 *
 * 值一律走 JSON：插件存对象/数组/布尔都行，读的时候按类型拿回来。
 */

export interface PluginStorage {
  /** 读不到或 JSON 坏了返回 fallback */
  get<T>(key: string, fallback?: T): T | undefined
  set(key: string, value: unknown): void
  remove(key: string): void
  /** 本插件的所有 key（不含前缀） */
  keys(): string[]
  /** 只清本插件的 key */
  clear(): void
}

export function createPluginStorage(pluginId: string, storage?: Storage): PluginStorage {
  const prefix = `lumii.plugin.${pluginId}.`
  const store = (): Storage | null => {
    try {
      return storage ?? globalThis.localStorage ?? null
    } catch {
      // 某些环境下访问 localStorage 本身会抛（安全策略/隐私模式）
      return null
    }
  }

  const keys = (): string[] => {
    const s = store()
    if (!s) return []
    /**
     * 两条路都走：浏览器/Electron 里 `length + key(i)` 是标准读法，
     * 但测试环境的 Storage 实现不一定有 `length`（实测 vitest 的 jsdom 包装里拿不到），
     * 而 key 本身是可枚举属性。合起来既正确又不挑环境。
     */
    const all = new Set<string>(Object.keys(s))
    if (typeof s.length === 'number' && typeof s.key === 'function') {
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i)
        if (key) all.add(key)
      }
    }
    return [...all].filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length))
  }

  return {
    get<T>(key: string, fallback?: T): T | undefined {
      const raw = store()?.getItem(prefix + key)
      if (raw === null || raw === undefined) return fallback
      try {
        return JSON.parse(raw) as T
      } catch {
        return fallback
      }
    },
    set(key: string, value: unknown): void {
      store()?.setItem(prefix + key, JSON.stringify(value))
    },
    remove(key: string): void {
      store()?.removeItem(prefix + key)
    },
    keys,
    clear(): void {
      const s = store()
      if (!s) return
      for (const key of keys()) s.removeItem(prefix + key)
    },
  }
}
