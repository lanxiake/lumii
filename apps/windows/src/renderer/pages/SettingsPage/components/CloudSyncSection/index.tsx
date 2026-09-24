import { useCallback, useEffect, useState } from 'react'
import { Button } from '../../../../components/ui/Button/Button'
import { Input } from '../../../../components/ui/Input/Input'
import { Select } from '../../../../components/ui/Select/Select'
import { Switch } from '../../../../components/ui/Switch/Switch'
import { useToast } from '../../../../components/ui/Toast/useToast'
import type { CloudSyncConfigView, SyncStatus } from '../../../../../main/cloud-sync/types'
import type { SyncLogEntry } from '../../../../../main/cloud-sync/sync-log'
import {
  fetchCloudSyncConfig,
  fetchCloudSyncStatus,
  fetchCloudSyncLogs,
  fetchPendingMassDelete,
  fetchLargeQueueStats,
  saveCloudSyncConfig,
  testCloudSyncConnection,
  syncCloudSyncNow,
  retryCloudSyncConflict,
  confirmCloudSyncMassDelete,
  subscribeCloudSyncStatus,
} from '../../../../services/cloud-sync-service'
import { openExternal } from '../../../../services/app-service'
import { writeClipboardText } from '../../../../services/clipboard-service'
import styles from '../../SettingsPage.module.css'

const STATE_LABEL: Record<string, string> = {
  idle: '空闲',
  syncing: '同步中',
  conflict: '冲突待处理',
  error: '错误',
}

