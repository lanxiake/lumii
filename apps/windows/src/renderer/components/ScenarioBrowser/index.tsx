/**
 * ScenarioBrowser - 预置场景全量浏览弹窗
 *
 * 概览页「场景推荐」与新建会话空态**共用**：点各自的「更多」打开，按网格铺开全部预置场景，
 * 支持搜索（同时匹配场景名、类别与 prompt 正文 —— 用户记得「定时提醒」但忘了它叫什么时，
 * 搜正文比搜标题命中率高）。点卡片即选中，选中后关闭。
 */

import React, { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import { Modal } from '../ui/Modal/Modal'
import { ALL_SCENARIOS, type ScenarioItem } from '../../data/preset-scenarios'
import styles from './ScenarioBrowser.module.css'

interface ScenarioBrowserProps {
  open: boolean
  onClose: () => void
  onSelect: (scenario: ScenarioItem) => void
}

/** prompt 的第一行当摘要：预置 prompt 多为「一句任务说明 + 空行 + 细节」 */
function firstLine(prompt: string): string {
  return prompt.split('\n').find((line) => line.trim())?.trim() ?? ''
}

export const ScenarioBrowser: React.FC<ScenarioBrowserProps> = ({ open, onClose, onSelect }) => {
  const [query, setQuery] = useState('')

  const results = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ALL_SCENARIOS
    return ALL_SCENARIOS.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.prompt.toLowerCase().includes(q),
    )
  }, [query])

  const close = () => {
    setQuery('')
    onClose()
  }

  const choose = (scenario: ScenarioItem) => {
    onSelect(scenario)
    close()
  }

  return (
    <Modal open={open} title="全部场景" width={780} onClose={close} bodyClassName={styles.body}>
      <div className={styles.search}>
        <Search size={15} strokeWidth={1.8} aria-hidden="true" className={styles['search-icon']} />
        <input
          className={styles.input}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索场景：名称、类别或描述"
          aria-label="搜索场景"
        />
        <span className={styles.count}>
          {results.length} / {ALL_SCENARIOS.length}
        </span>
      </div>

      {results.length === 0 ? (
        <div className={styles.empty}>没有匹配「{query.trim()}」的场景。</div>
      ) : (
        <ul className={styles.grid}>
          {results.map((item) => {
            const Icon = item.icon
            return (
              <li key={item.label}>
                <button
                  type="button"
                  className={styles.card}
                  onClick={() => choose(item)}
                  title={item.prompt}
                >
                  <span className={styles['card-head']}>
                    <span className={styles['card-icon']} aria-hidden="true">
                      <Icon size={15} strokeWidth={1.8} />
                    </span>
                    <span className={styles['card-label']}>{item.label}</span>
                  </span>
                  <span className={styles['card-cat']}>{item.category}</span>
                  <span className={styles['card-snippet']}>{firstLine(item.prompt)}</span>
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </Modal>
  )
}
