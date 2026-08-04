/**
 * PipelineGraph - Pipeline DAG 可视化（基于 ReactFlow + dagre 自动布局）
 *
 * 将 Pipeline 的 edges 关系渲染为可交互的有向无环图
 */

import React, { useMemo, useCallback } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  type NodeTypes,
  type NodeProps,
  Handle,
  Position,
} from '@xyflow/react'
import dagre from '@dagrejs/dagre'
import '@xyflow/react/dist/style.css'
import type { Pipeline, PipelineEdge, CronJob } from '../../../../hooks/business/useCron/types'

const NODE_W = 200
const NODE_H = 70

interface PipelineGraphProps {
  pipeline: Pipeline
  jobs: CronJob[]
  /** 图表高度 */
  height?: number
}

// ==================== dagre 自动布局 ====================

function layoutNodes(rawNodes: Node[], rawEdges: Edge[]) {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 50, marginx: 30, marginy: 30 })
  for (const n of rawNodes) g.setNode(n.id, { width: NODE_W, height: NODE_H })
  for (const e of rawEdges) g.setEdge(e.source, e.target)
  dagre.layout(g)
  return {
    nodes: rawNodes.map((n) => {
      const p = g.node(n.id)
      return { ...n, position: { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 } }
    }),
    edges: rawEdges,
  }
}

// ==================== 自定义节点 ====================

function CronJobNode({ data }: NodeProps) {
  const job = data.job as CronJob | undefined
  const name = job?.name ?? (data.label as string) ?? '未知任务'
  const isEntry = data.isEntry as boolean
  const isExit = data.isExit as boolean

  return (
    <div style={{
      padding: '10px 14px',
      borderRadius: 8,
      border: '1px solid var(--color-border)',
      background: 'var(--color-bg-secondary)',
      borderTopWidth: 3,
      borderTopColor: isEntry ? 'var(--color-primary-500)' : isExit ? 'var(--color-success, #22c55e)' : 'var(--color-border)',
      width: NODE_W,
      boxSizing: 'border-box',
    }}>
      {!isEntry && <Handle type="target" position={Position.Top} style={handleStyle} />}
      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-text-primary)', marginBottom: 4 }}>
        {name}
      </div>
      <div style={{ fontSize: 11, color: 'var(--color-text-tertiary)', display: 'flex', gap: 8 }}>
        {job?.enabled !== false ? (
          <span style={{ color: 'var(--color-success, #22c55e)' }}>启用</span>
        ) : (
          <span>禁用</span>
        )}
        {isEntry && <span style={{ color: 'var(--color-primary-500)' }}>入口</span>}
        {isExit && <span style={{ color: 'var(--color-success, #22c55e)' }}>出口</span>}
      </div>
      {!isExit && <Handle type="source" position={Position.Bottom} style={handleStyle} />}
    </div>
  )
}

const handleStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  background: 'var(--color-primary-400)',
  border: '2px solid var(--color-bg-primary)',
}

const nodeTypes: NodeTypes = {
  cronJob: CronJobNode,
}

// ==================== PipelineGraph 主组件 ====================

export const PipelineGraph: React.FC<PipelineGraphProps> = ({ pipeline, jobs, height = 300 }) => {
  const jobMap = useMemo(() => new Map(jobs.map((j) => [j.id, j])), [jobs])

  const { initialNodes, initialEdges } = useMemo(() => {
    const edges = pipeline.edges ?? []
    if (edges.length === 0) return { initialNodes: [], initialEdges: [] }

    // 收集所有节点
    const nodeIds = new Set<string>()
    for (const e of edges) {
      nodeIds.add(e.fromJobId)
      nodeIds.add(e.toJobId)
    }

    // 计算入口/出口节点
    const allFrom = new Set(edges.map((e) => e.fromJobId))
    const allTo = new Set(edges.map((e) => e.toJobId))
    const entrySet = new Set([...allFrom].filter((id) => !allTo.has(id)))
    const exitSet = new Set([...allTo].filter((id) => !allFrom.has(id)))

    const rawNodes: Node[] = Array.from(nodeIds).map((id) => ({
      id,
      type: 'cronJob',
      position: { x: 0, y: 0 },
      data: {
        job: jobMap.get(id),
        label: jobMap.get(id)?.name ?? id.slice(0, 8),
        isEntry: entrySet.has(id),
        isExit: exitSet.has(id),
      },
    }))

    const rawEdges: Edge[] = edges.map((e, idx) => ({
      id: e.id ?? `edge-${idx}`,
      source: e.fromJobId,
      target: e.toJobId,
      animated: true,
      style: { stroke: 'var(--color-primary-400)', strokeWidth: 1.5 },
    }))

    const laid = layoutNodes(rawNodes, rawEdges)
    return { initialNodes: laid.nodes, initialEdges: laid.edges }
  }, [pipeline, jobMap])

  const [nodes, , onNodesChange] = useNodesState(initialNodes)
  const [edgesState, , onEdgesChange] = useEdgesState(initialEdges)

  if (initialNodes.length === 0) {
    return (
      <div style={{
        height,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: 'var(--color-text-tertiary)',
        fontSize: 13,
        border: '1px solid var(--color-border)',
        borderRadius: 8,
      }}>
        该 Pipeline 暂无依赖关系
      </div>
    )
  }

  return (
    <div style={{ height, border: '1px solid var(--color-border)', borderRadius: 8, overflow: 'hidden' }}>
      <ReactFlow
        nodes={nodes}
        edges={edgesState}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        nodeTypes={nodeTypes}
        fitView
        minZoom={0.5}
        maxZoom={1.5}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="var(--color-border)" gap={20} size={1} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  )
}
