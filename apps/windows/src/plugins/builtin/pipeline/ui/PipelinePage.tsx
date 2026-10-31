/**
 * 流水线管理页（对照原型 §一）：左清单 + 右侧详情。
 *
 * 三条取舍：
 * - **管理是低频操作，不占主界面**：它是一整页（`app.view`），不是首页卡片；
 *   用户真正发起流水线的地方是对话（时间线卡）。
 * - 步骤行展示 `no / 名称 / 工具 / holdMs`，与 spec 一一对应——改 spec 后重载即可见。
 * - 样式只用 `--mt-*` 令牌，三个主题块才同时成立（不写死色值）。
 */
import { useMemo, useState } from 'react'
import { Play, RotateCcw, FolderOpen, AlertTriangle } from 'lucide-react'
import clsx from 'clsx'
import { Loading } from '../../../../renderer/components/ui/Loading/Loading'
import { Empty } from '../../../../renderer/components/ui/Empty/Empty'
import { usePipelines, type PipelineSummary, type StepView } from './usePipelines'
import styles from './PipelinePage.module.css'

function fmtAgo(ts?: number): string {
  if (!ts) return '未跑过'
  const diff = Date.now() - ts
  const m = Math.floor(diff / 60000)
  if (m < 1) return '刚刚'
  if (m < 60) return `${m} 分钟前`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h} 小时前`
  return `${Math.floor(h / 24)} 天前`
}

function stepOf(detail: { spec: { steps: StepView[] } } | null, id: string): StepView | undefined {
  return detail?.spec.steps.find((s) => s.id === id)
}

export function PipelinePage() {
  const { items, selectedId, select, detail, error, progress, run } = usePipelines()
  const [busy, setBusy] = useState<string | null>(null)
  const [lastResult, setLastResult] = useState<{ id: string; ok: boolean; error?: string } | null>(null)

  const selected: PipelineSummary | undefined = useMemo(
    () => items?.find((p) => p.id === selectedId),
    [items, selectedId],
  )
  const runningEntry = useMemo(() => {
    if (!selectedId) return undefined
    return Object.values(progress).find((e) => e.stepId && busy === selectedId)
  }, [progress, selectedId, busy])

  const doRun = async (id: string, mode: 'record' | 'rehearsal') => {
    setBusy(id)
    setLastResult(null)
    try {
      const r = (await run(id, mode)) as { ok?: boolean; error?: string }
      setLastResult({ id, ok: Boolean(r?.ok), error: r?.error })
    } catch (err) {
      setLastResult({ id, ok: false, error: err instanceof Error ? err.message : String(err) })
    } finally {
      setBusy(null)
    }
  }

  const openDir = async (target: 'spec' | 'run') => {
    if (!selectedId) return
    const api = (window as unknown as { electronAPI?: { pipeline?: { openDir: (a: unknown) => Promise<unknown> } } })
      .electronAPI?.pipeline
    try {
      await api?.openDir({ target, id: selectedId })
    } catch {
      /* 打开目录失败不阻断页面 */
    }
  }

  if (items === null) return <Loading text="加载流水线…" />
  if (error) return <Empty description={error} />
  if (items.length === 0) {
    return (
      <Empty
        description={
          '还没有流水线。在 {workspace}/pipelines/<id>/spec.json 写一份，或让 Agent 用 pipeline_draft 从一次成功轨迹固化成草稿。'
        }
      />
    )
  }

  return (
    <div className={styles.layout}>
      {/* 左：清单 */}
      <aside className={styles.list}>
        <div className={styles.listHead}>
          <div className={styles.row1}>
            <b>流水线</b>
            <span className={styles.spacer} />
            <button className={styles.iconBtn} title="打开 pipelines 目录" onClick={() => openDir('spec')}>
              <FolderOpen size={14} />
            </button>
          </div>
        </div>
        <div className={styles.items}>
          {items.map((p) => (
            <button
              key={p.id}
              className={clsx(styles.item, p.id === selectedId && styles.itemActive)}
              onClick={() => select(p.id)}
            >
              <div className={styles.itemTitle}>
                <span>{p.name ?? p.id}</span>
                <span className={styles.spacer} />
                {p.error ? (
                  <span className={clsx(styles.badge, styles.badgeRed)}>spec 坏了</span>
                ) : p.lastRun ? (
                  <span className={clsx(styles.badge, p.lastRun.ok ? styles.badgeGreen : styles.badgeRed)}>
                    {p.lastRun.ok ? '成功' : '失败'}
                  </span>
                ) : (
                  <span className={styles.badge}>未跑过</span>
                )}
              </div>
              <div className={styles.itemMeta}>
                <span>{p.error ? '校验失败' : `${p.stepCount} 步 · ${p.narrationCount} 段旁白`}</span>
                {!p.error && <span>· {fmtAgo(p.lastRun?.at)}</span>}
              </div>
            </button>
          ))}
        </div>
        <div className={styles.listFoot}>
          <span>{items.length} 条 · workspace/pipelines/</span>
        </div>
      </aside>

      {/* 右：详情 */}
      <main className={styles.main}>
        {!selected ? (
          <Empty description="左侧选一条流水线" />
        ) : selected.error ? (
          <div className={styles.broken}>
            <AlertTriangle size={18} />
            <div>
              <h2>{selected.id}</h2>
              <p>这份 spec 加载失败，修好 spec.json 后刷新：</p>
              <pre>{selected.error}</pre>
            </div>
          </div>
        ) : (
          <>
            <div className={styles.head}>
              <div className={styles.titleRow}>
                <h2>{selected.name ?? selected.id}</h2>
                <span className={styles.spacer} />
                <button className={styles.btnGhost} onClick={() => openDir('spec')}>
                  打开 spec 目录
                </button>
              </div>
              {selected.description && <div className={styles.desc}>{selected.description}</div>}
              <div className={styles.meta}>
                <span>{selected.stepCount} 步</span>
                <span>{selected.narrationCount} 段旁白</span>
                {selected.lastRun && <span>上次 {fmtAgo(selected.lastRun.at)}</span>}
              </div>
              {runningEntry && (
                <div className={styles.progress}>
                  正在跑第 {runningEntry.i + 1}/{runningEntry.total} 步：{runningEntry.label ?? runningEntry.stepId}
                </div>
              )}
              {lastResult && lastResult.id === selected.id && !lastResult.ok && (
                <div className={styles.failed}>{lastResult.error ?? '运行失败'}</div>
              )}
            </div>

            <div className={styles.body}>
              <div className={styles.col}>
                <div className={styles.colTitle}>步骤</div>
                <div className={styles.steps}>
                  {(detail?.spec.steps ?? []).map((s, i) => {
                    const jl = detail?.lastJournal?.find((l) => l.id === s.id)
                    return (
                      <div
                        key={s.id}
                        className={clsx(
                          styles.stepRow,
                          !s.narration && styles.stepNoNarr,
                          jl && !jl.ok && styles.stepFailed,
                        )}
                      >
                        <span className={styles.stepNo}>{i + 1}</span>
                        <span className={styles.stepLbl}>
                          <span className={styles.stepName}>{s.label ?? s.id}</span>
                          {jl?.error && <span className={styles.stepErr}>{jl.error.slice(0, 80)}</span>}
                        </span>
                        <span className={styles.stepTool}>{s.tool}</span>
                        <span className={styles.stepHold}>{s.holdMs}ms</span>
                      </div>
                    )
                  })}
                </div>
                {detail?.lastJournal && detail.lastJournal.length > 0 && (
                  <div className={styles.assertBox}>
                    <div className={styles.assertTitle}>上次 run 的断言</div>
                    {detail.lastJournal.map((l) => (
                      <div key={l.id} className={styles.assertLine}>
                        <span className={styles.assertKey}>#{l.i + 1}</span>
                        <span>
                          {l.skipped
                            ? '彩排跳过（需授权）'
                            : l.ok
                              ? '通过'
                              : `失败：${typeof l.expected !== 'undefined' ? JSON.stringify(l.expected) : l.error ?? ''}`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              <div className={styles.col}>
                <div className={styles.actionsCard}>
                  <div className={styles.colTitle}>运行</div>
                  <div className={styles.btns}>
                    <button
                      className={styles.btnPrimary}
                      disabled={busy === selected.id}
                      onClick={() => void doRun(selected.id, 'record')}
                    >
                      <Play size={14} /> 录制运行
                    </button>
                    <button
                      className={styles.btnGhost}
                      disabled={busy === selected.id}
                      onClick={() => void doRun(selected.id, 'rehearsal')}
                    >
                      <RotateCcw size={14} /> 彩排（不录）
                    </button>
                  </div>
                  <div className={styles.hint}>
                    彩排不录屏、跳过需授权的工具，但仍会逐步校验断言——先彩排，绿了再录制。
                  </div>
                </div>

                <div className={styles.colTitle}>历史 run</div>
                <div className={styles.runs}>
                  {(detail?.runs ?? []).length === 0 ? (
                    <div className={styles.runEmpty}>还没有运行记录 —— 先跑一次彩排</div>
                  ) : (
                    detail!.runs.map((r) => (
                      <div key={r.runId} className={styles.runRow}>
                        <span
                          className={clsx(
                            styles.badge,
                            r.status === 'ok' ? styles.badgeGreen : r.status === 'failed' ? styles.badgeRed : '',
                          )}
                        >
                          {r.mode === 'rehearsal' ? '彩排' : '录制'}
                        </span>
                        <span className={styles.runWhen}>{fmtAgo(r.startedAt)}</span>
                        <span className={styles.spacer} />
                        <span className={styles.runStatus}>
                          {r.status === 'ok' ? '成功' : r.status === 'failed' ? '失败' : r.status ?? '—'}
                        </span>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </>
        )}
      </main>
    </div>
  )
}
