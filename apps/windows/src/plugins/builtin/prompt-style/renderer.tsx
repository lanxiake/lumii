import { useCallback } from 'react'

import { ChevronLeft } from '../../../renderer/components/ui/Icon'
import {
  SETTINGS_STORAGE_KEY,
  SETTINGS_UPDATE_EVENT,
  useSettings,
} from '../../../renderer/hooks/business/useSettings'
import { updatePromptStyle } from '../../../renderer/services/settings-service'
import { normalizePromptStyle, type PromptStyleValue } from '../../../shared/prompt-style'
import styles from '../../../renderer/pages/SettingsPage/components/ExperimentalSection/ExperimentalSection.module.css'
import settingsStyles from '../../../renderer/pages/SettingsPage/SettingsPage.module.css'

/**
 * 提示词风格的渲染层半边：实验功能列表里的摘要 + 详情子页。
 *
 * 值与主进程的关系：切档写 `localStorage` + 广播设置事件 + `settings:updatePromptStyle`，
 * 下一轮对话生效（`bridge-prompt-dispatcher` 每轮现读）。
 */

const LABELS: Record<PromptStyleValue, string> = {
  detailed: '详细',
  terse: '简要',
  minimal: '极简',
}

export function PromptStyleSummary() {
  const { settings } = useSettings()
  return <span>当前：{LABELS[normalizePromptStyle(settings.promptStyle?.style)]}</span>
}

export function PromptStyleDetail({ onBack }: { onBack: () => void }) {
  const { settings } = useSettings()
  const currentStyle = normalizePromptStyle(settings.promptStyle?.style)

  const handleStyleChange = useCallback(
    (style: PromptStyleValue) => {
      if (style === currentStyle) return
      const nextSettings = { ...settings, promptStyle: { ...settings.promptStyle, style } }
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
    <div className={styles.detail}>
      <div className={styles.detailHeader}>
        <button
          type="button"
          className={styles.backBtn}
          onClick={onBack}
          aria-label="返回实验功能列表"
        >
          <ChevronLeft size={18} aria-hidden />
          <span>返回</span>
        </button>
        <h3 className={styles.detailTitle}>提示词风格（实验）</h3>
      </div>
      <div className={`${settingsStyles['settings-section']} ${styles.detailBody}`}>
        <div className={settingsStyles['setting-row']}>
          <span className={settingsStyles['setting-label']}>全局风格</span>
          <div className={styles['style-switch']} role="radiogroup" aria-label="系统提示词风格">
            {(['detailed', 'terse', 'minimal'] as const).map((style) => (
              <button
                key={style}
                type="button"
                role="radio"
                aria-checked={currentStyle === style}
                className={currentStyle === style ? styles['style-switch-active'] : undefined}
                onClick={() => handleStyleChange(style)}
              >
                {LABELS[style]}
              </button>
            ))}
          </div>
        </div>
        <p className={settingsStyles['setting-hint']}>
          简要档按索引式渲染系统提示词段落（段尾附展开引导，模型可按需获取完整规则）。
          极简档在简要基础上，把发给模型的工具定义收缩为「名称 + 参数」（复杂工具保留使用提示），
          MCP 章节等残余描述一并收敛，面向强模型进一步降开销。切换后下一轮对话生效。
        </p>
      </div>
    </div>
  )
}

export const promptStyleExperiment = {
  id: 'com.lumii.prompt-style',
  title: '提示词风格（实验）',
  Summary: PromptStyleSummary,
  Detail: PromptStyleDetail,
}
