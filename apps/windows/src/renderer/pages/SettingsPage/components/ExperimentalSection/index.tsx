/**
 * ExperimentalSection - 实验功能设置
 *
 * 自主进化页面入口。工具进化已移至「工具」菜单（含功能开关与审批管理）。
 * 「提示词风格（实验）」：全局两态开关（详细/简要）+ 只读段清单
 * （数据源 PROMPT_SECTIONS）。切换写 localStorage 并经 IPC 同步主进程缓存，
 * 下一轮对话生效（pi 每轮快照系统提示词）。
 */

import React, { useCallback } from 'react'
import { PROMPT_SECTIONS } from '@mtbot/agent-runtime/browser'
import { AutonomousPage } from '../../../AutonomousPage/AutonomousPage'
import {
  useSettings,
  SETTINGS_STORAGE_KEY,
  SETTINGS_UPDATE_EVENT,
} from '../../../../hooks/business/useSettings'
import { updatePromptStyle } from '../../../../services/settings-service'
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
function PromptSectionsTable() {
  return (
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
  )
}

export function ExperimentalSection() {
  const { settings } = useSettings()
  const currentStyle = settings.promptStyle?.style === 'terse' ? 'terse' : 'detailed'

  const handleStyleChange = useCallback(
    (style: 'detailed' | 'terse') => {
      if (style === currentStyle) return
      const nextSettings = {
        ...settings,
        promptStyle: { ...settings.promptStyle, style },
      }
      try {
        localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(nextSettings))
        window.dispatchEvent(new CustomEvent(SETTINGS_UPDATE_EVENT, { detail: nextSettings }))
        void updatePromptStyle({ style })
      } catch {
        // 忽略本地存储写入失败
      }
    },
    [settings, currentStyle],
  )

  return (
    <div className={styles.wrap}>
      <div className={`${settingsStyles['settings-section']} ${styles['prompt-style-card']}`}>
        <h3>提示词风格（实验）</h3>
        <div className={settingsStyles['setting-row']}>
          <span className={settingsStyles['setting-label']}>全局风格</span>
          <div className={styles['style-switch']} role="radiogroup" aria-label="系统提示词风格">
            <button
              type="button"
              role="radio"
              aria-checked={currentStyle === 'detailed'}
              className={currentStyle === 'detailed' ? styles['style-switch-active'] : undefined}
              onClick={() => handleStyleChange('detailed')}
            >
              详细
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={currentStyle === 'terse'}
              className={currentStyle === 'terse' ? styles['style-switch-active'] : undefined}
              onClick={() => handleStyleChange('terse')}
            >
              简要
            </button>
          </div>
        </div>
        <p className={settingsStyles['setting-hint']}>
          简要档按索引式渲染系统提示词段落（段尾附展开引导，模型可按需获取完整规则），
          面向强模型减少冗余描述；切换后下一轮对话生效。下方为只读段清单，用于调试与理解提示词结构。
        </p>
        <PromptSectionsTable />
      </div>
      <div className={settingsStyles['autonomous-embed']}>
        <AutonomousPage embedded />
      </div>
    </div>
  )
}
