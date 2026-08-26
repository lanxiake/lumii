/**
 * WikiGraphView — 双链图谱（xyflow + dagre），数据来自 wiki:graph:data
 *
 * 设计：docs/plans/记忆重构/2026-08-26-wiki-p2-implementation.md Task 3
 */
import React, { useCallback, useEffect, useMemo, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  useNodesState,
  useEdgesState,
  type Node,
  type Edge,
  Handle,
  Position,
  type NodeProps,
  type NodeTypes,
} from '@xyflow/react'
import dagre from '@dagrejs/dagre'
import '@xyflow/react/dist/style.css'
import { Button } from '../../../components/ui/Button/Button'
import type { WikiGraphDataItem, WikiPageListItem } from '../../../hooks/business/useWikiPage'

const NODE_W = 160
const NODE_H = 56

const CATEGORY_COLOR: Record<string, string> = {
  sources: 'var(--color-primary-500, #3b82f6)',
  media: 'var(--color-success, #22c55e)',
  inbox: 'var(--color-warning, #f59e0b)',
  concepts: '#8b5cf6',
  entities: '#ec4899',
  syntheses: '#06b6d4',
}

interface WikiGraphViewProps {
  readonly pages: readonly WikiPageListItem[]
  readonly getGraphData: (params: {
    centerPageId?: string
    category?: string
    limit?: number
  }) => Promise<WikiGraphDataItem | null>
  readonly onOpenPage: (pageId: string) => void
  readonly bootstrapEro?: () => Promise<{ entities: number; relations: number } | null>
}

function layoutNodes(rawNodes: Node[], rawEdges: Edge[]) {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'LR', nodesep: 40, ranksep: 60, marginx: 20, marginy: 20 })
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

function WikiPageNode({ data }: NodeProps) {
  const title = (data.title as string) ?? ''
  const category = (data.category as string) ?? 'sources'
  const useCount = (data.useCount as number) ?? 0
  const scale = Math.min(1.4, 1 + Math.log1p(useCount) * 0.08)
  const label = title.length > 16 ? `${title.slice(0, 16)}…` : title

  return (
    <div
      style={{
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-secondary)',
        borderLeftWidth: 3,
        borderLeftColor: CATEGORY_COLOR[category] ?? 'var(--color-border)',
        width: NODE_W * scale,
        boxSizing: 'border-box',
        cursor: 'pointer',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ width: 6, height: 6 }} />
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>{label}</div>
      <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>{category}</div>
      <Handle type="source" position={Position.Right} style={{ width: 6, height: 6 }} />
    </div>
  )
}

const nodeTypes: NodeTypes = { wikiPage: WikiPageNode }

export const WikiGraphView: React.FC<WikiGraphViewProps> = ({ pages, getGraphData, onOpenPage, bootstrapEro }) => {
  const [centerId, setCenterId] = useState('')
  const [category, setCategory] = useState('')
  const [graph, setGraph] = useState<WikiGraphDataItem | null>(null)
  const [loading, setLoading] = useState(false)
  const [eroMsg, setEroMsg] = useState<string | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const load = useCallback(async () => {
    if (!centerId && !category) return
    setLoading(true)
    try {
      const data = await getGraphData({
        centerPageId: centerId || undefined,
        category: category || undefined,
      })
      setGraph(data)
    } finally {
      setLoading(false)
    }
  }, [centerId, category, getGraphData])

  const handleBootstrapEro = useCallback(async () => {
    if (!bootstrapEro) return
    setEroMsg('正在从双链引导 ERO…')
    const r = await bootstrapEro()
    if (r) {
      setEroMsg(`已写入 ${r.entities} 个实体、${r.relations} 条关系，请重新查看图谱`)
      void load()
    } else {
      setEroMsg('ERO 引导失败')
    }
  }, [bootstrapEro, load])

  useEffect(() => {
    if (!graph) {
      setNodes([])
      setEdges([])
      return
    }
    const rawNodes: Node[] = graph.nodes.map((n) => ({
      id: n.id,
      type: 'wikiPage',
      position: { x: 0, y: 0 },
      data: { title: n.title, category: n.category, useCount: n.useCount },
    }))
    const rawEdges: Edge[] = graph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.anchorText,
    }))
    if (rawNodes.length === 0) {
      setNodes([])
      setEdges([])
      return
    }
    // 无边时也展示孤立节点
    if (rawEdges.length === 0) {
      setNodes(rawNodes.map((n, i) => ({ ...n, position: { x: (i % 4) * 180, y: Math.floor(i / 4) * 80 } })))
      setEdges([])
      return
    }
    const laid = layoutNodes(rawNodes, rawEdges)
    setNodes(laid.nodes)
    setEdges(laid.edges)
  }, [graph, setNodes, setEdges])

  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      onOpenPage(node.id)
    },
    [onOpenPage],
  )

  const emptyHint = useMemo(() => {
    if (loading) return '加载中…'
    if (!centerId && !category) return '选择中心页或分类后点击「查看图谱」'
    if (graph && graph.nodes.length === 0) {
      return '页面之间还没有链接，编辑页时用 [[标题]] 建立双链'
    }
    if (graph?.edges.length === 0 && (graph?.nodes.length ?? 0) > 0) {
      return '当前范围内暂无已解析链接'
    }
    return null
  }, [loading, centerId, category, graph])

  return (
    <div className="wiki-graph-view">
      <div className="wiki-cleanup-header">
        <h3>双链图谱</h3>
        <div className="wiki-cleanup-actions">
          <select value={centerId} onChange={(e) => { setCenterId(e.target.value); setCategory('') }}>
            <option value="">中心页…</option>
            {pages.map((p) => (
              <option key={p.id} value={p.id}>{p.title}</option>
            ))}
          </select>
          <select value={category} onChange={(e) => { setCategory(e.target.value); setCenterId('') }}>
            <option value="">或分类…</option>
            {['sources', 'media', 'inbox', 'concepts', 'entities', 'syntheses'].map((c) => (
              <option key={c} value={c}>{c}</option>
            ))}
          </select>
          <Button variant="primary" size="sm" disabled={(!centerId && !category) || loading} onClick={() => void load()}>
            查看图谱
          </Button>
          {bootstrapEro && (
            <Button variant="secondary" size="sm" onClick={() => void handleBootstrapEro()}>
              从双链生成 ERO
            </Button>
          )}
        </div>
      </div>
      {eroMsg && <p className="wiki-empty-hint">{eroMsg}</p>}
      {graph?.truncated && <p className="wiki-empty-hint">节点已截断至上限，请收窄中心页或分类范围</p>}
      {emptyHint && nodes.length === 0 ? (
        <p className="wiki-empty-hint">{emptyHint}</p>
      ) : (
        <div style={{ height: 420, border: '1px solid var(--color-border)', borderRadius: 8 }}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            nodeTypes={nodeTypes}
            onNodeClick={onNodeClick}
            fitView
          >
            <Background />
            <Controls />
          </ReactFlow>
        </div>
      )}
    </div>
  )
}

export default WikiGraphView
