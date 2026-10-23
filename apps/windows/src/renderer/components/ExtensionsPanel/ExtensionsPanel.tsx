import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import {
  getClientPluginStates,
  subscribeClientPlugins,
  type ClientPluginState,
} from '../../plugins/client-plugin-host'
import { PLUGIN_REGISTRY, type PluginId } from '../../data/asset-plugins'
import { usePluginsContext } from '../../contexts/PluginsContext/PluginsContext'
import { ConfirmModal } from '../ui/Modal/ConfirmModal'
import styles from './ExtensionsPanel.module.css'

/**
 * 设置 › 扩展：**一张表**看清「进程里有哪些扩展、谁没起来、为什么」。
 *
 * 三种来源（内置 / 外部 / 客户端插件）共用同一套卡片与开关；差别只在字段：
 * 客户端插件在渲染层自己手里（1 秒轮询），主进程扩展走 IPC。
 */

interface ExtensionInfo {
  id: string
  name: string
  version: string
  kind: 'builtin' | 'external' | 'client'
  origin: 'builtin' | 'user' | 'agent' | 'official'
  description?: string
  requires?: { assets?: string[]; optional?: boolean }
  dir?: string
  enabled: boolean
  state: string
  /** 官方清单里有、还没下载安装 */
  installable?: boolean
  /** 已装的官方扩展落后于当前清单 */
  updatable?: boolean
  activationMs?: number
  error?: string
  /** 开关已改，等重启生效 */
  pendingRestart: boolean
  /** 客户端插件才有：删除/打开目录要用渲染层快照里的 dir */
  client?: ClientPluginState
}

const STATE_LABELS: Record<string, string> = {
  active: '运行中',
  activating: '激活中',
  registered: '待激活',
  failed: '失败',
  stopped: '已停止',
  disabled: '已禁用',
  incompatible: '不兼容',
  available: '可安装',
  loaded: '已加载',
  unknown: '未知',
}

const CREATE_KEY = '__create__'

/** 来源徽标：内置 / 官方 / 外部 / Agent 自举开发 */
function originLabel(origin: 'builtin' | 'user' | 'agent' | 'official'): string {
  if (origin === 'builtin') return '内置'
  if (origin === 'official') return '官方'
  return origin === 'agent' ? 'Agent 创建' : '外部'
}

type DeleteTarget = {
  target: { kind: 'external' | 'client'; id: string; dir?: string }
  name: string
  /** 官方扩展叫「卸载」（之后还能从清单里重新安装） */
  verb?: '删除' | '卸载'
}

type SortBy = 'name' | 'state' | 'origin'

/** 状态排序：能用的排前面，需要处理的排后面 */
const STATE_RANK: Record<string, number> = {
  active: 0,
  loaded: 0,
  activating: 1,
  registered: 1,
  incompatible: 2,
  failed: 3,
  available: 4,
  disabled: 5,
  stopped: 5,
  unknown: 6,
}

const ORIGIN_RANK: Record<string, number> = { builtin: 0, official: 1, agent: 2, user: 3 }

interface SortableExtension {
  name: string
  state: string
  origin: 'builtin' | 'user' | 'agent' | 'official'
}

function sortExtensions<T>(
  list: T[],
  pick: (item: T) => SortableExtension,
  by: SortBy,
): T[] {
  const rank = (item: T) => pick(item)
  return [...list].sort((a, b) => {
    const x = rank(a)
    const y = rank(b)
    const byName = () => x.name.localeCompare(y.name, 'zh-CN')
    if (by === 'state') {
      return (STATE_RANK[x.state] ?? 99) - (STATE_RANK[y.state] ?? 99) || byName()
    }
    if (by === 'origin') {
      return (ORIGIN_RANK[x.origin] ?? 99) - (ORIGIN_RANK[y.origin] ?? 99) || byName()
    }
    return byName()
  })
}

function matchesQuery(fields: Array<string | undefined>, query: string): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  return fields.some((field) => field?.toLowerCase().includes(q))
}

/** 客户端插件的快照 → 统一行（渲染层自己手里的清单，不需要 IPC） */
function clientRow(plugin: ClientPluginState): ExtensionInfo {
  return {
    id: plugin.id,
    name: plugin.name,
    version: plugin.version,
    kind: 'client',
    origin: plugin.origin,
    ...(plugin.description ? { description: plugin.description } : {}),
    dir: plugin.dir,
    enabled: plugin.enabled,
    state: plugin.state,
    ...(plugin.error ? { error: plugin.error } : {}),
    pendingRestart: false,
    client: plugin,
  }
}

