/**
 * ArtifactInspector — 选中产物的规格 + 版本历史（工作台右栏）
 *
 * 版本历史来自主进程 `artifact:history`（扫全会话，不只已加载的 60 条）；
 * 未返回前先用台账里已加载的版本顶上，并用 `partial` 明示「可能只到已加载的那一段」。
 * 每版给「回到消息」——用户的问题常常是「这张图是哪一轮改出来的」。
 */

import React, { useEffect, useState } from 'react'
import clsx from 'clsx'
import { CornerUpLeft, Loader2 } from 'lucide-react'
import type { Artifact, ArtifactVersion } from './ledger'
import { formatClock } from './ledger'
import { formatBytes } from './ArtifactFoldRow'
import { writeClipboardText } from '../../../../services/clipboard-service'
import { isTextArtifactPath } from '../../../../../shared/artifact-rules'
import styles from './WorkspaceArtifactsPanel.module.css'

const KIND_LABEL: Record<Artifact['kind'], string> = {
  image: '图片',
  'image-set': '图集',
  video: '视频',
  audio: '音频',
  doc: '文档',
  slides: '幻灯片',
  sheet: '表格',
  site: '网页',
  code: '代码',
  archive: '压缩包',
  other: '文件',
}

const STATUS_LABEL: Record<ArtifactVersion['status'], string> = {
  added: '新增',
  modified: '修改',
  deleted: '删除',
  edited: '本地编辑',
}

export interface ArtifactInspectorProps {
  artifact: Artifact
  /** 产物所属会话；缺省时按当前会话查（台账里的产物默认来自当前会话） */
  sessionKey?: string
  /** 台账里已加载的版本（时间正序），用作全量结果返回前的占位 */
  versions?: readonly ArtifactVersion[]
  onGoToTurn: (turnId: string) => void
  /** 与该版的前一版做文本 diff（两版内容都可取时才显示入口） */
  onShowDiff?: (version: ArtifactVersion, previous: ArtifactVersion) => void
  /** 只读预览某一版内容 */
  onPreviewVersion?: (version: ArtifactVersion) => void
  onClose?: () => void
}

interface HistoryState {
  versions: readonly ArtifactVersion[]
  /** 是否来自已加载台账（不足以代表全会话） */
  partial: boolean
  loading: boolean
  error?: string
}

/** 从 `details.artifacts.meta` / 侧车里挑出给人看的规格行 */
function specRows(artifact: Artifact): Array<{ label: string; value: string }> {
  const meta = artifact.meta ?? {}
  const rows: Array<{ label: string; value: string }> = [{ label: '类型', value: KIND_LABEL[artifact.kind] }]
  if (meta.width && meta.height) rows.push({ label: '尺寸', value: `${meta.width}×${meta.height}` })
  if (meta.durationSec !== undefined) rows.push({ label: '时长', value: `${Math.round(meta.durationSec)} 秒` })
  if (meta.pages !== undefined) rows.push({ label: '页数', value: `${meta.pages} 页` })
  if (meta.words !== undefined) rows.push({ label: '字数', value: `${meta.words} 字` })
  const bytes = formatBytes(meta.bytes)
  if (bytes) rows.push({ label: '大小', value: bytes })
  if (meta.model) rows.push({ label: '模型', value: meta.model })
  if (artifact.derivedFrom) {
    rows.push({ label: '来源', value: `变体 · 来自 ${fileNameOf(artifact.derivedFrom)}` })
  }
  if (artifact.sourceTool) rows.push({ label: '来源工具', value: artifact.sourceTool })
  rows.push({ label: '最近写入', value: formatClock(artifact.timestamp) })
  return rows
}

function fileNameOf(filePath: string): string {
  return filePath.split('/').pop() ?? filePath
}

/** 可直接复制的提示词行：原始 prompt 与模型改写后的 prompt 分开标 */
function promptRows(artifact: Artifact): Array<{ label: string; value: string }> {
  const meta = artifact.meta
  if (!meta) return []
  const rows: Array<{ label: string; value: string }> = []
  const source = meta.sourcePrompt?.trim()
  const revised = meta.prompt?.trim()
  if (source) rows.push({ label: '原始提示词', value: source })
  // 模型没改写时两段一模一样，只留一段，别糊两面重复的墙
  if (revised && revised !== source) {
    rows.push({ label: '改写后提示词（模型）', value: revised })
  }
  return rows
}

