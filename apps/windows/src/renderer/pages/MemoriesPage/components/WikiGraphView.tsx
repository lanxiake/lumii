/**
 * WikiGraphView — 知识图谱（xyflow + dagre），数据来自 wiki:graph:data
 *
 * 支持三图层（全部 / 仅实体关系 / 仅页面双链）与实体侧栏。
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
import type { WikiGraphDataItem, WikiObservationItem, WikiPageListItem } from '../../../hooks/business/useWikiPage'

const NODE_W = 160
const NODE_H = 56

/** 实体侧栏最多展示的观察条数 */
const SIDEBAR_OBSERVATION_LIMIT = 5

/** 图谱图层：全部、仅实体关系、仅页面双链 */
export type GraphLayer = 'all' | 'entities' | 'pages'

const LAYER_OPTIONS: readonly { value: GraphLayer; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'entities', label: '仅实体关系' },
  { value: 'pages', label: '仅页面双链' },
]

const CATEGORY_COLOR: Record<string, string> = {
  sources: 'var(--color-primary-500, #3b82f6)',
  media: 'var(--color-success, #22c55e)',
  inbox: 'var(--color-warning, #f59e0b)',
  concepts: '#8b5cf6',
  entities: '#ec4899',
  syntheses: '#06b6d4',
}

const ENTITY_BORDER_COLOR = '#ec4899'

interface SelectedEntity {
  readonly id: string
  readonly title: string
  readonly entityType?: string
  readonly pageId?: string | null
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
  readonly extractEro?: () => Promise<{
    pagesProcessed: number
    entitiesUpserted: number
    relationsUpserted: number
    observationsAdded: number
    errors: readonly string[]
  } | null>
  /** 选中实体时加载观察摘要（wiki:ero:list + entityId） */
  readonly listEntityObservations?: (entityId: string) => Promise<readonly WikiObservationItem[]>
}

/**
 * 按图层过滤混合图谱：实体层保留 relation 边，页面层保留 wikilink 边。
 */
export function filterGraph(g: WikiGraphDataItem, layer: GraphLayer): WikiGraphDataItem {
  if (layer === 'all') return g
  if (layer === 'entities') {
    const nodes = g.nodes.filter((n) => n.kind === 'entity')
    const ids = new Set(nodes.map((n) => n.id))
    const edges = g.edges.filter((e) => e.kind === 'relation' && ids.has(e.source) && ids.has(e.target))
    return { ...g, nodes, edges }
  }
  const nodes = g.nodes.filter((n) => n.kind === 'page')
  const ids = new Set(nodes.map((n) => n.id))
  const edges = g.edges.filter((e) => e.kind === 'wikilink' && ids.has(e.source) && ids.has(e.target))
  return { ...g, nodes, edges }
}

/** 使用 dagre 对节点进行层次布局 */
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

/** Wiki 页面节点 */
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

/** ERO 实体节点 */
function WikiEntityNode({ data }: NodeProps) {
  const title = (data.title as string) ?? ''
  const entityType = (data.entityType as string) ?? 'entity'
  const label = title.length > 16 ? `${title.slice(0, 16)}…` : title

  return (
    <div
      style={{
        padding: '8px 10px',
        borderRadius: 8,
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-secondary)',
        borderLeftWidth: 3,
        borderLeftColor: ENTITY_BORDER_COLOR,
        width: NODE_W,
        boxSizing: 'border-box',
        cursor: 'pointer',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ width: 6, height: 6 }} />
      <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--color-text-primary)' }}>{label}</div>
      <div style={{ fontSize: 10, color: 'var(--color-text-tertiary)' }}>{entityType}</div>
      <Handle type="source" position={Position.Right} style={{ width: 6, height: 6 }} />
    </div>
  )
}

const nodeTypes: NodeTypes = { wikiPage: WikiPageNode, wikiEntity: WikiEntityNode }

