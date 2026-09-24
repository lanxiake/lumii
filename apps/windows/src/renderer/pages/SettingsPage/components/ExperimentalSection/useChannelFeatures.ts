/**
 * 渠道实验性功能开关读写（channel:getFeatures / channel:setFeatures）。
 *
 * 开关落在主进程 JSON，不用 localStorage：渠道消息按长连接时序到达，
 * 与渲染窗口是否存活无关，主进程必须能独立读到值。
 *
 * 2026-09-15：随「跨渠道会话接续」开关从「渠道设置」搬到「实验功能」，文件一并挪来
 * （渠道分区已不再使用）。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  DEFAULT_CHANNEL_FEATURES,
  type ChannelFeatureSettings,
} from '../../../../../shared/channel-features'

/** 读取失败时的回落值：与主进程同一份默认（全关） */
const DEFAULTS = DEFAULT_CHANNEL_FEATURES

export interface UseChannelFeaturesResult {
  features: ChannelFeatureSettings
  loading: boolean
  saving: boolean
  /** 写入单个开关；失败时回滚为写入前的值 */
  setFeature: <K extends keyof ChannelFeatureSettings>(
    key: K,
    value: ChannelFeatureSettings[K],
  ) => Promise<void>
}

/**
 * 读取并写入渠道功能开关。
 */
export function useChannelFeatures(): UseChannelFeaturesResult {
  const [features, setFeatures] = useState<ChannelFeatureSettings>(DEFAULTS)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const mountedRef = useRef(true)

  useEffect(() => {
    mountedRef.current = true
    void (async () => {
      try {
        const res = await window.channelService?.getFeatures?.()
        if (mountedRef.current && res) setFeatures({ ...DEFAULTS, ...res })
      } catch {
        // 读失败保持默认（全关），不阻塞设置页其余部分
      } finally {
        if (mountedRef.current) setLoading(false)
      }
    })()
    return () => {
      mountedRef.current = false
    }
  }, [])

  const setFeature = useCallback(
    async <K extends keyof ChannelFeatureSettings>(
      key: K,
      value: ChannelFeatureSettings[K],
    ): Promise<void> => {
      // 乐观更新：开关是即时反馈控件，等 IPC 往返会有明显迟滞
      const prev = features
      setFeatures({ ...prev, [key]: value })
      setSaving(true)
      try {
        const res = await window.channelService?.setFeatures?.({ [key]: value })
        if (mountedRef.current && res) setFeatures({ ...DEFAULTS, ...res })
      } catch {
        if (mountedRef.current) setFeatures(prev)
      } finally {
        if (mountedRef.current) setSaving(false)
      }
    },
    [features],
  )

  return { features, loading, saving, setFeature }
}
