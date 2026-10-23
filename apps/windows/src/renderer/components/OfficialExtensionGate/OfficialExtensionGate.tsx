import React, { useCallback, useEffect, useRef, useState } from 'react'

import { usePluginsContext } from '../../contexts/PluginsContext/PluginsContext'
import type { PluginId } from '../../data/asset-plugins'
import styles from './OfficialExtensionGate.module.css'

type GateState = 'checking' | 'installed' | 'available'

/**
 * 按需安装的官方扩展在**功能页**上的入口。
 *
 * 安装包只带 catalog，所以全新安装的用户打开「云同步 / 录屏」时功能其实还没就位。
 * 与其让页面调用不存在的服务（或者让用户自己猜到设置 › 插件），不如就地在
 * 功能真正被使用的地方给一个安装按钮。
 *
 * 不在官方清单里（旧包 / 开发模式未构建）时直接渲染 children，保持原有行为。
 */
export const OfficialExtensionGate: React.FC<{
  id: string
  name: string
  description: string
  children: React.ReactNode
}> = ({ id, name, description, children }) => {
  const [state, setState] = useState<GateState>('checking')
  const { statuses, install, cancel } = usePluginsContext()
  const runtimeId = `ext:${id}` as PluginId
  // 页面切走时停止轮询，别在卸载后继续打 IPC
  const mountedRef = useRef(true)
  useEffect(() => () => {
    mountedRef.current = false
  }, [])

  /** 返回「仍需要安装」 */
  const refresh = useCallback(async (): Promise<boolean> => {
    try {
      const list = await window.electronAPI.extensions.list()
      const item = list.find((entry) => entry.id === id)
      if (!item) {
        setState('installed')
        return false
      }
      if (item.installable) {
        setState('available')
        return true
      }
      setState('installed')
      return false
    } catch {
      // 读不到列表时不挡路：宁可让功能页按旧行为报错，也不要整页空白
      setState('installed')
      return false
    }
  }, [id])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const installAndWait = useCallback(async () => {
    await install(runtimeId)
    // 外部宿主每秒扫目录；装完到「服务就绪」通常 <1 秒，最多等 10 秒
    for (let i = 0; i < 20; i++) {
      if (!mountedRef.current || !(await refresh())) return
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  }, [install, refresh, runtimeId])

  if (state === 'checking') return null
  if (state === 'installed') return <>{children}</>

  const status = statuses[runtimeId]
  const installing = Boolean(status?.installing)

  return (
    <div className={styles.gate}>
      <div className={styles.title}>{name} 是按需安装的官方扩展</div>
      <p className={styles.desc}>{description}。安装后 1 秒内生效，不占安装包体积。</p>
      <div className={styles.actions}>
        <button
          className={styles.primary}
          disabled={installing}
          onClick={() => void installAndWait()}
        >
          {installing ? `安装中 ${status?.progress?.percent ?? 0}%` : '安装'}
        </button>
        {installing && (
          <button className={styles.secondary} onClick={() => void cancel(runtimeId)}>
            取消
          </button>
        )}
      </div>
    </div>
  )
}