export const ExtensionsPanel: React.FC = () => {
  const [items, setItems] = useState<ExtensionInfo[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('name')
  // 运行时组件状态来自全局 context：依赖行直接装，不再跳「运行时组件」页签
  const {
    statuses: assetStatuses,
    install: installAsset,
    cancel: cancelAsset,
    refreshAll: refreshAssets,
  } = usePluginsContext()

  // 客户端插件不上 IPC：清单与加载状态都在渲染层自己手里
  const clients = useSyncExternalStore(
    subscribeClientPlugins,
    getClientPluginStates,
    getClientPluginStates,
  )

  /** 三种来源合成一张表；同一套搜索、排序、开关 */
  const rows = useMemo<ExtensionInfo[]>(
    () => [...items, ...clients.map(clientRow)],
    [items, clients],
  )

  /** 主进程扩展：偏好已改、进程里还是启动时那份配置 */
  const pendingRestartCount = rows.filter((row) => row.pendingRestart).length

  const visibleRows = sortExtensions(
    rows.filter((row) =>
      matchesQuery(
        [row.name, row.id, row.version, row.dir, row.description, row.error],
        query,
      ),
    ),
    (row) => ({ name: row.name, state: row.state, origin: row.origin }),
    sortBy,
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
    // 依赖行的安装状态以磁盘为准；页面挂载时重扫一次，避免拿到应用启动时的快照
    void refreshAssets()
  }, [refresh, refreshAssets])

  const toggleMain = useCallback(
    async (row: ExtensionInfo) => {
      setBusy(row.id)
      setNotice(null)
      try {
        const result = await window.electronAPI.extensions.setEnabled(row.id, !row.enabled)
        if (!result.ok) {
          setNotice(result.error ?? '操作失败')
          return
        }
        // 接线在 apply() 里的内置插件与全部外部扩展是**立刻生效**的；其余仍要重启。
        // 以主进程返回的 restartRequired 为准，别替它猜。
        setNotice(
          result.restartRequired === false
            ? `${row.name} 已${row.enabled ? '禁用' : '启用'}，已生效`
            : `${row.name} 已${row.enabled ? '禁用' : '启用'}，重启应用后生效`,
        )
        await refresh()
      } finally {
        setBusy(null)
      }
    },
    [refresh],
  )

  const toggleClient = useCallback(async (row: ExtensionInfo) => {
    setBusy(row.id)
    setNotice(null)
    try {
      const result = await window.electronAPI.extensions.setClientEnabled(row.id, !row.enabled)
      if (!result.ok) {
        setNotice(result.error ?? '操作失败')
        return
      }
      // 宿主每秒拉一次清单，快照自己会更新；这里只给一句确认
      setNotice(`${row.name} 已${row.enabled ? '禁用' : '启用'}，1 秒内生效`)
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

  /** 按需安装官方扩展：走通用 plugin:install（进度/取消都在 PluginsProvider 里） */
  const installOfficial = useCallback(
    async (row: ExtensionInfo) => {
      const runtimeId = `ext:${row.id}` as PluginId
      setBusy(row.id)
      setNotice(null)
      try {
        await installAsset(runtimeId)
        // usePlugins 把失败写进 status 而不抛错，这里回读一次确认真装上了
        const list = await window.electronAPI.plugins.list()
        if (!list[runtimeId]?.installed) {
          setNotice(`${row.name} 安装失败，详情见下方状态`)
          return
        }
        setNotice(`${row.name} 已安装，1 秒内加载`)
        // 外部扩展宿主每秒扫一次目录；稍等再刷新，避免读到安装前的快照
        setTimeout(() => void refresh(), 1500)
      } finally {
        setBusy(null)
      }
    },
    [installAsset, refresh],
  )

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

      <div className={styles.toolbar}>
        <input
          className={styles.search}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索扩展名称 / id / 版本"
          aria-label="搜索扩展"
        />
        <label className={styles.sortLabel}>
          排序
          <select
            className={styles.sort}
            value={sortBy}
            onChange={(event) => setSortBy(event.target.value as SortBy)}
          >
            <option value="name">名称</option>
            <option value="state">状态</option>
            <option value="origin">来源</option>
          </select>
        </label>
      </div>

      <section className={styles.section}>
        <header className={styles.sectionHeader}>
          <h3 className={styles.sectionTitle}>扩展</h3>
          <span className={styles.hint}>开关即时生效；客户端插件 1 秒内生效</span>
          <span className={styles.count}>
            {visibleRows.length}/{rows.length}
          </span>
        </header>

        {rows.length === 0 ? (
          <p className={styles.empty}>扩展宿主尚未就绪</p>
        ) : visibleRows.length === 0 ? (
          <p className={styles.empty}>没有匹配的扩展</p>
        ) : (
          <div className={styles.grid}>
            {visibleRows.map((row) => {
              // 按需安装的官方扩展复用通用插件通道：id = ext:<扩展 id>
              const runtimeId = `ext:${row.id}` as PluginId
              const runtimeStatus = row.kind === 'external' ? assetStatuses[runtimeId] : undefined
              return (
                <article key={`${row.kind}:${row.id}`} className={styles.card}>
                  <div className={styles.meta}>
                    <div className={styles.titleRow}>
                      <span className={styles.name}>{row.name}</span>
                      <span className={styles.badge}>{originLabel(row.origin)}</span>
                      <span className={`${styles.state} ${styles[`state-${row.state}`] ?? ''}`}>
                        {STATE_LABELS[row.state] ?? row.state}
                      </span>
                      {row.activationMs !== undefined && (
                        <span className={styles.timing}>{row.activationMs.toFixed(0)}ms</span>
                      )}
                      {row.pendingRestart && (
                        <span className={`${styles.state} ${styles.statePending}`}>待重启</span>
                      )}
                    </div>
                    <div className={styles.id}>
                      {row.id} · v{row.version}
                      {row.dir ? ` · ${row.dir}` : ''}
                    </div>
                    {row.description && <div className={styles.desc}>{row.description}</div>}
                    {row.error && <div className={styles.error}>{row.error}</div>}
                    {row.requires?.assets?.length ? (
                      <div className={styles.deps}>
                        <span>{row.requires.optional ? '可选依赖' : '依赖'}：</span>
                        {row.requires.assets.map((assetId) => {
                          const def = PLUGIN_REGISTRY.find((d) => d.id === assetId)
                          const status = assetStatuses[assetId]
                          const installed = Boolean(status?.installed)
                          const installing = Boolean(status?.installing)
                          return (
                            <span key={assetId} className={styles.dep}>
                              {def?.name ?? assetId}
                              <span className={installed ? styles.depOk : styles.depMissing}>
                                {installed ? '已安装' : installing ? '安装中' : '未安装'}
                              </span>
                              {!installed && (
                                <button
                                  className={styles.depLink}
                                  disabled={installing}
                                  onClick={() => void installAsset(assetId as PluginId)}
                                >
                                  {installing
                                    ? `${status?.progress?.percent ?? 0}%`
                                    : '安装'}
                                </button>
                              )}
                              {installing && (
                                <button
                                  className={styles.depLink}
                                  onClick={() => void cancelAsset(assetId as PluginId)}
                                >
                                  取消
                                </button>
                              )}
                            </span>
                          )
                        })}
                      </div>
                    ) : null}
                  </div>
                  <div className={styles.actions}>
                    {/* 未安装的官方向导没有目录可打开 */}
                    {(row.kind === 'external' || row.kind === 'client') && row.dir && (
                      <button
                        className={styles.action}
                        onClick={() =>
                          void openDir(
                            row.kind === 'client'
                              ? { kind: 'client', id: row.id, dir: row.dir }
                              : { kind: 'external', id: row.id },
                          )
                        }
                      >
                        打开目录
                      </button>
                    )}
                    {(row.kind === 'external' || row.kind === 'client') && (
                      <button
                        className={styles.action}
                        onClick={() =>
                          setDeleteTarget(
                            row.kind === 'client'
                              ? {
                                  target: { kind: 'client', id: row.id, dir: row.dir },
                                  name: row.name,
                                }
                              : {
                                  target: { kind: 'external', id: row.id },
                                  name: row.name,
                                  verb: row.origin === 'official' ? '卸载' : '删除',
                                },
                          )
                        }
                      >
                        {row.kind === 'external' && row.origin === 'official' ? '卸载' : '删除'}
                      </button>
                    )}
                    {row.updatable && (
                      <button
                        className={styles.toggle}
                        disabled={busy === row.id || Boolean(runtimeStatus?.installing)}
                        onClick={() => void installOfficial(row)}
                      >
                        {runtimeStatus?.installing
                          ? `更新中 ${runtimeStatus.progress?.percent ?? 0}%`
                          : '更新'}
                      </button>
                    )}
                    {row.installable ? (
                      <>
                        <button
                          className={styles.toggle}
                          disabled={busy === row.id || Boolean(runtimeStatus?.installing)}
                          onClick={() => void installOfficial(row)}
                        >
                          {runtimeStatus?.installing
                            ? `安装中 ${runtimeStatus.progress?.percent ?? 0}%`
                            : busy === row.id
                              ? '安装中…'
                              : '安装'}
                        </button>
                        {runtimeStatus?.installing && (
                          <button
                            className={styles.action}
                            onClick={() => void cancelAsset(runtimeId)}
                          >
                            取消
                          </button>
                        )}
                      </>
                    ) : (
                      <button
                        className={styles.toggle}
                        disabled={busy === row.id}
                        onClick={() =>
                          void (row.kind === 'client' ? toggleClient(row) : toggleMain(row))
                        }
                      >
                        {row.enabled ? '禁用' : '启用'}
                      </button>
                    )}
                  </div>
                </article>
              )
            })}
          </div>
        )}
      </section>

      <div className={styles.footer}>
        <button className={styles.primary} disabled={busy === CREATE_KEY} onClick={() => void createSample()}>
          新建示例插件
        </button>
        <button
          className={styles.secondary}
          onClick={() => {
            void refresh()
            void refreshAssets()
          }}
        >
          刷新
        </button>
      </div>

      {notice && <p className={styles.notice}>{notice}</p>}

      <ConfirmModal
        open={deleteTarget !== null}
        title={deleteTarget?.verb ?? '删除'}
        content={
          deleteTarget
            ? `确定${deleteTarget.verb ?? '删除'}「${deleteTarget.name}」？会移除磁盘上的代码目录，不可撤销。`
            : ''
        }
        confirmText={deleteTarget?.verb ?? '删除'}
        confirmVariant="danger"
        layer="aboveHub"
        onConfirm={() => void confirmDelete()}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
