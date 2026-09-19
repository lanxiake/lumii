/**
 * useFeatureAvailability - 读取能力矩阵（设计 §7，D16）
 *
 * UI 据此把不支持的入口**置灰并展示原因**，而不是等用户点了才报错（D4）。
 *
 * **失败时的降级取向很重要**：拿不到矩阵时按「全部可用」处理，而不是「全部禁用」。
 * 理由——如果 main 侧 IPC 出问题，把整个界面禁用掉等于让应用不可用，代价远大于
 * 「某个入口点了才发现不支持」；后者至少有 main 侧的兜底报错。这条已经写在
 * 返回值里（`ready: false`），调用方想显示加载态也能拿到。
 */
import { useCallback, useEffect, useState } from 'react'
import {
  resolveFeatureAvailability,
  type BlockReason,
  type FeatureAvailability,
  type FeatureId,
} from '@shared/feature-availability'

export interface UseFeatureAvailabilityReturn {
  /** 指定功能是否可用（矩阵未就绪时按可用处理，见文件头） */
  isAvailable: (id: FeatureId) => boolean
  /** 不可用时的展示文案；可用时返回 null */
  blockMessage: (id: FeatureId) => string | null
  /** 不可用的原因（便于按原因分支，如「缺运行时」给安装引导） */
  blockReason: (id: FeatureId) => BlockReason | undefined
  /** 矩阵是否已从主进程取到 */
  ready: boolean
}

type Snapshot = Record<FeatureId, FeatureAvailability>

export function useFeatureAvailability(): UseFeatureAvailabilityReturn {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null)
  const [messages, setMessages] = useState<Record<string, Partial<Record<BlockReason, string>>> | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const res = await window.electronAPI.app.getFeatureAvailability()
        if (cancelled) return
        setSnapshot(res.features)
        setMessages(res.messages as typeof messages)
      } catch (err) {
        if (cancelled) return
        // 拿不到矩阵时按「全部可用」降级：宁可入口可点后再报错，
        // 也不要把整个界面禁用掉（见文件头）
        console.warn('[useFeatureAvailability] 读取能力矩阵失败，按全部可用处理:', err)
        setSnapshot(resolveFeatureAvailability({ platform: 'win32' }))
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const isAvailable = useCallback(
    (id: FeatureId): boolean => {
      if (!snapshot) return true // 未就绪 → 按可用（见文件头）
      return snapshot[id]?.available ?? true
    },
    [snapshot],
  )

  const blockReason = useCallback(
    (id: FeatureId): BlockReason | undefined => {
      if (!snapshot) return undefined
      return snapshot[id]?.reason
    },
    [snapshot],
  )

  const blockMessage = useCallback(
    (id: FeatureId): string | null => {
      if (!snapshot) return null
      const entry = snapshot[id]
      if (!entry || entry.available || !entry.reason) return null
      return messages?.[id]?.[entry.reason] ?? '当前环境不支持该功能。'
    },
    [snapshot, messages],
  )

  return { isAvailable, blockMessage, blockReason, ready: snapshot !== null }
}
