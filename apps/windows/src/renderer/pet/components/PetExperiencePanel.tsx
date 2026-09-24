/**
 * 「经历」Tab —— 整个设计的**证据页**（第七期 T7.6 / 设计 §8.4）
 *
 * ---------------------------------------------------------------------------
 * 为什么这一页值得单独存在
 * ---------------------------------------------------------------------------
 * 设计 §8.4 原话：「用户能在这里看到"它真的变了"，而不是只有一个模糊的感觉」。
 * 出生抽签、性格演化、做过的事——这三件事在此之前**全都发生了却不可见**：
 * 数值在库里（而 §3.6 明令不许给用户看数值），经历散在会话与目标表里。
 *
 * 所以这一页的职责是**把"它变了"翻译成人话**：
 * 不给五维数字，给两个标签的前后对比；不给 update_count，给"还是出生时的样子 /
 * 已经变过了"。
 *
 * ---------------------------------------------------------------------------
 * 纯 props、零 IPC
 * ---------------------------------------------------------------------------
 * 数据由 `PetModeShell` 从 `pet:experience:summary` 取来注入（控制坞一直是这个形态）。
 * 组件自己不拉数据，于是它可以在 jsdom 里被直接渲染。
 */

import React, { useState } from 'react'
import type { PetExperienceDTO } from '../../../shared/pet-mode'
import { traitLabel } from '@mtbot/pet-core'
import { light, dark, selectableText } from './pet-dock-theme'

export interface PetExperiencePanelProps {
  /**
   * 经历数据；`null` = 还读不到（bridge 没起、不在宠物模式）。
   *
   * **读不到时如实说"还读不到"，不编一个中性气质出来**（§4.1.6 的同一条纪律）。
   */
  experience: PetExperienceDTO | null
}

/** ISO 时刻 → 「9 月 24 日」（跨年时补上年份） */
function dayOf(iso: string): string {
  const t = Date.parse(iso)
  if (!Number.isFinite(t)) return iso.slice(0, 10)
  const d = new Date(t)
  const now = new Date()
  const md = `${d.getMonth() + 1} 月 ${d.getDate()} 日`
  return d.getFullYear() === now.getFullYear() ? md : `${d.getFullYear()} 年 ${md}`
}

/** 一个分区（小标题 + 内容） */
const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div style={{ marginBottom: 14 }}>
    <div
      style={{
        fontSize: 11,
        letterSpacing: 1,
        color: `${light(0.45)}`,
        marginBottom: 6,
        userSelect: 'none',
      }}
    >
      {title}
    </div>
    <div style={{ fontSize: 13, lineHeight: 1.7, color: `${light(0.82)}` }}>{children}</div>
  </div>
)

/** 次要说明（"它还是出生时的样子"这类） */
const hintStyle: React.CSSProperties = { fontSize: 12, color: `${light(0.5)}` }

const emptyStyle: React.CSSProperties = { fontSize: 12, color: `${light(0.35)}` }

export const PetExperiencePanel: React.FC<PetExperiencePanelProps> = ({ experience }) => {
  /** 展开的那篇日记（点日期那一行切换）。同时只展开一篇——这一页是给人扫的 */
  const [openDiary, setOpenDiary] = useState<string | null>(null)

  if (!experience) {
    return (
      <div style={{ padding: '16px', maxHeight: 320, overflowY: 'auto', ...selectableText }}>
        <div style={emptyStyle}>还读不到它的经历——它可能还没出生。</div>
      </div>
    )
  }

  const { birth, current, works, diaries } = experience

  return (
    <div style={{ padding: '12px 16px', maxHeight: 320, overflowY: 'auto', ...selectableText }}>
      <Section title="出生">
        {birth ? (
          <>
            <div>
              {birth.migrated ? '性格记录始于' : '它出生在'} {dayOf(birth.at)}
            </div>
            <div>那时的它：{traitLabel(birth.traits)}</div>
          </>
        ) : (
          <div style={emptyStyle}>还不知道它是从哪一天开始的</div>
        )}
      </Section>

      <Section title="现在">
        {current ? (
          <>
            <div>{traitLabel(current.traits)}</div>
            {/*
              变了没有：**只说"变了"，不说变了多少次**。
              `update_count` 是计数不是性格值，但它同样属于 §3.6 那条
              "用户不该看到数字"——这一页要的是感受，不是仪表盘。
            */}
            <div style={hintStyle}>
              {current.updateCount > 0
                ? `和出生时比，它已经变过了（最近一次在 ${dayOf(current.lastUpdated)}）`
                : '它还是出生时的样子'}
            </div>
          </>
        ) : (
          <div style={emptyStyle}>暂时读不到它的样子</div>
        )}
      </Section>

      <Section title="做过的事">
        {works.length === 0 ? (
          <div style={emptyStyle}>还没有做过什么。派它去看点东西试试？</div>
        ) : (
          works.map((w) => (
            <div key={w.id} style={{ marginBottom: 6 }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                <span
                  aria-hidden="true"
                  style={{ color: w.ok ? `${light(0.55)}` : 'rgba(255, 205, 120, 0.95)' }}
                >
                  {w.ok ? '·' : '×'}
                </span>
                <span style={{ flex: 1, minWidth: 0 }}>{w.description}</span>
                <span style={{ fontSize: 11, color: `${light(0.35)}`, whiteSpace: 'nowrap' }}>
                  {dayOf(w.at)}
                </span>
              </div>
              {/* 失败要说清楚为什么——把没办成说得像办成了是撒谎（设计 §7.1） */}
              {!w.ok && w.text && (
                <div style={{ ...hintStyle, marginLeft: 14 }}>{w.text.slice(0, 80)}</div>
              )}
            </div>
          ))
        )}
      </Section>

      <Section title="日记">
        {diaries.length === 0 ? (
          <div style={emptyStyle}>它还没写过日记（晚上会写）。</div>
        ) : (
          diaries.map((d) => {
            const open = openDiary === d.date
            return (
              <div key={d.date} style={{ marginBottom: 6 }}>
                <button
                  type="button"
                  onClick={() => setOpenDiary(open ? null : d.date)}
                  style={{
                    display: 'block',
                    width: '100%',
                    textAlign: 'left',
                    padding: '4px 8px',
                    borderRadius: 8,
                    border: `1px solid ${light(0.1)}`,
                    background: open ? `${light(0.08)}` : 'transparent',
                    color: `${light(0.7)}`,
                    fontSize: 12,
                    cursor: 'pointer',
                    font: 'inherit',
                  }}
                >
                  {dayOf(d.date)} {open ? '▾' : '▸'}
                </button>
                {open && (
                  <div
                    style={{
                      marginTop: 6,
                      padding: '8px 10px',
                      borderRadius: 8,
                      background: `${dark(0.28)}`,
                      fontSize: 12,
                      lineHeight: 1.8,
                      color: `${light(0.78)}`,
                      whiteSpace: 'pre-wrap',
                      ...selectableText,
                    }}
                  >
                    {d.content}
                  </div>
                )}
              </div>
            )
          })
        )}
      </Section>
    </div>
  )
}
