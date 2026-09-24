/**
 * NewsPreferencesPanel — 资讯偏好的**检视**面板。
 *
 * 解决的问题：规则写下去之后，界面上完全看不见它会命中什么。用户只能等下一轮推送，
 * 看「少推 X」到底有没有生效——这正是 NewsBlur 说的「盲选」，也是规则训歪的唯一来源。
 *
 * 这个面板同时充当两件事的**同一个视图**：
 * - 写规则前的**预览**：这条规则会碰到哪些历史条目
 * - 规则写下去后的**日志**：它现在还能命中多少篇
 *
 * 两条边界要在界面上说清楚，否则用户会得出错误结论：
 * 1. **命中 ≠ 会被拦下**——大部分命中是规则写下**之前**就已经推出去的。
 *    把这两件事混起来，会让人以为「规则根本没生效」。
 * 2. **只对确定值开放**——「融资」「36氪」能匹；「标题党」这类判断式描述匹不了，
 *    没命中不代表这条规则没用。
 */

import React, { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, SlidersHorizontal } from 'lucide-react'
import { Modal } from '../../../../components/ui/Modal/Modal'
import { Loading } from '../../../../components/ui/Loading/Loading'
import styles from './NewsPreferencesPanel.module.css'

interface RuleHit {
  title: string
  source: string
  timestamp: number
}

interface RuleMatch {
  field: string
  value: string
  count: number
  hits: readonly RuleHit[]
}

interface Inspection {
  itemCount: number
  prioritySummary: string
  rules: readonly RuleMatch[]
  nonMatchable: readonly { field: string; values: readonly string[] }[]
}

export interface NewsPreferencesPanelProps {
  open: boolean
  onClose: () => void
}

/** 紧凑日期：同年只显示月-日 */
function formatDay(ts: number): string {
  if (!ts) return ''
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() === new Date().getFullYear()
    ? `${mm}-${dd}`
    : `${d.getFullYear()}-${mm}-${dd}`
}

export const NewsPreferencesPanel: React.FC<NewsPreferencesPanelProps> = ({ open, onClose }) => {
  const [data, setData] = useState<Inspection | null>(null)
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async () => {
    setFailed(false)
    setData(null)
    try {
      const result = (await window.electronAPI.agentRuntime.sendCommand({
        type: 'news-preference:preview',
      })) as Inspection
      setData(result)
    } catch {
      setFailed(true)
    }
  }, [])

  useEffect(() => {
    if (open) void load()
  }, [open, load])

  return (
    <Modal open={open} onClose={onClose} title="资讯偏好" width={560}>
      {failed ? (
        <div className={styles.note}>偏好读取失败，稍后重试。</div>
      ) : data === null ? (
        <Loading text="读取偏好中..." />
      ) : (
        <div className={styles.body}>
          {/* 裁决顺序放在最上面：冲突时谁说了算，是最该先看到的一条信息 */}
          <div className={styles.priority}>
            <SlidersHorizontal size={13} strokeWidth={1.8} />
            <span>同时命中时的裁决顺序：{data.prioritySummary}</span>
          </div>

          {data.rules.length === 0 ? (
            <div className={styles.note}>
              还没有记过任何「关注 / 少推 / 来源偏好」。跟 Lumii 说「以后少推 XX」即可记下。
            </div>
          ) : (
            <>
              <div className={styles.hint}>
                下面每条规则都拿去和<strong>已推的 {data.itemCount} 条</strong>历史做过匹配。
              </div>
              <ul className={styles.list}>
                {data.rules.map((rule) => {
                  const key = `${rule.field}:${rule.value}`
                  const isOpen = expanded === key
                  return (
                    <li key={key} className={styles.rule}>
                      <button
                        type="button"
                        className={styles.ruleHead}
                        onClick={() => setExpanded(isOpen ? null : key)}
                        aria-expanded={isOpen}
                        disabled={rule.count === 0}
                      >
                        {rule.count > 0 ? (
                          isOpen ? (
                            <ChevronDown size={13} strokeWidth={2} />
                          ) : (
                            <ChevronRight size={13} strokeWidth={2} />
                          )
                        ) : (
                          <span className={styles.spacer} />
                        )}
                        <span className={styles.field}>{rule.field}</span>
                        <span className={styles.value}>{rule.value}</span>
                        <span
                          className={rule.count > 0 ? styles.count : styles.countZero}
                        >
                          {rule.count > 0 ? `会命中 ${rule.count} 篇` : '历史里没命中'}
                        </span>
                      </button>

                      {isOpen && rule.count > 0 && (
                        <ul className={styles.hits}>
                          {rule.hits.map((hit, i) => (
                            <li key={`${hit.title}-${i}`} className={styles.hit}>
                              <span className={styles.hitDay}>{formatDay(hit.timestamp)}</span>
                              <span className={styles.hitTitle}>{hit.title}</span>
                              {hit.source && <span className={styles.hitSource}>{hit.source}</span>}
                            </li>
                          ))}
                          {rule.count > rule.hits.length && (
                            <li className={styles.hitMore}>
                              另有 {rule.count - rule.hits.length} 篇未列出
                            </li>
                          )}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            </>
          )}

          {data.nonMatchable.map(({ field, values }) => (
            <div key={field} className={styles.note}>
              {field}：{values.length > 0 ? values.join('、') : '（未设置）'}
              <span className={styles.noteWhy}>—— 时间窗，没法用关键词预览命中</span>
            </div>
          ))}

          {/* 这两句是防误判的，不是免责声明：没有它们，用户会把
              「命中 12 篇」读成「有 12 篇本该被拦下来却没拦」 */}
          <div className={styles.caveat}>
            <p>
              <strong>命中不等于会被拦下。</strong>
              这里回答的是「规则现在生效的话，历史上这些条目会被它碰到」。
              大多数命中是规则写下**之前**就已经推出去的。
            </p>
            <p>
              <strong>只对确定值开放。</strong>
              「融资」「36氪」这类能写成关键词的可以预览；「标题党」「太水了」这类判断，
              只能交给情报每轮自己斟酌——<strong>没命中不代表这条规则没用</strong>。
            </p>
          </div>
        </div>
      )}
    </Modal>
  )
}
