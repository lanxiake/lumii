import React, { useMemo, useState } from 'react'
import { PARKING_CATEGORY } from '@mtbot/agent-runtime/browser'
import { Check, Pencil, Plus, Trash2, X } from 'lucide-react'
import { Modal } from '../../../components/ui/Modal'
import { Button } from '../../../components/ui/Button/Button'
import { topicCountKey } from './WikiLeftNav'
import type {
  WikiTopicMutateResult,
  WikiTopicMutation,
  WikiTopicTree,
} from '../../../hooks/business/useWikiPage'

interface WikiTopicTreeEditorProps {
  open: boolean
  tree: WikiTopicTree | null
  /** 节点文件数，key 由 topicCountKey 生成；与左栏用的是同一份 */
  topicCounts: Record<string, number>
  onMutate: (mutation: WikiTopicMutation) => Promise<WikiTopicMutateResult>
  onClose: () => void
}

/** 待删除节点 + 其文件数，非空表示去向框打开 */
type PendingDelete =
  | { kind: 'category'; name: string; fileCount: number }
  | { kind: 'subtopic'; category: string; name: string; fileCount: number }

/** 行内编辑目标 */
type Editing =
  | { kind: 'newCategory' }
  | { kind: 'newSubtopic'; category: string }
  | { kind: 'renameCategory'; name: string }
  | { kind: 'renameSubtopic'; category: string; name: string }

type DispositionChoice = 'parking' | 'move' | 'merge'

/**
 * 主题树编辑弹层：增删改并大类与小类。
 *
 * 两条硬规则：
 * 1. 每次操作立刻调 onMutate，不在本地攒整树再提交（中途关闭会留孤儿）
 * 2. 删除仍有文件的节点必须先选去向，否则后端会拒绝
 * 临时存放不是树节点，这里既不展示也不可编辑。
 */
