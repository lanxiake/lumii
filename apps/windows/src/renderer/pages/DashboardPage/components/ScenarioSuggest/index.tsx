/**
 * ScenarioSuggest - 概览页「场景推荐」
 *
 * 复用新建会话的预置场景（`renderer/data/preset-scenarios`），点击 = 开一个新会话、
 * 把该场景的 prompt 预填进输入框（**不自动发送**，用户还能改）。
 *
 * 与 NewsFeed 的「解读资讯」走同一条 `mtbot:chat-draft-request` 通道；`newSession: true`
 * 是必须的——跑一个场景和用户当前对话无关，塞进进行中的会话会污染上下文。
 */

import React from 'react'
import { Card } from '../../../../components/ui/Card/Card'
import { getFeaturedScenarios, type ScenarioItem } from '../../../../data/preset-scenarios'
import type { ViewType } from '../../../../components/layout/Sidebar/Sidebar'
import styles from './ScenarioSuggest.module.css'

interface ScenarioSuggestProps {
  /** 视图切换回调 */
  onViewChange?: (view: ViewType) => void
}

/** 精选清单是纯数据，模块级算一次即可 */
const SCENARIOS = getFeaturedScenarios()

export const ScenarioSuggest: React.FC<ScenarioSuggestProps> = ({ onViewChange }) => {
  const start = (item: ScenarioItem) => {
    window.dispatchEvent(
      new CustomEvent('mtbot:chat-draft-request', {
        detail: { text: item.prompt, newSession: true },
      }),
    )
    onViewChange?.('chat')
  }

  return (
    <Card className={styles.panel} flush>
      <div className={styles.head}>
        <span className={styles.title}>场景推荐</span>
        <span className={styles.tag}>开箱即用</span>
      </div>

      <ul className={styles.list}>
        {SCENARIOS.map((item) => {
          const Icon = item.icon
          return (
            <li key={item.label}>
              <button
                type="button"
                className={styles.item}
                onClick={() => start(item)}
                title={`${item.category} · ${item.label}`}
              >
                <span className={styles.icon} aria-hidden="true">
                  <Icon size={14} strokeWidth={1.8} />
                </span>
                <span className={styles.label}>{item.label}</span>
                <span className={styles.cat}>{item.category}</span>
              </button>
            </li>
          )
        })}
      </ul>
    </Card>
  )
}
