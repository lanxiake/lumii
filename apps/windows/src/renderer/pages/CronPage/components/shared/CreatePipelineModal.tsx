/**
 * CreatePipelineModal - 创建 Pipeline 弹窗
 *
 * 选择任务间的依赖关系，构建 Pipeline 编排
 * 包含说明引导、环检测、至少 1 条边验证
 */

import type { FC } from 'react'
import { useState, useCallback } from 'react'
import { Modal } from '../../../../components/ui/Modal'
import type { CronJob } from '../../../../hooks/business/useCron/types'
import type { CreatePipelineParams } from '../../../../hooks/business/useCron/usePipelines'
import { hasCycle } from '../../utils/pipeline-utils'
import styles from './CreatePipelineModal.module.css'

interface CreatePipelineModalProps {
  jobs: CronJob[]
  onSubmit: (data: CreatePipelineParams) => Promise<void>
  onClose: () => void
}

interface EdgeDraft {
  fromJobId: string
  toJobId: string
}

export const CreatePipelineModal: FC<CreatePipelineModalProps> = ({ jobs, onSubmit, onClose }) => {
  const [name, setName] = useState('')
  const [description, setDescription] = useState('')
  const [edges, setEdges] = useState<EdgeDraft[]>([])
  const [submitting, setSubmitting] = useState(false)
  const [edgeError, setEdgeError] = useState<string | null>(null)

  // 添加新边的临时状态
  const [newFrom, setNewFrom] = useState(jobs[0]?.id ?? '')
  const [newTo, setNewTo] = useState(jobs[1]?.id ?? jobs[0]?.id ?? '')

  const canSubmit = name.trim() && edges.length > 0 && !submitting

  const handleAddEdge = useCallback(() => {
    if (!newFrom || !newTo || newFrom === newTo) {
      setEdgeError('起始任务和目标任务不能相同')
      return
    }
    // 去重
    const exists = edges.some((e) => e.fromJobId === newFrom && e.toJobId === newTo)
    if (exists) {
      setEdgeError('该依赖关系已存在')
      return
    }
    // 环检测
    const candidateEdges = [...edges, { fromJobId: newFrom, toJobId: newTo }]
    if (hasCycle(candidateEdges as any)) {
      setEdgeError('添加此关系会形成循环依赖，请调整')
      return
    }
    setEdgeError(null)
    setEdges(candidateEdges)
  }, [newFrom, newTo, edges])

  const handleRemoveEdge = useCallback((idx: number) => {
    setEdges((prev) => prev.filter((_, i) => i !== idx))
    setEdgeError(null)
  }, [])

  const handleSubmit = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim() || undefined,
        edges: edges.length > 0 ? edges : undefined,
      })
    } finally {
      setSubmitting(false)
    }
  }

  const jobName = (id: string) => jobs.find((j) => j.id === id)?.name ?? id.slice(0, 8)

  return (
    <Modal open title="新建流水线" onClose={onClose} width={520} layer="aboveHub">
      <div className={styles.formContainer}>
        {/* 引导说明 */}
        <div className={styles.guide}>
          流水线可以将多个定时任务串联起来，按顺序依次执行。例如：先采集数据，再分析数据，最后生成报告。
        </div>

        {/* Pipeline 名称 */}
        <div className={styles.formGroup}>
          <label className={styles.label}>
            名称 <span className={styles.required}>*</span>
          </label>
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="例如：数据采集-分析流水线"
            className={styles.input}
          />
        </div>

        {/* 描述 */}
        <div className={styles.formGroup}>
          <label className={styles.label}>描述（可选）</label>
          <input
            type="text"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="流水线用途说明"
            className={styles.input}
          />
        </div>

        {/* 依赖关系编辑 */}
        <div className={styles.formGroup}>
          <label className={styles.label}>
            依赖关系 <span className={styles.required}>*</span>
          </label>

          {/* 已添加的边 */}
          {edges.length > 0 ? (
            <div className={styles.edgeList}>
              {edges.map((edge, idx) => (
                <div key={idx} className={styles.edgeItem}>
                  <span className={styles.edgeTag}>
                    {jobName(edge.fromJobId)} → {jobName(edge.toJobId)}
                  </span>
                  <button onClick={() => handleRemoveEdge(idx)} className={styles.removeBtn}>×</button>
                </div>
              ))}
            </div>
          ) : (
            <div className={styles.edgeHint}>请至少添加一条依赖关系</div>
          )}

          {/* 添加新边 */}
          {jobs.length >= 2 ? (
            <div className={styles.edgeBuilder}>
              <select value={newFrom} onChange={(e) => setNewFrom(e.target.value)} className={styles.edgeSelect}>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>{j.name}</option>
                ))}
              </select>
              <span className={styles.edgeArrow}>→</span>
              <select value={newTo} onChange={(e) => setNewTo(e.target.value)} className={styles.edgeSelect}>
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>{j.name}</option>
                ))}
              </select>
              <button onClick={handleAddEdge} className={styles.addEdgeBtn}>添加</button>
            </div>
          ) : (
            <div className={styles.edgeHint}>
              至少需要 2 个定时任务才能创建依赖关系
            </div>
          )}

          {edgeError && <span className={styles.fieldError}>{edgeError}</span>}
        </div>

        {/* 操作按钮 */}
        <div className={styles.footer}>
          <button onClick={onClose} className={styles.btnSecondary}>取消</button>
          <button onClick={handleSubmit} disabled={!canSubmit} className={styles.btnPrimary}>
            {submitting ? '创建中...' : '创建'}
          </button>
        </div>
      </div>
    </Modal>
  )
}