/** meta.params 里的标量以 chip 展示；没有就不显示 */
function paramChips(artifact: Artifact): Array<{ key: string; value: string }> {
  const params = artifact.meta?.params
  if (!params) return []
  return Object.entries(params).map(([key, value]) => ({ key, value: String(value) }))
}

export const ArtifactInspector: React.FC<ArtifactInspectorProps> = ({
  artifact,
  sessionKey,
  versions,
  onGoToTurn,
  onShowDiff,
  onPreviewVersion,
  onClose,
}) => {
  const fallback = versions ?? []
  const [history, setHistory] = useState<HistoryState>({
    versions: fallback,
    partial: true,
    loading: true,
  })
  /** 复制反馈：记录刚复制的提示词标签，1.5s 后复位 */
  const [copiedLabel, setCopiedLabel] = useState<string | null>(null)
  const targetSession = artifact.conversationId ?? sessionKey

  useEffect(() => {
    const api = window.electronAPI?.agentRuntime
    if (!api?.sendCommand || !targetSession) {
      setHistory({ versions: fallback, partial: true, loading: false })
      return
    }
    let cancelled = false
    setHistory({ versions: fallback, partial: true, loading: true })
    void api
      .sendCommand({
        type: 'artifact:history',
        sessionKey: targetSession,
        path: artifact.path,
      })
      .then((raw) => {
        if (cancelled) return
        const result = raw as { versions?: unknown } | undefined
        const list = Array.isArray(result?.versions) ? result.versions : []
        setHistory({
          versions: list as ArtifactVersion[],
          partial: false,
          loading: false,
        })
      })
      .catch((err: unknown) => {
        if (cancelled) return
        // 主进程查不到（会话已删/库损坏）时退回台账：有数据总比空面板强
        setHistory({
          versions: fallback,
          partial: true,
          loading: false,
          error: err instanceof Error ? err.message : '读取版本历史失败',
        })
      })
    return () => {
      cancelled = true
    }
    // 换产物/换会话才重查；fallback 是台账引用，变了也不该打断本次请求
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [artifact.path, targetSession])

  const specs = specRows(artifact)
  const prompts = promptRows(artifact)
  const chips = paramChips(artifact)
  const shown = history.versions.length > 0 ? history.versions : fallback

  /** 一次性复制「复现这张图」需要的全部参数（尺寸/模型/提示词） */
  const paramBlock = (): string => {
    const lines = specs
      .filter((row) => row.label !== '最近写入' && row.label !== '来源工具' && row.label !== '来源')
      .map((row) => `${row.label}：${row.value}`)
    for (const row of prompts) lines.push(`${row.label}：${row.value}`)
    for (const chip of chips) lines.push(`${chip.key}：${chip.value}`)
    return lines.join('\n')
  }

  const copyPrompt = (label: string, value: string): void => {
    void writeClipboardText(value)
      .then(() => {
        setCopiedLabel(label)
        window.setTimeout(() => {
          setCopiedLabel((current) => (current === label ? null : current))
        }, 1500)
      })
      .catch(() => undefined)
  }

  return (
    <aside className={styles.inspector} aria-label="产物信息">
      <header className={styles.inspectorHead}>
        <span className={styles.inspectorTitle} title={artifact.title ?? artifact.path}>
          {artifact.title ?? artifact.path.split('/').pop() ?? artifact.path}
        </span>
        {onClose && (
          <button
            type="button"
            className={styles.inspectorClose}
            onClick={onClose}
            title="收起信息"
            aria-label="收起信息"
          >
            ×
          </button>
        )}
      </header>

      <div className={styles.inspectorBody}>
        <section className={styles.inspectorSection}>
          <div className={styles.inspectorSectionTitle}>规格</div>
          <dl className={styles.specList}>
            {specs.map((row) => (
              <div key={row.label} className={styles.specRow}>
                <dt>{row.label}</dt>
                <dd title={row.value}>{row.value}</dd>
              </div>
            ))}
          </dl>
          {chips.length > 0 && (
            <div className={styles.paramChips}>
              {chips.map((chip) => (
                <span
                  key={chip.key}
                  className={styles.paramChip}
                  title={`${chip.key} = ${chip.value}`}
                >
                  {chip.key}: {chip.value}
                </span>
              ))}
            </div>
          )}
          {prompts.map((row) => (
            <div key={row.label} className={styles.promptRow}>
              <div className={styles.promptHead}>
                <span className={styles.promptLabel}>{row.label}</span>
                <button
                  type="button"
                  className={styles.promptCopy}
                  onClick={() => copyPrompt(row.label, row.value)}
                  title="复制到剪贴板"
                >
                  {copiedLabel === row.label ? '已复制' : '复制'}
                </button>
              </div>
              <p className={styles.promptText} title={row.value}>
                {row.value}
              </p>
            </div>
          ))}
          {prompts.length > 0 && (
            <button
              type="button"
              className={styles.copyAllParams}
              onClick={() => copyPrompt('__all__', paramBlock())}
            >
              {copiedLabel === '__all__' ? '已复制全部参数' : '复制全部参数'}
            </button>
          )}
          {artifact.kind === 'image' && prompts.length > 0 && (
            <div className={styles.inspectorNote}>
              本机图片模型不支持 seed；每次生成会新增一份文件。
            </div>
          )}
          <div className={styles.specPath} title={artifact.path}>
            {artifact.path}
          </div>
        </section>

        <section className={styles.inspectorSection}>
          <div className={styles.inspectorSectionTitle}>
            版本
            <span className={styles.versionCount}>
              {history.loading && <Loader2 size={11} className={styles.spin} aria-hidden="true" />}
              {shown.length > 0 ? ` ${shown.length} 个` : ' 暂无'}
            </span>
          </div>
          {history.partial && shown.length > 0 && (
            <div className={styles.inspectorNote}>
              只含已加载的消息；更早的版本会在主进程返回后补全。
            </div>
          )}
          {history.error && (
            <div className={styles.inspectorError}>版本历史读取失败：{history.error}</div>
          )}
          {shown.length === 0 ? (
            <div className={styles.inspectorNote}>这个文件还没有记录到写入历史。</div>
          ) : (
            <ol className={styles.versionList}>
              {shown.map((version, index) => {
                const number = index + 1
                const previous = index > 0 ? shown[index - 1] : undefined
                // 最新一版就是文件现在的内容（版本列表按时间正序）
                const isCurrent = index === shown.length - 1 && version.status !== 'deleted'
                const contentAvailable = version.content?.available === true
                // 文本/代码才有「逐行差异」与内联预览；图片/PPT 的版本对照在 T6
                const textArtifact = isTextArtifactPath(artifact.path)
                const canDiff = Boolean(
                  textArtifact &&
                    onShowDiff &&
                    previous &&
                    contentAvailable &&
                    previous.content?.available === true,
                )
                const sourceLabel = version.source === 'local' ? '本地' : 'Agent'
                return (
                  <li
                    key={version.versionId ?? `${version.turnId ?? 'v'}-${version.timestamp}`}
                    className={clsx(styles.versionRow, isCurrent && styles.versionRowCurrent)}
                  >
                    <span className={styles.versionBadge}>{number}</span>
                    <span className={styles.versionTime}>{formatClock(version.timestamp)}</span>
                    <span
                      className={clsx(
                        styles.versionStatus,
                        version.status === 'deleted' && styles.versionStatusDeleted,
                      )}
                    >
                      {STATUS_LABEL[version.status]}
                    </span>
                    <span className={styles.versionSource}>{sourceLabel}</span>
                    <span className={styles.versionActions}>
                      {canDiff && previous && (
                        <button
                          type="button"
                          className={styles.versionGo}
                          onClick={() => onShowDiff?.(version, previous)}
                          title="与上一版逐行对比"
                        >
                          差异
                        </button>
                      )}
                      {onPreviewVersion && contentAvailable && textArtifact && (
                        <button
                          type="button"
                          className={styles.versionGo}
                          onClick={() => onPreviewVersion(version)}
                          title="只读预览这一版"
                        >
                          预览
                        </button>
                      )}
                      {version.turnId && (
                        <button
                          type="button"
                          className={styles.versionGo}
                          onClick={() => onGoToTurn(version.turnId!)}
                          title="回到产生这一版的那条消息"
                        >
                          <CornerUpLeft size={11} strokeWidth={2} />
                          回到消息
                        </button>
                      )}
                      {!contentAvailable && version.content?.reason && (
                        <span className={styles.versionUnavailable} title={version.content.reason}>
                          内容未保留
                        </span>
                      )}
                    </span>
                  </li>
                )
              })}
            </ol>
          )}
        </section>

        <div className={styles.inspectorFootnote}>
          「回到消息」只定位聊天记录，不会修改文件。
        </div>
      </div>
    </aside>
  )
}