export function CloudSyncSection() {
  const toast = useToast()
  const [form, setForm] = useState<CloudSyncConfigView | null>(null)
  const [token, setToken] = useState('')
  const [status, setStatus] = useState<SyncStatus | null>(null)
  const [testing, setTesting] = useState(false)
  const [syncing, setSyncing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [retrying, setRetrying] = useState(false)
  const [guideOpen, setGuideOpen] = useState(true)
  const [logs, setLogs] = useState<SyncLogEntry[]>([])
  const [pendingDelete, setPendingDelete] = useState<{
    fingerprint: string
    count: number
    createdAt: number
  } | null>(null)
  const [confirmingDelete, setConfirmingDelete] = useState(false)
  const [largeStats, setLargeStats] = useState<{
    pendingFiles: number
    pendingBytes: number
    pumping: boolean
  } | null>(null)

  const load = useCallback(async () => {
    const cfg = await fetchCloudSyncConfig()
    if (cfg) setForm(cfg)
    const st = await fetchCloudSyncStatus()
    if (st) setStatus(st)
    const lg = await fetchCloudSyncLogs()
    if (lg) setLogs(lg)
    setPendingDelete(await fetchPendingMassDelete())
    setLargeStats(await fetchLargeQueueStats())
  }, [])

  const refreshStatusAndLogs = useCallback(async () => {
    const st = await fetchCloudSyncStatus()
    if (st) setStatus(st)
    const lg = await fetchCloudSyncLogs()
    if (lg) setLogs(lg)
    setPendingDelete(await fetchPendingMassDelete())
    setLargeStats(await fetchLargeQueueStats())
  }, [])

  useEffect(() => {
    load()
    return subscribeCloudSyncStatus(() => {
      void refreshStatusAndLogs()
    })
  }, [load, refreshStatusAndLogs])

  const save = async () => {
    if (!form) return
    setSaving(true)
    try {
      const r = await saveCloudSyncConfig({ ...form, token })
      if (r.success) {
        setToken('')
        if (r.data) setForm(r.data)
        toast.success('云同步配置已保存')
      } else {
        toast.error(r.error || '保存失败')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const test = async () => {
    if (!form) return
    setTesting(true)
    try {
      const r = await testCloudSyncConnection({ ...form, token })
      if (r.success) toast.success('连接成功')
      else toast.error(r.error || '连接失败')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '连接失败')
    } finally {
      setTesting(false)
    }
  }

  const syncNow = async () => {
    setSyncing(true)
    try {
      await syncCloudSyncNow()
    } finally {
      setSyncing(false)
    }
  }

  const retryConflict = async () => {
    setRetrying(true)
    try {
      const r = await retryCloudSyncConflict()
      if (r.success) {
        toast.info('已触发 Agent 重新处理冲突')
        void refreshStatusAndLogs()
      } else {
        toast.error(r.error || '重试失败')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '重试失败')
    } finally {
      setRetrying(false)
    }
  }

  /** 用户显式确认批量删除：确认后立即同步一次让删除执行（指纹由主进程比对） */
  const confirmMassDelete = async (fingerprint: string) => {
    setConfirmingDelete(true)
    try {
      const r = await confirmCloudSyncMassDelete(fingerprint)
      if (r.success) {
        toast.info('已确认，正在执行该批删除')
        await syncCloudSyncNow()
        await refreshStatusAndLogs()
      } else {
        toast.error(r.error || '确认失败')
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : '确认失败')
    } finally {
      setConfirmingDelete(false)
    }
  }

  const openGitCode = async () => {
    const url = 'https://gitcode.com'
    try {
      await openExternal(url)
    } catch {
      // 环境未配置默认浏览器时降级：复制链接并提示手动打开
      try {
        await writeClipboardText(url)
        toast.info('已复制 GitCode 链接，请在浏览器中粘贴打开')
      } catch {
        toast.error('无法打开浏览器，请手动访问 https://gitcode.com')
      }
    }
  }

  if (!form) return null

  return (
    <div className={styles['settings-section']}>
      <h3 data-app-ui-section-title>云同步</h3>

      <div className={styles['cloud-guide']}>
        <button
          type="button"
          className={styles['cloud-guide-toggle']}
          onClick={() => setGuideOpen((v) => !v)}
        >
          <span>新手引导 · 准备 GitCode 仓库（只需一次）</span>
          <span className={styles['cloud-guide-toggle-hint']}>{guideOpen ? '收起' : '展开'}</span>
        </button>
        {guideOpen && (
          <div className={styles['cloud-guide-body']}>
            <ol className={styles['cloud-guide-steps']}>
              <li>
                <strong>注册账号</strong>
                <span>打开 GitCode（gitcode.com），用邮箱或手机号注册并登录。</span>
              </li>
              <li>
                <strong>创建私有仓库</strong>
                <span>
                  登录后点「新建项目」，仓库名随意（如 lumii-sync），可见性务必选「
                  <strong>私有 Private</strong>
                  」，创建后复制仓库地址（形如 https://gitcode.com/你的用户名/仓库名.git）。
                </span>
              </li>
              <li>
                <strong>生成访问令牌</strong>
                <span>
                  点右上角头像 →「个人设置」→「访问令牌 / Access Tokens」→「新建令牌」，勾选
                  <strong>读写仓库</strong>
                  （read_repository + write_repository）权限，生成后立即复制令牌（令牌只显示这一次）。
                </span>
              </li>
            </ol>
            <div className={styles['cloud-guide-actions']}>
              <Button
                variant="secondary"
                onClick={() => void openGitCode()}
              >
                打开 GitCode
              </Button>
            </div>
            <p className={styles['cloud-guide-tip']}>
              回来后：把仓库地址填入「仓库地址」、令牌填入「访问令牌 (Token)」，点「测试连接」，成功后点「保存配置」并打开「启用云同步」。
            </p>
          </div>
        )}
      </div>

      <div className={styles['setting-group']}>
        <div className={styles['setting-item']}>
          <label className={styles['setting-label']} data-app-ui-label>启用云同步</label>
          <div className={styles['setting-hint']}>
            通过 GitCode 私有仓库在多设备间静默同步工作空间文件（排除 projects/temp 及 .gitignore 项）。
          </div>
          <Switch checked={form.enabled} onChange={(v) => setForm({ ...form, enabled: v })} />
        </div>

        <div className={styles['setting-item']}>
          <label className={styles['setting-label']} data-app-ui-label>平台</label>
          <Select
            value={form.provider}
            onChange={(e) => setForm({ ...form, provider: e.target.value as CloudSyncConfigView['provider'] })}
            options={[
              { value: 'gitcode', label: 'GitCode' },
              { value: 'github', label: 'GitHub（即将支持）', disabled: true },
              { value: 'gitee', label: 'Gitee（即将支持）', disabled: true },
            ]}
          />
        </div>

        <div className={styles['setting-item']}>
          <label className={styles['setting-label']} data-app-ui-label>仓库地址</label>
          <div className={styles['setting-hint']}>形如 https://gitcode.com/用户名/仓库名.git</div>
          <Input
            value={form.repoUrl}
            onChange={(e) => setForm({ ...form, repoUrl: e.target.value })}
            placeholder="https://gitcode.com/alice/notes.git"
          />
        </div>

        <div className={styles['setting-item']}>
          <label className={styles['setting-label']} data-app-ui-label>访问令牌 (Token)</label>
          <div className={styles['setting-hint']}>
            {form.tokenMasked ? `当前已保存：${form.tokenMasked}（留空则沿用）` : '用于私有仓库认证，加密存储'}
          </div>
          <Input
            type="password"
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder={form.tokenMasked ? '留空沿用已保存令牌' : '粘贴访问令牌'}
          />
        </div>

        <div className={styles['setting-row']}>
          <div className={styles['setting-item']}>
            <label className={styles['setting-label']} data-app-ui-label>分支</label>
            <Input value={form.branch} onChange={(e) => setForm({ ...form, branch: e.target.value })} />
          </div>
          <div className={styles['setting-item']}>
            <label className={styles['setting-label']} data-app-ui-label>同步间隔（分钟）</label>
            <Input
              type="number"
              value={form.intervalMinutes}
              onChange={(e) => setForm({ ...form, intervalMinutes: Number(e.target.value) || 15 })}
            />
          </div>
        </div>
      </div>

      <div className={styles['setting-row']}>
        <Button onClick={test} loading={testing} disabled={!form.repoUrl}>
          测试连接
        </Button>
        <Button variant="secondary" onClick={syncNow} loading={syncing} disabled={!form.enabled}>
          立即同步
        </Button>
        <Button onClick={save} loading={saving}>
          保存配置
        </Button>
      </div>

      {status && (
        <div className={styles['setting-item']}>
          <label className={styles['setting-label']} data-app-ui-label>同步状态</label>
          <div className={styles['setting-hint']}>
            {/* 排队中单独显示：state 仍是 idle（排队不是「引擎在跑」），
                只靠 message 会被读成「空闲 · 一切正常」，看不出请求还没轮到 */}
            {status.queuedBehind ? (
              <>当前状态：排队中 · {status.message}</>
            ) : (
              <>
                当前状态：{STATE_LABEL[status.state] ?? status.state}
                {status.message ? ` · ${status.message}` : ''}
              </>
            )}
            {status.lastSyncAt ? ` · 最近同步：${new Date(status.lastSyncAt).toLocaleString()}` : ''}
          </div>
          {status.state === 'error' && status.lastError && (
            <div className={styles['setting-hint']}>错误：{status.lastError}</div>
          )}
          {status.state === 'conflict' && status.conflict && (
            <div className={styles['setting-hint']}>
              冲突文件（{status.conflict.files.length}）：{status.conflict.files.join('、')}
            </div>
          )}
          {largeStats && largeStats.pendingFiles > 0 && (
            <div className={styles['setting-hint']}>
              大文件待传：{largeStats.pendingFiles} 个 ·{' '}
              {(largeStats.pendingBytes / 1048576).toFixed(1)} MB
              {largeStats.pumping ? ' · 传输中…' : ' · 等待下一轮同步'}
            </div>
          )}
          {status.state === 'conflict' && (
            <div style={{ marginTop: 8 }}>
              <Button variant="secondary" onClick={retryConflict} loading={retrying}>
                Agent 处理冲突
              </Button>
            </div>
          )}
        </div>
      )}

      {pendingDelete && (
        <div className={styles['setting-item']}>
          <label className={styles['setting-label']} data-app-ui-label>
            批量删除待确认
          </label>
          <div className={styles['setting-hint']}>
            源目录中有 {pendingDelete.count} 个文件在云端存在、本地已不存在，同步会把它们从云端一并删除。
            已被安全阀挡下、尚未执行。若不是你有意删除，请先检查工作空间（可能是同步异常，或某台设备数据不全）。
          </div>
          <div style={{ marginTop: 8 }}>
            <Button
              variant="secondary"
              onClick={() => void confirmMassDelete(pendingDelete.fingerprint)}
              loading={confirmingDelete}
            >
              确认删除 {pendingDelete.count} 项
            </Button>
          </div>
        </div>
      )}

      <div className={styles['setting-item']}>
        <label className={styles['setting-label']} data-app-ui-label>同步日志</label>
        {logs.length === 0 ? (
          <div className={styles['setting-hint']}>暂无同步记录</div>
        ) : (
          <div className={styles['cloud-log-list']}>
            {logs
              .slice()
              .reverse()
              .map((log, i) => (
                <div key={`${log.ts}-${i}`} className={styles['cloud-log-item']}>
                  <span className={styles['cloud-log-time']}>
                    {new Date(log.ts).toLocaleString()}
                  </span>
                  <span
                    className={`${styles['cloud-log-state']} ${styles[`cloud-log-state-${log.state}`]}`}
                  >
                    {STATE_LABEL[log.state] ?? log.state}
                  </span>
                  <span className={styles['cloud-log-msg']}>{log.message}</span>
                </div>
              ))}
          </div>
        )}
      </div>

      <p className={styles['settings-note']}>
        冲突由 Agent 通过 resolve_sync_conflict 工具解决；后台静默同步，不弹窗打扰。
      </p>
    </div>
  )
}