export const WikiTopicTreeEditor: React.FC<WikiTopicTreeEditorProps> = ({
  open,
  tree,
  topicCounts,
  onMutate,
  onClose,
}) => {
  const categories = useMemo(
    () => (tree?.categories ?? []).filter((c) => c.name !== PARKING_CATEGORY),
    [tree],
  )
  const [activeCategory, setActiveCategory] = useState<string | null>(null)
  const [editing, setEditing] = useState<Editing | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [pendingDelete, setPendingDelete] = useState<PendingDelete | null>(null)
  const [choice, setChoice] = useState<DispositionChoice>('parking')
  const [moveTarget, setMoveTarget] = useState('')

  // 选中大类：默认第一个；树变化后若选中的大类没了就回落
  const current = useMemo(() => {
    const found = categories.find((c) => c.name === activeCategory)
    return found ?? categories[0] ?? null
  }, [categories, activeCategory])

  const countOf = (category: string, subtopic?: string): number =>
    topicCounts[topicCountKey(category, subtopic)] ?? 0

  /** 大类下所有小类的文件数之和 */
  const categoryFileCount = (name: string): number => {
    const cat = categories.find((c) => c.name === name)
    if (!cat) return 0
    return cat.subtopics.reduce((sum, s) => sum + countOf(name, s), 0)
  }

  const resetEditing = (): void => {
    setEditing(null)
    setDraft('')
  }

  const submit = async (mutation: WikiTopicMutation): Promise<boolean> => {
    setError(null)
    const result = await onMutate(mutation)
    if (!result.ok) {
      setError(result.error)
      return false
    }
    return true
  }

  /** 行内输入提交：按当前 editing 目标折算成对应 mutation */
  const commitDraft = async (): Promise<void> => {
    const name = draft.trim()
    if (!editing) return
    if (!name) {
      resetEditing()
      return
    }
    let mutation: WikiTopicMutation | null = null
    if (editing.kind === 'newCategory') {
      mutation = { op: 'addCategory', name }
    } else if (editing.kind === 'newSubtopic') {
      mutation = { op: 'addSubtopic', category: editing.category, name }
    } else if (editing.kind === 'renameCategory') {
      mutation = editing.name === name ? null : { op: 'renameCategory', from: editing.name, to: name }
    } else {
      mutation =
        editing.name === name
          ? null
          : { op: 'renameSubtopic', category: editing.category, from: editing.name, to: name }
    }
    resetEditing()
    if (!mutation) return
    const ok = await submit(mutation)
    // 改名成功后让选中态跟着走，避免右列瞬间空掉
    if (ok && mutation.op === 'renameCategory') setActiveCategory(mutation.to)
  }

  const requestDeleteCategory = async (name: string): Promise<void> => {
    const fileCount = categoryFileCount(name)
    if (fileCount > 0) {
      setChoice('parking')
      setMoveTarget('')
      setPendingDelete({ kind: 'category', name, fileCount })
      return
    }
    await submit({ op: 'deleteCategory', name })
  }

  const requestDeleteSubtopic = async (category: string, name: string): Promise<void> => {
    const fileCount = countOf(category, name)
    if (fileCount > 0) {
      setChoice('parking')
      setMoveTarget('')
      setPendingDelete({ kind: 'subtopic', category, name, fileCount })
      return
    }
    await submit({ op: 'deleteSubtopic', category, name })
  }

  /** 去向候选：排除正被删除的节点自身（以及整个被删大类） */
  const dispositionTargets = useMemo(() => {
    if (!pendingDelete) return []
    const out: { key: string; label: string; category: string; subtopic: string }[] = []
    for (const cat of categories) {
      if (pendingDelete.kind === 'category' && cat.name === pendingDelete.name) continue
      for (const sub of cat.subtopics) {
        if (
          pendingDelete.kind === 'subtopic' &&
          cat.name === pendingDelete.category &&
          sub === pendingDelete.name
        ) {
          continue
        }
        out.push({
          key: JSON.stringify([cat.name, sub]),
          label: `${cat.name} / ${sub}`,
          category: cat.name,
          subtopic: sub,
        })
      }
    }
    return out
  }, [categories, pendingDelete])

  const confirmDelete = async (): Promise<void> => {
    if (!pendingDelete) return
    const target = dispositionTargets.find((t) => t.key === moveTarget)
    if (choice !== 'parking' && !target) {
      setError('请选择一个去向小类')
      return
    }
    const disposition =
      choice === 'parking'
        ? ({ type: 'parking' } as const)
        : ({ type: 'move', category: target!.category, subtopic: target!.subtopic } as const)

    const mutation: WikiTopicMutation =
      pendingDelete.kind === 'category'
        ? { op: 'deleteCategory', name: pendingDelete.name, disposition }
        : {
            op: 'deleteSubtopic',
            category: pendingDelete.category,
            name: pendingDelete.name,
            disposition,
          }
    const ok = await submit(mutation)
    if (ok) setPendingDelete(null)
  }

  const renderNameInput = (label: string, placeholder: string) => (
    <input
      className="wiki-tree-editor-input"
      aria-label={label}
      placeholder={placeholder}
      autoFocus
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault()
          void commitDraft()
        } else if (e.key === 'Escape') {
          e.preventDefault()
          resetEditing()
        }
      }}
    />
  )

  return (
    <Modal
      open={open}
      title="编辑主题树"
      width={720}
      onClose={onClose}
      footer={
        <Button variant="ghost" size="sm" onClick={onClose}>
          完成
        </Button>
      }
    >
      <div className="wiki-tree-editor">
        <p className="wiki-tree-editor-hint">
          每次改动立即生效。删除仍有文件的目录时需要先指定文件去向。
        </p>
        {error && (
          <p className="wiki-tree-editor-error" role="alert">
            {error}
          </p>
        )}

        <div className="wiki-tree-editor-columns">
          <section className="wiki-tree-editor-column" aria-label="大类">
            {categories.map((cat) => (
              <div key={cat.name} className="wiki-tree-editor-row">
                {editing?.kind === 'renameCategory' && editing.name === cat.name ? (
                  renderNameInput('大类名称', '大类名称')
                ) : (
                  <>
                    <button
                      type="button"
                      className={`wiki-tree-editor-name${current?.name === cat.name ? ' wiki-tree-editor-name--active' : ''}`}
                      onClick={() => setActiveCategory(cat.name)}
                    >
                      {cat.name}
                      <small>{categoryFileCount(cat.name)}</small>
                    </button>
                    <button
                      type="button"
                      className="wiki-tree-editor-icon"
                      aria-label={`重命名大类 ${cat.name}`}
                      onClick={() => {
                        setEditing({ kind: 'renameCategory', name: cat.name })
                        setDraft(cat.name)
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="wiki-tree-editor-icon"
                      aria-label={`删除大类 ${cat.name}`}
                      onClick={() => void requestDeleteCategory(cat.name)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            ))}

            {editing?.kind === 'newCategory' ? (
              renderNameInput('新大类名称', '新大类名称')
            ) : (
              <button
                type="button"
                className="wiki-tree-editor-add"
                onClick={() => {
                  setEditing({ kind: 'newCategory' })
                  setDraft('')
                }}
              >
                <Plus size={13} /> 添加大类
              </button>
            )}
          </section>

          <section className="wiki-tree-editor-column" aria-label="小类">
            {current?.subtopics.map((sub) => (
              <div key={sub} className="wiki-tree-editor-row">
                {editing?.kind === 'renameSubtopic' &&
                editing.category === current.name &&
                editing.name === sub ? (
                  renderNameInput('小类名称', '小类名称')
                ) : (
                  <>
                    <span className="wiki-tree-editor-name">
                      {sub}
                      <small>{countOf(current.name, sub)}</small>
                    </span>
                    <button
                      type="button"
                      className="wiki-tree-editor-icon"
                      aria-label={`重命名小类 ${sub}`}
                      onClick={() => {
                        setEditing({ kind: 'renameSubtopic', category: current.name, name: sub })
                        setDraft(sub)
                      }}
                    >
                      <Pencil size={13} />
                    </button>
                    <button
                      type="button"
                      className="wiki-tree-editor-icon"
                      aria-label={`删除小类 ${sub}`}
                      onClick={() => void requestDeleteSubtopic(current.name, sub)}
                    >
                      <Trash2 size={13} />
                    </button>
                  </>
                )}
              </div>
            ))}

            {current &&
              (editing?.kind === 'newSubtopic' ? (
                renderNameInput('新小类名称', '新小类名称')
              ) : (
                <button
                  type="button"
                  className="wiki-tree-editor-add"
                  onClick={() => {
                    setEditing({ kind: 'newSubtopic', category: current.name })
                    setDraft('')
                  }}
                >
                  <Plus size={13} /> 添加小类
                </button>
              ))}
          </section>
        </div>

        {pendingDelete && (
          <section className="wiki-tree-editor-disposition" aria-label="选择文件去向">
            <h4>
              「{pendingDelete.name}」下还有 {pendingDelete.fileCount} 个文件，请选择去向
            </h4>
            <label className="wiki-tree-editor-radio">
              <input
                type="radio"
                name="wiki-disposition"
                checked={choice === 'parking'}
                onChange={() => setChoice('parking')}
              />
              移到临时存放
            </label>
            <label className="wiki-tree-editor-radio">
              <input
                type="radio"
                name="wiki-disposition"
                checked={choice === 'move'}
                onChange={() => setChoice('move')}
              />
              移到另一小类
            </label>
            {choice === 'move' && (
              <select
                className="wiki-tree-editor-select"
                aria-label="选择去向小类"
                value={moveTarget}
                onChange={(e) => setMoveTarget(e.target.value)}
              >
                <option value="">请选择…</option>
                {dispositionTargets.map((t) => (
                  <option key={t.key} value={t.key}>
                    {t.label}
                  </option>
                ))}
              </select>
            )}
            <div className="wiki-tree-editor-disposition-actions">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setPendingDelete(null)
                  setError(null)
                }}
              >
                <X size={13} /> 取消
              </Button>
              <Button variant="primary" size="sm" onClick={() => void confirmDelete()}>
                <Check size={13} /> 确认删除
              </Button>
            </div>
          </section>
        )}
      </div>
    </Modal>
  )
}

export default WikiTopicTreeEditor
