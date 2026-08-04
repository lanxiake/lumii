/**
 * useLocalStorage.ts - LocalStorage Hook
 *
 * 提供类型安全的 localStorage 访问
 */

import { useState, useCallback, useEffect } from 'react'

function safeJsonReplacer() {
  const seen = new WeakSet()
  return (key: string, value: unknown): unknown => {
    if (key.startsWith('__react')) return undefined
    if (typeof window !== 'undefined' && value instanceof Node) return undefined
    if (typeof value === 'object' && value !== null) {
      if (seen.has(value)) return '[Circular]'
      seen.add(value)
    }
    return value
  }
}

export function useLocalStorage<T>(
  key: string,
  initialValue: T
): [T, (value: T) => void, () => void] {
  // 从 localStorage 读取初始值
  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key)
      if (!item) return initialValue
      
      // 如果是字符串类型，直接返回（不解析 JSON）
      if (typeof initialValue === 'string') {
        return item as T
      }
      
      // 否则尝试解析 JSON
      try {
        return JSON.parse(item)
      } catch {
        // 如果解析失败，返回原始字符串
        return item as T
      }
    } catch (error) {
      console.error(`[useLocalStorage] Error reading ${key}:`, error)
      return initialValue
    }
  })

  // 设置值并保存到 localStorage
  const setValue = useCallback(
    (value: T) => {
      try {
        setStoredValue(value)
        if (value === null || value === undefined) {
          window.localStorage.removeItem(key)
        } else {
          // 如果是字符串类型，直接存储（不 JSON 序列化）
          if (typeof value === 'string') {
            window.localStorage.setItem(key, value)
          } else {
            window.localStorage.setItem(key, JSON.stringify(value, safeJsonReplacer()))
          }
        }
      } catch (error) {
        console.error(`[useLocalStorage] Error setting ${key}:`, error)
      }
    },
    [key]
  )

  // 删除值
  const removeValue = useCallback(() => {
    try {
      window.localStorage.removeItem(key)
      setStoredValue(initialValue)
    } catch (error) {
      console.error(`[useLocalStorage] Error removing ${key}:`, error)
    }
  }, [key, initialValue])

  // 监听其他标签页的变化
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === key && e.newValue !== null) {
        try {
          // 如果是字符串类型，直接使用
          if (typeof initialValue === 'string') {
            setStoredValue(e.newValue as T)
          } else {
            // 否则尝试解析 JSON
            try {
              setStoredValue(JSON.parse(e.newValue))
            } catch {
              setStoredValue(e.newValue as T)
            }
          }
        } catch (error) {
          console.error(`[useLocalStorage] Error parsing storage event:`, error)
        }
      }
    }

    window.addEventListener('storage', handleStorageChange)
    return () => window.removeEventListener('storage', handleStorageChange)
  }, [key, initialValue])

  return [storedValue, setValue, removeValue]
}
