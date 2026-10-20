import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import {
  getClientPluginStates,
  subscribeClientPlugins,
  type ClientPluginState,
} from '../../plugins/client-plugin-host'
import styles from './ExtensionsPanel.module.css'

/**
 * 设置 › 扩展：一张列表看清「进程里有哪些扩展、谁没起来、为什么」。
 *
 * 两类扩展的开关生效时机不同，**必须写在明面上**（P5 计划 §1）：
 * 主进程扩展重启后生效，客户端插件 ≤1 秒生效。
 */

interface ExtensionInfo {
  id: string
  name: string
  version: string
  kind: 'builtin' | 'external'
  dir?: string
  enabled: boolean
  state: string
  activationMs?: number
  error?: string
}

const STATE_LABELS: Record<string, string> = {
  active: '运行中',
  activating: '激活中',
  registered: '待激活',
  failed: '失败',
  stopped: '已停止',
  disabled: '已禁用',
  loaded: '已加载',
  unknown: '未知',
}

const CREATE_KEY = '__create__'

export const ExtensionsPanel: React.FC = () => {
  const [items, setItems] = useState<ExtensionInfo[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)

  // 客户端插件不上 IPC：清单与加载状态都在渲染层自己手里
  const clients = useSyncExternalStore(
    subscribeClientPlugins,
    getClientPluginStates,
    getClientPluginStates,
  )

  const refresh = useCallback(async () => {
    try {
      setItems(await window.electronAPI.extensions.list())
    } catch (err) {
      setNotice(`读取扩展列表失败：${(err as Error).message}`)
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const toggleMain = useCallback(
    async (item: ExtensionInfo) => {
      setBusy(item.id)
      setNotice(null)
      try {
        const result = await window.electronAPI.extensions.setEnabled(item.id, !item.enabled)
        if (!result.ok) {
          setNotice(result.error ?? '操作失败')
          return
        }
        setNotice(`${item.name} 已${item.enabled ? '禁用' : '启用'}，重启应用后生效`)
        await refresh()
      } finally {
        setBusy(null)
      }
    },
    [refresh],
  )

  const toggleClient = useCallback(async (plugin: ClientPluginState) => {
    setBusy(plugin.id)
    setNotice(null)
    try {
      const result = await window.electronAPI.extensions.setClientEnabled(plugin.id, !plugin.enabled)
      if (!result.ok) {
        setNotice(result.error ?? '操作失败')
        return
      }
      // 宿主每秒拉一次清单，快照自己会更新；这里只给一句确认
      setNotice(`${plugin.name} 已${plugin.enabled ? '禁用' : '启用'}，1 秒内生效`)
    } finally {
      setBusy(null)
    }
  }, [])

  const createSample = useCallback(async () => {
    setBusy(CREATE_KEY)
    setNotice(null)
    try {
      const result = await window.electronAPI.extensions.createSample()
      setNotice(result.ok ? `已生成示例插件：${result.dir}` : (result.error ?? '生成失败'))
    } finally {
      setBusy(null)
    }
  }, [])

  return (
    <div className={styles.panel}>
      <section className={styles.section}>
        <header className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>主进程扩展</h3>
          <span className={styles.hint}>开关重启应用后生效</span>
        </header>

        {items.length === 0 ? (
          <p className={styles.empty}>扩展宿主尚未就绪</p>
        ) : (
          <ul className={styles.list}>
            {items.map((item) => (
              <li key={item.id} className={styles.row}>
                <div className={styles.meta}>
                  <div className={styles.titleRow}>
                    <span className={styles.name}>{item.name}</span>
                    <span className={styles.badge}>{item.kind === 'builtin' ? '内置' : '外部'}</span>
                    <span className={`${styles.state} ${styles[`state-${item.state}`] ?? ''}`}>
                      {STATE_LABELS[item.state] ?? item.state}
                    </span>
                    {item.activationMs !== undefined && (
                      <span className={styles.timing}>{item.activationMs.toFixed(0)}ms</span>
                    )}
                  </div>
                  <div className={styles.id}>
                    {item.id} · v{item.version}
                    {item.dir ? ` · ${item.dir}` : ''}
                  </div>
                  {item.error && <div className={styles.error}>{item.error}</div>}
                </div>
                <button
                  className={styles.toggle}
                  disabled={busy === item.id}
                  onClick={() => void toggleMain(item)}
                >
                  {item.enabled ? '禁用' : '启用'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className={styles.section}>
        <header className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>客户端插件</h3>
          <span className={styles.hint}>开关 1 秒内生效</span>
        </header>

        {clients.length === 0 ? (
          <p className={styles.empty}>
            还没有客户端插件。点下面的「新建示例插件」，生成一个马上能跑的。
          </p>
        ) : (
          <ul className={styles.list}>
            {clients.map((plugin) => (
              <li key={plugin.id} className={styles.row}>
                <div className={styles.meta}>
                  <div className={styles.titleRow}>
                    <span className={styles.name}>{plugin.name}</span>
                    <span className={`${styles.state} ${styles[`state-${plugin.state}`] ?? ''}`}>
                      {STATE_LABELS[plugin.state] ?? plugin.state}
                    </span>
                  </div>
                  <div className={styles.id}>
                    {plugin.id} · v{plugin.version} · {plugin.dir}
                  </div>
                  {plugin.error && <div className={styles.error}>{plugin.error}</div>}
                </div>
                <button
                  className={styles.toggle}
                  disabled={busy === plugin.id}
                  onClick={() => void toggleClient(plugin)}
                >
                  {plugin.enabled ? '禁用' : '启用'}
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <div className={styles.footer}>
        <button className={styles.primary} disabled={busy === CREATE_KEY} onClick={() => void createSample()}>
          新建示例插件
        </button>
        <button className={styles.secondary} onClick={() => void refresh()}>
          刷新
        </button>
      </div>

      {notice && <p className={styles.notice}>{notice}</p>}
    </div>
  )
}
