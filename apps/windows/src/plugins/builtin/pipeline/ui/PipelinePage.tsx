/**
 * 流水线管理页（对照原型 §一）：左清单 + 右侧详情。
 *
 * 四条取舍：
 * - **管理是低频操作，不占主界面**：它是一整页（`app.view`），不是首页卡片。
 * - **这里不执行**：流水线由 Agent 跑（设计 §4.0「流水线是资产，Agent 是执行者」）。
 *   页面只提供一个「在对话里运行」的按钮，把话术预填进输入框——执行归属、权限归属
 *   都记在发起它的那个会话上，不会凭空多出第二条执行通道。
 * - 步骤行展示 `no / 名称 / 工具或 Agent / holdMs`，与 spec 一一对应。
 * - 样式只用 `--mt-*` 令牌，三个主题块才同时成立（不写死色值）。
 */
import { useMemo } from 'react'
import { FolderOpen, AlertTriangle, MessageSquare } from 'lucide-react'
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

export function PipelinePage({ onViewChange }: { onViewChange?: (view: string) => void } = {}) {
  const { items, selectedId, select, detail, error, progress } = usePipelines()

  const selected: PipelineSummary | undefined = useMemo(
    () => items?.find((p) => p.id === selectedId),
    [items, selectedId],
  )
  /** 正在跑的进度（由 Agent 在对话里发起的那次 run；页面只观察） */
  const runningEntry = useMemo(() => {
    if (!selectedId) return undefined
    return Object.values(progress).find((e) => e.stepId)
  }, [progress, selectedId])

  /**
   * 把「跑流水线 X」预填进对话输入框。
   *
   * 复用宿主已有的草稿通道（`mtbot:chat-draft-request`），不新造执行 IPC：
   * 流水线必须由 Agent 调 `pipeline_run` 执行，页面只负责把用户送到对话里。
   */
  const askInChat = () => {
    if (!selectedId) return
    window.dispatchEvent(
      new CustomEvent('mtbot:chat-draft-request', {
        detail: { text: `跑流水线 ${selectedId}` },
      }),
    )
    onViewChange?.('chat')
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
                        <span className={styles.stepTool}>
                          {s.kind === 'agent' ? `Agent · ${s.agentType ?? 'assistant'}` : s.tool}
                        </span>
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
                    <button className={styles.btnPrimary} onClick={askInChat}>
                      <MessageSquare size={14} /> 在对话里运行
                    </button>
                    <button className={styles.btnGhost} onClick={() => openDir('run')}>
                      <FolderOpen size={14} /> 打开上次 run 目录
                    </button>
                  </div>
                  <div className={styles.hint}>
                    流水线由 Agent 执行，不由这个页面执行——点上面把「跑流水线 {selected.id}」填进对话，
                    确认后发送。要用彩排还是录制，在对话里说清楚即可。
                  </div>
                </div>

                <div className={styles.colTitle}>历史 run</div>
                <div className={styles.runs}>
                  {(detail?.runs ?? []).length === 0 ? (
                    <div className={styles.runEmpty}>还没有运行记录 —— 去对话里跑一次</div>
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
