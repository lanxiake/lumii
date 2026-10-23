import React, { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'

import {
  getClientPluginStates,
  subscribeClientPlugins,
  type ClientPluginState,
} from '../../plugins/client-plugin-host'
import {
  PLUGIN_REGISTRY,
  CATEGORY_LABELS,
  type PluginDef,
  type PluginId,
} from '../../data/asset-plugins'
import { usePluginsContext } from '../../contexts/PluginsContext/PluginsContext'
import { isNewerVersion } from '../../../shared/version'
import { useSettingsHub } from '../SettingsHub/SettingsHubContext'
import { Modal } from '../ui/Modal/Modal'
import { ConfirmModal } from '../ui/Modal/ConfirmModal'
import styles from './ExtensionsPanel.module.css'

/**
 * 设置 › 插件：**一张表**看清「装了哪些插件、谁没起来、为什么」。
 *
 * 分两组展示：
 * - **外部插件**：主进程外部扩展、客户端插件，以及用户会主动安装的独立运行时组件
 *   （反检测浏览器 / 微信本机助手）。组件只在这里「按外部插件展示」，安装/卸载仍走
 *   插件管理器（它们没有 main.js/client.js，不是代码插件）。
 * - **内置插件**：随应用发版，只能禁用不能删除。
 *
 * 卡片力求紧凑：标题行给出状态与来源，第二行给 id/版本/目录，描述最多两行，
 * 其余信息（依赖、激活耗时、安装体积）按需出现，操作按钮贴底。
 */

interface ExtensionInfo {
  id: string
  name: string
  version: string
  kind: 'builtin' | 'external' | 'client' | 'asset'
  origin: 'builtin' | 'user' | 'agent' | 'official' | 'asset'
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
  /** 运行时组件才有 */
  asset?: PluginDef
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
  installed: '已安装',
  installing: '安装中',
  'not-installed': '未安装',
  unknown: '未知',
}

const CREATE_KEY = '__create__'

/** 来源徽标 */
function originLabel(row: ExtensionInfo): string {
  if (row.origin === 'builtin') return '内置'
  if (row.origin === 'official') return '官方'
  if (row.origin === 'agent') return 'Agent 创建'
  if (row.origin === 'asset') return '组件'
  if (row.kind === 'client') return '外部'
  return '外部'
}

/** 目录只显示最后两段，完整路径放 title，省掉卡片里最占宽的一行 */
function shortDir(dir?: string): string {
  if (!dir) return ''
  const parts = dir.split(/[\\/]/).filter(Boolean)
  return parts.slice(-2).join('/')
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
  installed: 0,
  activating: 1,
  registered: 1,
  installing: 1,
  incompatible: 2,
  failed: 3,
  available: 4,
  'not-installed': 4,
  disabled: 5,
  stopped: 5,
  unknown: 6,
}

const ORIGIN_RANK: Record<string, number> = {
  official: 0,
  agent: 1,
  user: 2,
  asset: 3,
  builtin: 9,
}

interface SortableExtension {
  name: string
  state: string
  origin: ExtensionInfo['origin']
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

/**
 * AI 新建插件的开场白。
 *
 * 只写「要做什么」+ 必须遵守的落点与自检方式；规范细节交给 `plugin-development` 技能，
 * 避免把整份文档塞进每一条对话。
 */
function buildPluginBrief(brief: string): string {
  return [
    `请帮我创建一个 Lumii 插件：${brief}`,
    '',
    '开始前先阅读并使用 plugin-development 技能（Lumii 插件开发规范）。要求：',
    '- 一个插件 = 一个 id = 一次注册；先判断形态：',
    '  · 只有界面 → ~/.lumii/plugins/<id>/client.js',
    '  · 需要主进程能力 → ~/.lumii/extensions/<id>/main.js',
    '  · 两者都要 → 放同一个目录（extensions）',
    '- 必须写 plugin.json：id / name / version / description / engines，origin 写 "agent"',
    '- 界面走槽位注册（app.view / app.nav / dashboard.* / settings.*），不要改核心页面',
    '- 写完用 plugin_dev 工具做 check 与 status 自检，并告诉我怎么验证',
  ].join('\n')
}

/** 独立运行时组件 → 统一行（安装状态由 PluginsContext 提供） */
function assetRow(
  def: PluginDef,
  installed: boolean,
  installing: boolean,
  version?: string,
  latestVersion?: string,
): ExtensionInfo {
  return {
    id: def.id,
    name: def.name,
    version: version ?? '',
    kind: 'asset',
    origin: 'asset',
    description: def.description,
    enabled: installed,
    state: installing ? 'installing' : installed ? 'installed' : 'not-installed',
    ...(installing ? { activationMs: undefined } : {}),
    pendingRestart: false,
    // 老安装没有 version.json 边车：版本未知时也给「更新」，重新装一次就能补上边车
    updatable:
      installed &&
      Boolean(latestVersion) &&
      (!version || isNewerVersion(latestVersion, version)),
    asset: def,
  }
}

export interface ExtensionsPanelProps {
  /** 切到别的 Hub 页签（AI 新建插件后跳去对话） */
  onViewChange?: (view: 'chat') => void
}

export const ExtensionsPanel: React.FC<ExtensionsPanelProps> = ({ onViewChange }) => {
  const { closeHub } = useSettingsHub()
  const [items, setItems] = useState<ExtensionInfo[]>([])
  const [notice, setNotice] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<DeleteTarget | null>(null)
  const [assetUninstall, setAssetUninstall] = useState<PluginDef | null>(null)
  const [createOpen, setCreateOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [aiBrief, setAiBrief] = useState('')
  const [query, setQuery] = useState('')
  const [sortBy, setSortBy] = useState<SortBy>('name')
  // 运行时组件状态来自全局 context：依赖行与独立组件卡片共用
  const {
    statuses: assetStatuses,
    install: installAsset,
    uninstall: uninstallAsset,
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
  const rows = useMemo<ExtensionInfo[]>(() => {
    const standalone = PLUGIN_REGISTRY.filter((def) => def.standalone).map((def) => {
      const status = assetStatuses[def.id]
      return assetRow(
        def,
        Boolean(status?.installed),
        Boolean(status?.installing),
        status?.version,
        status?.latestVersion,
      )
    })
    return [...items, ...clients.map(clientRow), ...standalone]
  }, [items, clients, assetStatuses])

  const externalRows = rows.filter((row) => row.kind !== 'builtin')
  const builtinRows = rows.filter((row) => row.kind === 'builtin')

  /** 主进程扩展：偏好已改、进程里还是启动时那份配置 */
  const pendingRestartCount = rows.filter((row) => row.pendingRestart).length

  const filter = useCallback(
    (list: ExtensionInfo[]) =>
      sortExtensions(
        list.filter((row) =>
          matchesQuery(
            [row.name, row.id, row.version, row.dir, row.description, row.error],
            query,
          ),
        ),
        (row) => ({ name: row.name, state: row.state, origin: row.origin }),
        sortBy,
      ),
    [query, sortBy],
  )

  const visibleExternal = filter(externalRows)
  const visibleBuiltin = filter(builtinRows)

  const refresh = useCallback(async () => {
    try {
      setItems(await window.electronAPI.extensions.list())
    } catch (err) {
      setNotice(`读取插件列表失败：${(err as Error).message}`)
    }
  }, [])

  useEffect(() => {
    void refresh()
    // 依赖行与独立组件的安装状态以磁盘为准；页面挂载时重扫一次
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

  const confirmAssetUninstall = useCallback(async () => {
    if (!assetUninstall) return
    const def = assetUninstall
    setAssetUninstall(null)
    setBusy(def.id)
    setNotice(null)
    try {
      await uninstallAsset(def.id)
      setNotice(`已卸载 ${def.name}`)
      await refreshAssets()
    } catch (err) {
      setNotice(`卸载失败：${(err as Error).message}`)
    } finally {
      setBusy(null)
    }
  }, [assetUninstall, uninstallAsset, refreshAssets])

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
      setCreateOpen(false)
    } finally {
      setBusy(null)
    }
  }, [])

  /** AI 新建：开一个新会话并带上插件开发规范（技能名 plugin-development） */
  const startAiCreate = useCallback(() => {
    const brief = aiBrief.trim()
    if (!brief) {
      setNotice('先写一句：这个插件要做什么')
      return
    }
    setCreateOpen(false)
    setAiBrief('')
    closeHub()
    window.dispatchEvent(
      new CustomEvent('mtbot:chat-draft-request', {
        detail: { text: buildPluginBrief(brief), newSession: true },
      }),
    )
    onViewChange?.('chat')
  }, [aiBrief, closeHub, onViewChange])

  /** 手动导入：压缩包或文件夹（系统对话框选来源） */
  const importFrom = useCallback(
    async (kind: 'zip' | 'folder') => {
      setBusy(`import:${kind}`)
      setNotice(null)
      setImportOpen(false)
      try {
        const result =
          kind === 'zip'
            ? await window.electronAPI.extensions.importZip()
            : await window.electronAPI.extensions.importFolder()
        if (!result.ok) {
          if (!result.cancelled) setNotice(result.error ?? '导入失败')
          return
        }
        const kindLabel =
          result.kind === 'both' ? '前后端插件' : result.kind === 'main' ? '主进程扩展' : '客户端插件'
        setNotice(
          result.upgraded
            ? `已升级 ${result.id}：${result.upgraded.from} → ${result.upgraded.to}，1 秒内生效`
            : `已导入 ${result.id}（${kindLabel}），1 秒内加载`,
        )
        // 外部扩展宿主每秒扫一次目录；稍等再刷新，读到的是加载后的状态
        setTimeout(() => void refresh(), 1500)
      } catch (err) {
        setNotice(`导入失败：${(err as Error).message}`)
      } finally {
        setBusy(null)
      }
    },
    [refresh],
  )

  const renderRow = (row: ExtensionInfo): React.ReactElement => {
    // 按需安装的官方扩展复用通用插件通道：id = ext:<插件 id>
    const runtimeId = `ext:${row.id}` as PluginId
    const runtimeStatus = row.kind === 'external' ? assetStatuses[runtimeId] : undefined
    const assetStatus = row.asset ? assetStatuses[row.asset.id] : undefined
    const assetInstalling = Boolean(assetStatus?.installing)
    const assetProgress = assetStatus?.progress
    const shortPath = shortDir(row.dir)

    return (
      <article key={`${row.kind}:${row.id}`} className={styles.card}>
        <div className={styles.meta}>
          <div className={styles.titleRow}>
            {row.asset && <span className={styles.assetIcon}>{row.asset.icon}</span>}
            <span className={styles.name} title={row.name}>{row.name}</span>
            {/* 组件的版本号可能很长（Chromium 版本），放到第二行并截断，避免标题行换行 */}
            {!row.asset && row.version ? (
              <span className={styles.version}>
                {row.version.startsWith('v') ? row.version : `v${row.version}`}
              </span>
            ) : null}
            {!row.asset && <span className={styles.badge}>{originLabel(row)}</span>}
            <span className={`${styles.state} ${styles[`state-${row.state}`] ?? ''}`}>
              {STATE_LABELS[row.state] ?? row.state}
            </span>
            {row.activationMs !== undefined && (
              <span className={styles.timing}>{row.activationMs.toFixed(0)}ms</span>
            )}
            {row.pendingRestart && (
              <span className={`${styles.state} ${styles.statePending}`}>待重启</span>
            )}
            {row.updatable && (
              <span className={`${styles.state} ${styles.statePending}`}>可更新</span>
            )}
          </div>

          <div className={styles.id} title={[row.id, row.version, row.asset?.installSize, row.dir].filter(Boolean).join(' · ')}>
            {row.id}
            {row.asset ? (
              <>
                {row.asset.installSize ? ` · ${row.asset.installSize}` : ''}
                {row.version ? ` · ${row.version}` : ''}
              </>
            ) : null}
            {shortPath ? ` · ${shortPath}` : ''}
          </div>

          <div
            className={`${styles.desc} ${row.description ? '' : styles.descMissing}`}
            title={
              row.description
                ? [
                    row.description,
                    row.asset ? CATEGORY_LABELS[row.asset.category] : '',
                    row.asset?.usedBy?.length
                      ? `用于：${row.asset.usedBy.map((u) => u.label).join('、')}`
                      : '',
                  ]
                    .filter(Boolean)
                    .join('\n')
                : '该插件没有填写功能说明（plugin.json 的 description）'
            }
          >
            {row.description ?? '未填写功能说明'}
          </div>

          {row.error && <div className={styles.error} title={row.error}>{row.error}</div>}

          {row.requires?.assets?.length ? (
            <div
              className={styles.deps}
              title={`${row.requires.optional ? '可选依赖' : '依赖'}：${row.requires.assets.join('、')}`}
            >
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
                      {installed ? '已装' : installing ? '安装中' : '未装'}
                    </span>
                    {!installed && (
                      <button
                        className={styles.depLink}
                        disabled={installing}
                        onClick={() => void installAsset(assetId as PluginId)}
                      >
                        {installing ? `${status?.progress?.percent ?? 0}%` : '安装'}
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

          {row.asset ? (
            assetInstalling ? (
              <button
                className={styles.action}
                onClick={() => void cancelAsset(row.asset!.id)}
              >
                取消
              </button>
            ) : row.enabled ? (
              <>
                {row.updatable && (
                  <button
                    className={styles.toggle}
                    disabled={busy === row.id}
                    title={`已安装 ${row.version || '未知版本'}，可更新到 ${assetStatus?.latestVersion ?? '最新版'}`}
                    onClick={() => void installAsset(row.asset!.id)}
                  >
                    更新
                  </button>
                )}
                <button
                  className={styles.toggle}
                  disabled={busy === row.id}
                  onClick={() => setAssetUninstall(row.asset!)}
                >
                  卸载
                </button>
              </>
            ) : (
              <button
                className={styles.toggle}
                disabled={busy === row.id}
                onClick={() => void installAsset(row.asset!.id)}
              >
                安装
              </button>
            )
          ) : row.updatable ? (
            <button
              className={styles.toggle}
              disabled={busy === row.id || Boolean(runtimeStatus?.installing)}
              onClick={() => void installOfficial(row)}
            >
              {runtimeStatus?.installing
                ? `更新中 ${runtimeStatus.progress?.percent ?? 0}%`
                : '更新'}
            </button>
          ) : row.installable ? (
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

        {row.asset && assetInstalling && (
          <div className={styles.progress}>
            <div className={styles.progressFill} style={{ width: `${assetProgress?.percent ?? 0}%` }} />
          </div>
        )}
      </article>
    )
  }

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <input
          className={styles.search}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索插件名称 / id / 版本"
          aria-label="搜索插件"
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
        <button
          className={styles.secondary}
          onClick={() => {
            void refresh()
            void refreshAssets()
          }}
        >
          刷新
        </button>
        <button className={styles.secondary} onClick={() => setImportOpen(true)}>
          导入插件
        </button>
        <button className={styles.primary} onClick={() => setCreateOpen(true)}>
          新建插件
        </button>
      </div>

      {pendingRestartCount > 0 && (
        <div className={styles.restartBanner}>
          <span className={styles.restartText}>
            {pendingRestartCount} 项插件改动待重启生效
          </span>
          <button className={styles.primary} disabled={restarting} onClick={() => void restart()}>
            {restarting ? '正在重启…' : '立即重启'}
          </button>
        </div>
      )}

      {rows.length === 0 ? (
        <p className={styles.empty}>插件宿主尚未就绪</p>
      ) : (
        <>
          <section className={styles.section}>
            <header className={styles.sectionHeader}>
              <h3 className={styles.sectionTitle}>外部插件</h3>
              <span className={styles.hint}>即时生效；组件按需下载</span>
              <span className={styles.count}>
                {visibleExternal.length}/{externalRows.length}
              </span>
            </header>
            {externalRows.length === 0 ? (
              <p className={styles.empty}>还没有外部插件</p>
            ) : visibleExternal.length === 0 ? (
              <p className={styles.empty}>没有匹配的插件</p>
            ) : (
              <div className={styles.grid}>{visibleExternal.map(renderRow)}</div>
            )}
          </section>

          <section className={styles.section}>
            <header className={styles.sectionHeader}>
              <h3 className={styles.sectionTitle}>内置插件</h3>
              <span className={styles.hint}>随应用发版，只能禁用</span>
              <span className={styles.count}>
                {visibleBuiltin.length}/{builtinRows.length}
              </span>
            </header>
            {visibleBuiltin.length === 0 ? (
              <p className={styles.empty}>没有匹配的插件</p>
            ) : (
              <div className={styles.grid}>{visibleBuiltin.map(renderRow)}</div>
            )}
          </section>
        </>
      )}

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

      <ConfirmModal
        open={assetUninstall !== null}
        title="卸载"
        content={
          assetUninstall
            ? `确定卸载「${assetUninstall.name}」？相关功能（${assetUninstall.usedBy?.map((u) => u.label).join('、') ?? '依赖它的功能'}）会不可用。`
            : ''
        }
        confirmText="卸载"
        confirmVariant="danger"
        layer="aboveHub"
        onConfirm={() => void confirmAssetUninstall()}
        onCancel={() => setAssetUninstall(null)}
      />

      {/* 新建插件：AI 生成（默认）或生成示例插件 */}
      <Modal
        open={createOpen}
        title="新建插件"
        width={560}
        layer="aboveHub"
        onClose={() => setCreateOpen(false)}
        footer={
          <div className={styles.modalActions}>
            <button
              className={styles.secondary}
              disabled={busy === CREATE_KEY}
              onClick={() => void createSample()}
            >
              {busy === CREATE_KEY ? '生成中…' : '生成示例插件'}
            </button>
            <button
              className={styles.primary}
              disabled={!aiBrief.trim()}
              onClick={startAiCreate}
            >
              让 AI 创建
            </button>
          </div>
        }
      >
        <div className={styles.createForm}>
          <label className={styles.formLabel} htmlFor="plugin-ai-brief">
            这个插件要做什么？
          </label>
          <textarea
            id="plugin-ai-brief"
            className={styles.textarea}
            rows={4}
            value={aiBrief}
            onChange={(event) => setAiBrief(event.target.value)}
            placeholder="例：在概览页加一张卡片，显示今天喝了几杯水，点一下 +1，数据本地保存"
          />
          <p className={styles.formHint}>
            AI 会新开一个会话，按「plugin-development」技能实现、自检并告诉你怎么验证。
            也可以先生成示例插件，再让 AI 基于它改。
          </p>
        </div>
      </Modal>

      {/* 导入插件：压缩包或文件夹 */}
      <Modal
        open={importOpen}
        title="导入插件"
        width={480}
        layer="aboveHub"
        onClose={() => setImportOpen(false)}
      >
        <div className={styles.createForm}>
          <p className={styles.formHint}>
            支持 <code>.zip</code> 压缩包或插件文件夹。含 <code>main.js</code> 的装到外部扩展，
            只有 <code>client.js</code> 的装到客户端插件。同名插件只有在{' '}
            <strong>版本更高</strong>时才升级（比较 <code>plugin.json.version</code>）；
            同版本或降级会被拒绝，升级失败会自动还原旧版本。
          </p>
          <div className={styles.modalActions}>
            <button
              className={styles.primary}
              disabled={busy === 'import:zip'}
              onClick={() => void importFrom('zip')}
            >
              {busy === 'import:zip' ? '导入中…' : '选择压缩包 (.zip)'}
            </button>
            <button
              className={styles.secondary}
              disabled={busy === 'import:folder'}
              onClick={() => void importFrom('folder')}
            >
              {busy === 'import:folder' ? '导入中…' : '选择文件夹'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
