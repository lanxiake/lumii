import React, { useCallback, useEffect, useState, useSyncExternalStore } from 'react'

import {
  getClientPluginStates,
  subscribeClientPlugins,
  type ClientPluginState,
} from '../../plugins/client-plugin-host'
import { ConfirmModal } from '../ui/Modal/ConfirmModal'
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
  origin: 'builtin' | 'user' | 'agent'
  dir?: string
  enabled: boolean
  state: string
  activationMs?: number
  error?: string
  /** 开关已改，等重启生效 */
  pendingRestart: boolean
}

const STATE_LABELS: Record<string, string> = {
  active: '运行中',
  activating: '激活中',
  registered: '待激活',
  failed: '失败',
  stopped: '已停止',
  disabled: '已禁用',
  incompatible: '不兼容',
  loaded: '已加载',
  unknown: '未知',
}

const CREATE_KEY = '__create__'

/** 来源徽标：内置 / 外部 / Agent 自举开发 */
function originLabel(origin: 'builtin' | 'user' | 'agent'): string {
  if (origin === 'builtin') return '内置'
  return origin === 'agent' ? 'Agent 创建' : '外部'
}

type DeleteTarget = {
  target: { kind: 'external' | 'client'; id: string; dir?: string }
  name: string
}

export const ExtensionsPanel: React.FC = () => {
  const [items, setItems] = useState<ExtensionInfo[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)

  /** 主进程扩展：偏好已改、进程里还是启动时那份配置 */
  const pendingRestartCount = items.filter((item) => item.pendingRestart).length

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

  const restart = useCallback(async () => {
    setRestarting(true)
    setNotice(null)
    try {
      const result = await window.electronAPI.extensions.restart()
      // 正常情况下窗口在这之前就被主进程关了；能走到下面说明重启入口有问题
      if (!result.ok) {
        setRestarting(false)
        setNotice(result.error ?? '重启失败')
      }
    } catch (err) {
      setRestarting(false)
      setNotice(`重启失败：${(err as Error).message}`)
    }
  }, [])

  const openDir = useCallback(async (target: DeleteTarget['target']) => {
    setNotice(null)
    try {
      const result = await window.electronAPI.extensions.openDir(target)
      if (!result.ok) setNotice(result.error ?? '打开目录失败')
    } catch (err) {
      setNotice(`打开目录失败：${(err as Error).message}`)
    }
  }, [])

  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return
    const { target, name } = deleteTarget
    setDeleteTarget(null)
    setBusy(target.id)
    setNotice(null)
    try {
      const result = await window.electronAPI.extensions.remove(target)
      setNotice(result.ok ? `已删除 ${name}` : (result.error ?? '删除失败'))
      await refresh()
    } finally {
      setBusy(null)
    }
  }, [deleteTarget, refresh])

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
      {pendingRestartCount > 0 && (
        <div className={styles.restartBanner}>
          <span className={styles.restartText}>
            {pendingRestartCount} 项主进程扩展改动待重启生效
          </span>
          <button className={styles.primary} disabled={restarting} onClick={() => void restart()}>
            {restarting ? '正在重启…' : '立即重启'}
          </button>
        </div>
      )}

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
                    <span className={styles.badge}>{originLabel(item.origin)}</span>
                    <span className={`${styles.state} ${styles[`state-${item.state}`] ?? ''}`}>
                      {STATE_LABELS[item.state] ?? item.state}
                    </span>
                    {item.activationMs !== undefined && (
                      <span className={styles.timing}>{item.activationMs.toFixed(0)}ms</span>
                    )}
                    {item.pendingRestart && (
                      <span className={`${styles.state} ${styles.statePending}`}>待重启</span>
                    )}
                  </div>
                  <div className={styles.id}>
                    {item.id} · v{item.version}
                    {item.dir ? ` · ${item.dir}` : ''}
                  </div>
                  {item.error && <div className={styles.error}>{item.error}</div>}
                </div>
                <div className={styles.actions}>
                  {item.kind === 'external' && (
                    <>
                      <button
                        className={styles.action}
                        onClick={() => void openDir({ kind: 'external', id: item.id })}
                      >
                        打开目录
                      </button>
                      <button
                        className={styles.action}
                        onClick={() =>
                          setDeleteTarget({
                            target: { kind: 'external', id: item.id },
                            name: item.name,
                          })
                        }
                      >
                        删除
                      </button>
                    </>
                  )}
                  <button
                    className={styles.toggle}
                    disabled={busy === item.id}
                    onClick={() => void toggleMain(item)}
                  >
                    {item.enabled ? '禁用' : '启用'}
                  </button>
                </div>
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
                    <span className={styles.badge}>{originLabel(plugin.origin)}</span>
                    <span className={`${styles.state} ${styles[`state-${plugin.state}`] ?? ''}`}>
                      {STATE_LABELS[plugin.state] ?? plugin.state}
                    </span>
                  </div>
                  <div className={styles.id}>
                    {plugin.id} · v{plugin.version} · {plugin.dir}
                  </div>
                  {plugin.description && <div className={styles.desc}>{plugin.description}</div>}
                  {plugin.error && <div className={styles.error}>{plugin.error}</div>}
                </div>
                <div className={styles.actions}>
                  <button
                    className={styles.action}
                    onClick={() =>
                      void openDir({ kind: 'client', id: plugin.id, dir: plugin.dir })
                    }
                  >
                    打开目录
                  </button>
                  <button
                    className={styles.action}
                    onClick={() =>
                      setDeleteTarget({
                        target: { kind: 'client', id: plugin.id, dir: plugin.dir },
                        name: plugin.name,
                      })
                    }
                  >
                    删除
                  </button>
                  <button
                    className={styles.toggle}
                    disabled={busy === plugin.id}
                    onClick={() => void toggleClient(plugin)}
                  >
                    {plugin.enabled ? '禁用' : '启用'}
                  </button>
                </div>
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

      <ConfirmModal
        open={deleteTarget !== null}
        title="删除插件"
        content={
          deleteTarget
            ? `确定删除「${deleteTarget.name}」？会移除磁盘上的插件目录，不可撤销。`
            : ''
        }
        confirmText="删除"
        confirmVariant="danger"
        layer="aboveHub"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
