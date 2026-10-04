/**
 * ScenarioBrowser - 预置场景全量浏览弹窗
 *
 * 概览页「场景推荐」与新建会话空态**共用**：点各自的「更多」打开。
 *
 * 三个筛选维度叠在一起用：
 * - **搜索**：同时匹配场景名、类别与 prompt 正文（用户记得「每天早上要份资讯」
 *   但忘了场景叫什么时，搜正文比搜标题命中率高）；
 * - **领域标签**：点一下就只看这一类。标签按当前搜索结果动态算——搜完之后不该
 *   还列着一堆注定为空的选择；
 * - **触发方式分组**：一级维度，理由见 `data/preset-scenarios.ts` 文件头。
 *
 * 点卡片即选中，选中后关闭。
 */

import React, { useMemo, useState } from 'react'
import { Search } from 'lucide-react'
import clsx from 'clsx'
import { Modal } from '../ui/Modal/Modal'
import { ALL_SCENARIOS, groupScenarios, type ScenarioItem } from '../../data/preset-scenarios'
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
  const [category, setCategory] = useState<string | null>(null)

  /** 先过搜索，标签与分组都在这个结果上算 */
  const searched = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ALL_SCENARIOS
    return ALL_SCENARIOS.filter(
      (s) =>
        s.label.toLowerCase().includes(q) ||
        s.category.toLowerCase().includes(q) ||
        s.prompt.toLowerCase().includes(q),
    )
  }, [query])

  /** 领域标签 + 条数，按出现次数降序（常去的领域排前面） */
  const categories = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of searched) counts.set(s.category, (counts.get(s.category) ?? 0) + 1)
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh'))
  }, [searched])

  /**
   * 选中的标签若在当前搜索结果里不存在，就当作没选——不去用 effect 清状态：
   * 换一次搜索词就 set 一次会多一轮渲染，派生出来更简单。
   */
  const activeCategory = categories.some(([name]) => name === category) ? category : null

  const results = useMemo(
    () => (activeCategory ? searched.filter((s) => s.category === activeCategory) : searched),
    [searched, activeCategory],
  )

  /** 分组在结果上算：搜索或筛掉之后空组自然不出现 */
  const groups = useMemo(() => groupScenarios(results), [results])

  const close = () => {
    setQuery('')
    setCategory(null)
    onClose()
  }

  const choose = (scenario: ScenarioItem) => {
    onSelect(scenario)
    close()
  }

  return (
    <Modal open={open} title="全部场景" width={820} onClose={close} bodyClassName={styles.body}>
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

      {categories.length > 1 && (
        <div className={styles.cats} role="group" aria-label="按类型筛选">
          <button
            type="button"
            className={clsx(styles.chip, !activeCategory && styles['chip--on'])}
            aria-pressed={!activeCategory}
            onClick={() => setCategory(null)}
          >
            全部
          </button>
          {categories.map(([name, n]) => (
            <button
              key={name}
              type="button"
              className={clsx(styles.chip, activeCategory === name && styles['chip--on'])}
              aria-pressed={activeCategory === name}
              onClick={() => setCategory(name)}
            >
              {name}
              <span className={styles['chip-n']}>{n}</span>
            </button>
          ))}
        </div>
      )}

      {results.length === 0 ? (
        <div className={styles.empty}>没有匹配「{query.trim()}」的场景。</div>
      ) : (
        <div className={styles.groups}>
          {groups.map(({ group, items }) => (
            <section key={group.id} className={styles.group}>
              <div className={styles['group-head']}>
                <span className={styles['group-label']}>{group.label}</span>
                <span className={styles['group-hint']}>{group.hint}</span>
                <span className={styles['group-count']}>{items.length}</span>
              </div>
              <ul className={styles.grid}>
                {items.map((item) => {
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
            </section>
          ))}
        </div>
      )}
    </Modal>
  )
}