export const WikiGraphView: React.FC<WikiGraphViewProps> = ({
  pages,
  getGraphData,
  onOpenPage,
  bootstrapEro,
  extractEro,
  listEntityObservations,
}) => {
  const [centerId, setCenterId] = useState('')
  const [category, setCategory] = useState('')
  const [layer, setLayer] = useState<GraphLayer>('all')
  const [graph, setGraph] = useState<WikiGraphDataItem | null>(null)
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity | null>(null)
  const [entityObservations, setEntityObservations] = useState<readonly WikiObservationItem[]>([])
  const [observationsLoading, setObservationsLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [eroMsg, setEroMsg] = useState<string | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const filteredGraph = useMemo(
    () => (graph ? filterGraph(graph, layer) : null),
    [graph, layer],
  )

  /** 切换图层并关闭实体侧栏，避免跨图层残留选中状态 */
  const handleLayerChange = useCallback((next: GraphLayer) => {
    setLayer(next)
    setSelectedEntity(null)
    setEntityObservations([])
  }, [])

  /** 选中实体后拉取观察摘要 */
  useEffect(() => {
    if (!selectedEntity || !listEntityObservations) {
      setEntityObservations([])
      return
    }
    let cancelled = false
    setObservationsLoading(true)
    void listEntityObservations(selectedEntity.id).then((rows) => {
      if (!cancelled) {
        setEntityObservations(rows.slice(0, SIDEBAR_OBSERVATION_LIMIT))
        setObservationsLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [selectedEntity, listEntityObservations])

  /** 拉取 IPC 图谱数据 */
  const load = useCallback(async () => {
    if (!centerId && !category) return
    setLoading(true)
    setSelectedEntity(null)
    setEntityObservations([])
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

  /** 从双链冷启动 ERO 实体与关系 */
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

  /** AI 抽取最近更新页的实体关系 */
  const handleExtractEro = useCallback(async () => {
    if (!extractEro) return
    setEroMsg('正在 AI 抽取实体关系…')
    const r = await extractEro()
    if (r) {
      const errHint = r.errors.length > 0 ? `，${r.errors.length} 页失败` : ''
      setEroMsg(
        `已处理 ${r.pagesProcessed} 页：${r.entitiesUpserted} 实体、${r.relationsUpserted} 关系、${r.observationsAdded} 观察${errHint}，请重新查看图谱`,
      )
      void load()
    } else {
      setEroMsg('AI 抽取失败')
    }
  }, [extractEro, load])

  useEffect(() => {
    if (!filteredGraph) {
      setNodes([])
      setEdges([])
      return
    }
    const rawNodes: Node[] = filteredGraph.nodes.map((n) => ({
      id: n.id,
      type: n.kind === 'entity' ? 'wikiEntity' : 'wikiPage',
      position: { x: 0, y: 0 },
      data: {
        title: n.title,
        category: n.category,
        useCount: n.useCount,
        kind: n.kind,
        entityType: n.entityType,
        pageId: n.pageId,
      },
    }))
    const rawEdges: Edge[] = filteredGraph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label || e.anchorText || '',
    }))
    if (rawNodes.length === 0) {
      setNodes([])
      setEdges([])
      return
    }
    if (rawEdges.length === 0) {
      setNodes(rawNodes.map((n, i) => ({ ...n, position: { x: (i % 4) * 180, y: Math.floor(i / 4) * 80 } })))
      setEdges([])
      return
    }
    const laid = layoutNodes(rawNodes, rawEdges)
    setNodes(laid.nodes)
    setEdges(laid.edges)
  }, [filteredGraph, setNodes, setEdges])

  /** 节点点击：页面跳转，实体打开侧栏 */
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const kind = node.data?.kind as string | undefined
      if (kind === 'entity') {
        setSelectedEntity({
          id: node.id,
          title: String(node.data?.title ?? ''),
          entityType: node.data?.entityType as string | undefined,
          pageId: node.data?.pageId as string | null | undefined,
        })
        return
      }
      onOpenPage(node.id)
    },
    [onOpenPage],
  )

  const emptyHint = useMemo(() => {
    if (loading) return '加载中…'
    if (!centerId && !category) return '选择中心页或分类后点击「查看图谱」'
    if (filteredGraph && filteredGraph.nodes.length === 0) {
      return layer === 'entities'
        ? '当前范围内暂无实体关系'
        : layer === 'pages'
          ? '页面之间还没有链接，编辑页时用 [[标题]] 建立双链'
          : '当前范围内暂无节点'
    }
    if (filteredGraph?.edges.length === 0 && (filteredGraph?.nodes.length ?? 0) > 0) {
      return '当前范围内暂无已解析链接'
    }
    return null
  }, [loading, centerId, category, filteredGraph, layer])

  return (
    <div className="wiki-graph-view">
      <div className="wiki-cleanup-header">
        <h3>知识图谱</h3>
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
          {extractEro && (
            <Button variant="secondary" size="sm" onClick={() => void handleExtractEro()}>
              抽取实体关系
            </Button>
          )}
        </div>
      </div>

      {graph && (
        <div className="wiki-graph-layer-chips" role="tablist" aria-label="图谱图层">
          {LAYER_OPTIONS.map((opt) => (
            <button
              key={opt.value}
              type="button"
              role="tab"
              aria-selected={layer === opt.value}
              className={`wiki-graph-layer-chip${layer === opt.value ? ' wiki-graph-layer-chip--active' : ''}`}
              onClick={() => handleLayerChange(opt.value)}
            >
              {opt.label}
            </button>
          ))}
        </div>
      )}

      {eroMsg && <p className="wiki-empty-hint">{eroMsg}</p>}
      {graph?.truncated && <p className="wiki-empty-hint">节点已截断至上限，请收窄中心页或分类范围</p>}
      {emptyHint && nodes.length === 0 ? (
        <p className="wiki-empty-hint">{emptyHint}</p>
      ) : (
        <div className="wiki-graph-body">
          <div className="wiki-graph-canvas" style={{ height: 420, border: '1px solid var(--color-border)', borderRadius: 8 }}>
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
          {selectedEntity && (
            <aside className="wiki-graph-entity-sidebar" aria-label="实体详情">
              <div className="wiki-graph-entity-sidebar-header">
                <h4>{selectedEntity.title}</h4>
                <button
                  type="button"
                  className="wiki-graph-entity-sidebar-close"
                  aria-label="关闭侧栏"
                  onClick={() => setSelectedEntity(null)}
                >
                  ×
                </button>
              </div>
              {selectedEntity.entityType && (
                <p className="wiki-graph-entity-type">{selectedEntity.entityType}</p>
              )}
              {selectedEntity.pageId ? (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onOpenPage(selectedEntity.pageId!)}
                >
                  打开关联页面
                </Button>
              ) : (
                <p className="wiki-empty-hint">暂无关联页面</p>
              )}
              <section className="wiki-graph-entity-observations" aria-label="观察摘要">
                <h5>观察摘要</h5>
                {observationsLoading ? (
                  <p className="wiki-empty-hint">加载观察中…</p>
                ) : entityObservations.length === 0 ? (
                  <p className="wiki-empty-hint">暂无观察</p>
                ) : (
                  <ul className="wiki-graph-entity-observation-list">
                    {entityObservations.map((obs) => (
                      <li key={obs.id} className="wiki-graph-entity-observation-item">
                        <p>{obs.content}</p>
                        {obs.sourcePageId && (
                          <button
                            type="button"
                            className="wiki-graph-entity-observation-source"
                            onClick={() => onOpenPage(obs.sourcePageId!)}
                          >
                            来源页
                          </button>
                        )}
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </aside>
          )}
        </div>
      )}
    </div>
  )
}

export default WikiGraphView
