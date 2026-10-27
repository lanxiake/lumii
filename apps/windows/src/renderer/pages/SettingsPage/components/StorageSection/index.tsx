/**
 * 设置页「存储」：四类占用 + 自动清理策略 + 立即清理 + 回收站 + 最近清理记录。
 *
 * 数据全部来自主进程（scan / prefs / history / trash），设置写回 AppConfig.storageCleanup。
 * 「成品 0 删除」是硬约束：这里显示的四类占用里，deliverable 永远只读不清理。
 */

import { useCallback, useEffect, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import { useToast } from '../../../../components/ui/Toast/useToast'
import { formatBytes } from '../../../../utils/format'
import type {
  ScheduledCleanupResult,
  StorageCleanupPrefs,
} from '../../../../../main/workspace-cleanup-runner'
import type { CleanupHistoryEntry } from '../../../../../main/workspace-cleanup-history'
import type {
  CleanupScan,
  CleanupTrashEntry,
} from '../../../../../shared/workspace-cleanup-types'
import styles from '../../SettingsPage.module.css'

const ROLE_LABEL: Record<'deliverable' | 'intermediate' | 'ephemeral' | 'internal', string> = {
  deliverable: '产出（永不自动删）',
  intermediate: '中间产物',
  ephemeral: '临时文件',
  internal: '内部数据',
}

const TRIGGER_LABEL: Record<string, string> = {
  ttl: '到期清理',
  quota: '配额清理',
  manual: '手动清理',
  'session-delete': '会话删除',
}

export function StorageSection() {
  const toast = useToast()
  const api = window.electronAPI?.workspace
  const [prefs, setPrefs] = useState<StorageCleanupPrefs | null>(null)
  const [scan, setScan] = useState<CleanupScan | null>(null)
  const [scanning, setScanning] = useState(false)
  const [trash, setTrash] = useState<CleanupTrashEntry[]>([])
  const [history, setHistory] = useState<CleanupHistoryEntry[]>([])
  const [busy, setBusy] = useState(false)
  /** 「以此为准」固化副本占用（P2 T6；不自动删，只能在这里清） */
  const [pinUsage, setPinUsage] = useState<{ count: number; bytes: number } | null>(null)

  const refresh = useCallback(async () => {
    if (!api) return
    setScanning(true)
    try {
      const [prefsRes, scanRes, trashRes, historyRes, pinsRes] = await Promise.all([
        api.cleanupGetPrefs?.(),
        // 1.1 万个临时文件的大工作区，3s 会截断；8s 在本机能跑完（实测约 6s）
        api.cleanupScan?.({ budgetMs: 8000 }),
        api.cleanupListTrash?.(),
        api.cleanupHistory?.(50),
        window.electronAPI?.artifact?.pins?.(),
      ])
      if (prefsRes) setPrefs(prefsRes)
      if (scanRes?.ok) setScan(scanRes.scan)
      if (Array.isArray(trashRes)) setTrash(trashRes)
      if (Array.isArray(historyRes)) setHistory(historyRes)
      if (pinsRes?.ok) setPinUsage({ count: pinsRes.pins.length, bytes: pinsRes.totalBytes })
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '读取存储信息失败')
    } finally {
      setScanning(false)
    }
  }, [api, toast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const patchPrefs = (patch: Partial<StorageCleanupPrefs>): void => {
    setPrefs((previous) => (previous ? { ...previous, ...patch } : previous))
  }

  const savePrefs = async (): Promise<void> => {
    if (!api?.cleanupSetPrefs || !prefs) return
    setBusy(true)
    try {
      const result = await api.cleanupSetPrefs(prefs)
      setPrefs(result.prefs)
      toast.success('已保存自动清理策略')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setBusy(false)
    }
  }

  const runNow = async (): Promise<void> => {
    if (!api?.cleanupRunNow) return
    setBusy(true)
    try {
      const result: ScheduledCleanupResult = await api.cleanupRunNow()
      const summary = `TTL ${result.ttlRemoved} 个 · 配额 ${result.quotaRemoved} 个 · 回收站 ${result.trashRemoved} 批`
      if (result.errors.length > 0) toast.warning(`清理完成但有 ${result.errors.length} 个错误：${summary}`)
      else toast.success(`清理完成：${summary}`)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '清理失败')
    } finally {
      setBusy(false)
    }
  }

  /** 清空「以此为准」副本（显式操作；副本删掉后导出选定版不可用） */
  const clearPinned = async (): Promise<void> => {
    const artifactApi = window.electronAPI?.artifact
    if (!artifactApi?.clearPins) return
    if (!window.confirm('清理所有「以此为准」的固化副本？导出选定版将不可用。')) return
    setBusy(true)
    try {
      const result = await artifactApi.clearPins()
      if (!result.ok) {
        toast.error(result.error ?? '清理失败')
        return
      }
      toast.success(`已清理 ${result.removed} 个固化副本（${formatBytes(result.freedBytes)}）`)
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '清理失败')
    } finally {
      setBusy(false)
    }
  }

  const restore = async (id: string): Promise<void> => {
    if (!api?.cleanupRestore) return
    try {
      const result = await api.cleanupRestore(id)
      if (result.ok) {
        toast.success(`已恢复 ${result.restored} 个文件${result.conflicts > 0 ? `，${result.conflicts} 个同名冲突已跳过` : ''}`)
      } else {
        toast.error(result.error ?? '恢复失败')
      }
      await refresh()
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '恢复失败')
    }
  }

  const numberField = (
    label: string,
    key: keyof StorageCleanupPrefs,
    hint: string,
  ) => {
    if (!prefs) return null
    return (
      <div className={styles['setting-item']}>
        <label className={styles['setting-label']} data-app-ui-label>{label}</label>
        <div className={styles['setting-hint']}>{hint}</div>
        <Input
          type="number"
          min={1}
          aria-label={label}
          value={String(prefs[key])}
          onChange={(event) => patchPrefs({ [key]: Number(event.target.value) } as Partial<StorageCleanupPrefs>)}
        />
      </div>
    )
  }

  return (
    <div className={styles['settings-section']}>
      <h3 data-app-ui-section-title>存储</h3>

      <div className={styles['setting-group']}>
        <div className={styles['setting-item']}>
          <label className={styles['setting-label']} data-app-ui-label>工作区占用</label>
          <div className={styles['setting-hint']}>
            {scanning ? '正在统计…' : scan ? '按清理规则分类；产出永远不会被自动删除。' : '暂无数据'}
          </div>
          {scan && (
            <div data-testid="storage-usage">
              {(Object.keys(ROLE_LABEL) as Array<keyof typeof ROLE_LABEL>).map((role) => (
                <div key={role} className={styles['storage-row']}>
                  <span>{ROLE_LABEL[role]}</span>
                  <span>
                    {scan.classes[role].count} 个 · {formatBytes(scan.classes[role].bytes)}
                  </span>
                </div>
              ))}
              {scan.truncated && (
                <div className={styles['setting-hint']}>文件较多，本次统计不完整。</div>
              )}
            </div>
          )}
        </div>

        <div className={styles['setting-item']}>
          <label className={styles['setting-label']} data-app-ui-label>
            已固化版本（以此为准）
          </label>
          <div className={styles['setting-hint']}>
            导出与恢复选定版用的内容副本；不会自动删除，只能在这里清。
          </div>
          <div className={styles['storage-row']} data-testid="pin-usage">
            <span>{pinUsage?.count ?? 0} 个</span>
            <span>{formatBytes(pinUsage?.bytes ?? 0)}</span>
          </div>
          <Button
            variant="secondary"
            onClick={() => void clearPinned()}
            disabled={!pinUsage?.count || busy}
          >
            清理固化副本
          </Button>
        </div>

        {prefs && (
          <>
            <div className={styles['setting-item']}>
              <label className={styles['setting-label']} data-app-ui-label>自动清理</label>
              <div className={styles['setting-hint']}>
                每天 03:00 与启动后（系统空闲 ≥5 分钟）各检查一次；关闭后完全不跑。
              </div>
              <label className={styles['storage-check']}>
                <input
                  type="checkbox"
                  checked={prefs.enabled}
                  onChange={(event) => patchPrefs({ enabled: event.target.checked })}
                />
                启用自动清理
              </label>
            </div>
            {numberField('中间产物保留（天）', 'intermediateDays', '切片、归一化、帧等过程文件')}
            {numberField('临时文件保留（小时）', 'ephemeralHours', 'temp/ 目录下的可再生文件')}
            {numberField('工作区配额（GB）', 'quotaGb', '超过配额时按最老优先清到目标比例')}
            {numberField('清理目标（%）', 'targetPercent', '配额触发后保留的比例（50–95）')}
            {numberField('回收站保留（天）', 'trashDays', '超过后真删；期间可恢复')}
            <div className={styles['setting-row']}>
              <Button onClick={() => void savePrefs()} loading={busy}>
                保存策略
              </Button>
              <Button variant="secondary" onClick={() => void runNow()} loading={busy}>
                立即清理
              </Button>
            </div>
          </>
        )}
      </div>

      <div className={styles['setting-group']}>
        <div className={styles['setting-item']}>
          <label className={styles['setting-label']} data-app-ui-label>回收站</label>
          <div className={styles['setting-hint']}>
            {trash.length === 0 ? '回收站是空的。' : '删除的文件先进回收站，恢复会跳过同名文件。'}
          </div>
          {trash.map((entry) => (
            <div key={entry.id} className={styles['storage-row']}>
              <span>{new Date(entry.createdAt).toLocaleString()}</span>
              <span>
                {entry.files} 个 · {formatBytes(entry.bytes)}
                <Button variant="ghost" size="sm" onClick={() => void restore(entry.id)}>
                  恢复
                </Button>
              </span>
            </div>
          ))}
        </div>

        <div className={styles['setting-item']}>
          <label className={styles['setting-label']} data-app-ui-label>最近清理记录</label>
          <div className={styles['setting-hint']}>
            {history.length === 0 ? '还没有清理记录。' : '来自本机审计日志（cleanup-YYYYMMDD.jsonl）。'}
          </div>
          {history.slice(0, 20).map((entry, index) => (
            <div key={`${entry.at}-${index}`} className={styles['storage-row']}>
              <span title={entry.path ?? ''}>
                {entry.action === 'trash' ? '移入回收站' : '跳过'} {entry.path ?? ''}
              </span>
              <span>
                {TRIGGER_LABEL[entry.trigger ?? ''] ?? entry.reason ?? ''}
                {' · '}
                {new Date(entry.at).toLocaleString()}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
