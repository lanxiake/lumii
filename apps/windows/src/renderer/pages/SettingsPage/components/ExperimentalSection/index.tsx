/**
 * ExperimentalSection - 实验功能设置
 *
 * 自主进化页面入口。工具进化已移至「工具」菜单（含功能开关与审批管理）。
 * 「提示词风格（实验）」P0 阶段为只读段清单（数据源 PROMPT_SECTIONS）；
 * 风格开关待 P1 terse 渲染落地后启用（避免出现可点但不生效的死开关）。
 */

import React from 'react'
import { PROMPT_SECTIONS } from '@mtbot/agent-runtime/browser'
import { AutonomousPage } from '../../../AutonomousPage/AutonomousPage'
import settingsStyles from '../../SettingsPage.module.css'
import styles from './ExperimentalSection.module.css'

const GROUP_LABELS: Record<string, string> = {
  identity: '身份',
  rules: '规则',
  capabilities: '能力',
  collaboration: '协作',
  memory: '记忆',
  runtime: '运行时',
  channel: '渠道',
}

const EXPAND_ROUTE_LABELS: Record<string, string> = {
  'prompt-guide': 'prompt_guide',
  'existing-tool': '既有工具',
}

/** 只读段清单：段 ID / 分组 / 分区 / 索引化支持 / 展开方式 */
function PromptSectionsPanel() {
  return (
    <div className={`${settingsStyles['settings-section']} ${styles['prompt-style-card']}`}>
      <h3>提示词风格（实验）</h3>
      <p className={settingsStyles['setting-hint']}>
        全局两态风格「详细 / 简要」将在后续阶段启用：简要档按索引式渲染系统提示词段落，
        模型可按需通过 prompt_guide 展开细节。当前为只读段清单，用于调试与理解提示词结构。
      </p>
      <div className={styles['prompt-sections-scroll']}>
        <table className={styles['prompt-sections-table']}>
          <thead>
            <tr>
              <th>段 ID</th>
              <th>分组</th>
              <th>分区</th>
              <th>索引化支持</th>
              <th>展开方式</th>
            </tr>
          </thead>
          <tbody>
            {PROMPT_SECTIONS.map((s) => (
              <tr key={s.id}>
                <td>
                  <code>{s.id}</code>
                </td>
                <td>{GROUP_LABELS[s.group] ?? s.group}</td>
                <td>{s.zone === 'static' ? '静态' : '动态'}</td>
                <td>{s.terse ? '✓' : '—'}</td>
                <td>{s.expandVia ? (EXPAND_ROUTE_LABELS[s.expandVia] ?? s.expandVia) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export function ExperimentalSection() {
  return (
    <div className={styles.wrap}>
      <PromptSectionsPanel />
      <div className={settingsStyles['autonomous-embed']}>
        <AutonomousPage embedded />
      </div>
    </div>
  )
}
