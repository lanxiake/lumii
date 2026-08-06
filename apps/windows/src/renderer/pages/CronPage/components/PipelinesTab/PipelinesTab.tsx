/**
 * PipelinesTab - Pipeline DAG 编排视图
 *
 * 展示用户的 Pipeline 列表，含边关系、DAG 可视化、创建/编辑/删除操作
 */

import type { FC } from 'react'
import { useState, useCallback, useMemo } from 'react'
import styles from './PipelinesTab.module.css'
import type { CronJob } from '../../../../hooks/business/useCron/types'
import { usePipelines } from '../../../../hooks/business/useCron/usePipelines'
import { CreatePipelineModal } from '../shared/CreatePipelineModal'
import { PipelineGraph } from './PipelineGraph'
import { ConfirmModal } from '../../../../components/ui/Modal/ConfirmModal'

interface PipelinesTabProps {
  jobs: CronJob[]
}

export const PipelinesTab: FC<PipelinesTabProps> = ({ jobs }) => {
  const {
    pipelines,
    loading,
    createPipeline,
    updatePipeline,
    removePipeline,
  } = usePipelines()

  const [showCreateModal, setShowCreateModal] = useState(false)
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; name: string } | null>(null)

  // 任务名称映射
  const jobNameMap = useMemo(() => new Map(jobs.map((j) => [j.id, j.name])), [jobs])

  const handleToggle = useCallback(async (id: string, enabled: boolean) => {
    await updatePipeline(id, { enabled })
  }, [updatePipeline])

  const handleDelete = useCallback(async (id: string) => {
    await removePipeline(id)
    if (expandedId === id) setExpandedId(null)
  }, [removePipeline, expandedId])

  const handleCardClick = useCallback((id: string) => {
    setExpandedId((prev) => (prev === id ? null : id))
  }, [])

  if (loading) {
    return <div className={styles.empty}>正在加载流水线列表…</div>
  }

  return (
    <div className={styles.pipelinesTab}>
      {/* 操作栏 */}
      <div className={styles.toolbar}>
        <span style={{ fontSize: 13, color: 'var(--color-text-secondary)' }}>
          共 {pipelines.length} 条流水线
        </span>
        <button className={styles.createBtn} onClick={() => setShowCreateModal(true)}>
          + 新建流水线
        </button>
      </div>

      {/* Pipeline 列表 */}
      {pipelines.length === 0 ? (
        <div className={styles.empty}>
          <div className={styles.emptyIcon}>🔗</div>
          <div className={styles.emptyText}>暂无流水线</div>
          <div className={styles.emptyHint}>创建流水线，把多个定时任务按顺序串联执行</div>
        </div>
      ) : (
        <div className={styles.pipelineList}>
          {pipelines.map((pipeline) => (
            <div key={pipeline.id}>
              <div
                className={styles.pipelineCard}
                onClick={() => handleCardClick(pipeline.id)}
              >
                <div className={styles.pipelineCardHeader}>
                  <span className={styles.pipelineName}>{pipeline.name}</span>
                  <div className={styles.pipelineActions}>
                    <span className={`${styles.statusBadge} ${
                      pipeline.enabled ? styles.statusEnabled : styles.statusDisabled
                    }`}>
                      {pipeline.enabled ? '启用' : '禁用'}
                    </span>
                    <button
                      className={styles.actionBtn}
                      onClick={(e) => {
                        e.stopPropagation()
                        handleToggle(pipeline.id, !pipeline.enabled)
                      }}
                    >
                      {pipeline.enabled ? '禁用' : '启用'}
                    </button>
                    <button
                      className={`${styles.actionBtn} ${styles.actionBtnDanger}`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setDeleteTarget({ id: pipeline.id, name: pipeline.name })
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>

                {pipeline.description && (
                  <div className={styles.pipelineDescription}>{pipeline.description}</div>
                )}

                {/* 边关系标签 */}
                {pipeline.edges && pipeline.edges.length > 0 && (
                  <div className={styles.edgeList}>
                    {pipeline.edges.map((edge, idx) => (
                      <span key={edge.id ?? idx} className={styles.edgeTag}>
                        {jobNameMap.get(edge.fromJobId) ?? edge.fromJobId.slice(0, 8)}
                        <span className={styles.edgeArrow}>→</span>
                        {jobNameMap.get(edge.toJobId) ?? edge.toJobId.slice(0, 8)}
                      </span>
                    ))}
                  </div>
                )}

                <div className={styles.pipelineMeta}>
                  <span>创建于 {new Date(pipeline.createdAt).toLocaleDateString()}</span>
                  <span>{pipeline.edges?.length ?? 0} 条依赖关系</span>
                  <span style={{ color: 'var(--color-primary-400)' }}>
                    {expandedId === pipeline.id ? '收起 DAG ▲' : '展开 DAG ▼'}
                  </span>
                </div>
              </div>

              {/* 展开的 DAG 可视化 */}
              {expandedId === pipeline.id && pipeline.edges && pipeline.edges.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  <PipelineGraph pipeline={pipeline} jobs={jobs} height={280} />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 创建 Pipeline 弹窗 */}
      {showCreateModal && (
        <CreatePipelineModal
          jobs={jobs}
          onSubmit={async (data) => {
            const result = await createPipeline(data)
            if (result) setShowCreateModal(false)
          }}
          onClose={() => setShowCreateModal(false)}
        />
      )}

      {/* 删除确认弹窗 */}
      <ConfirmModal
        open={!!deleteTarget}
        title="删除流水线"
        content={`确定要删除流水线「${deleteTarget?.name ?? ''}」吗？删除后无法恢复。`}
        confirmText="删除"
        confirmVariant="danger"
        layer="aboveHub"
        onConfirm={() => {
          if (deleteTarget) handleDelete(deleteTarget.id)
          setDeleteTarget(null)
        }}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
