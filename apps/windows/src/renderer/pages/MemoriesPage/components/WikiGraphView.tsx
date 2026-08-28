/**
 * WikiGraphView — 三期知识图谱：支持结构层、实体层、历史层
 *
 * 数据来自 wiki:graph:data，根据 currentNav 自动构造查询。
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
import type {
  WikiGraphDataItem,
  WikiGraphQuery,
  WikiGraphLayer,
  WikiEntitySourceRef,
  WikiEroExtractSourceResult,
} from '../../../hooks/business/useWikiPage'
import type { WikiNav } from './WikiLeftNav'

const NODE_W = 160
const NODE_H = 56

interface SelectedEntity {
  readonly id: string
  readonly title: string
  readonly entityType?: string
}

interface WikiGraphViewProps {
  readonly currentNav: WikiNav
  readonly getGraphData: (query: WikiGraphQuery) => Promise<WikiGraphDataItem | null>
  readonly extractEroFromSources: (scope: {
    category?: string
    subtopic?: string
    sourceIds?: readonly string[]
  }) => Promise<WikiEroExtractSourceResult | null>
  readonly listEntitySources: (entityId: string) => Promise<readonly WikiEntitySourceRef[]>
  readonly openSource: (sourceId: string) => Promise<void>
  readonly onNavigateTo: (nav: WikiNav) => void
  readonly runLongTask: <R>(title: string, fn: () => Promise<R>) => Promise<R>
}

/**
 * 三期图层控制：默认全部（结构+实体），支持单独切换
 */
type LayerControl = 'all' | 'structure' | 'entities'

const LAYER_OPTIONS: readonly { value: LayerControl; label: string }[] = [
  { value: 'structure', label: '结构' },
  { value: 'entities', label: '实体关系' },
  { value: 'all', label: '全部' },
]

const CATEGORY_COLOR = 'var(--color-primary-500, #3b82f6)'
const SUBTOPIC_COLOR = 'var(--color-border)'
const SOURCE_MEDIA_TYPE_COLORS: Record<string, string> = {
  'application/pdf': '#ef4444',
  'text/plain': '#10b981',
  'text/markdown': '#10b981',
  'image/png': '#8b5cf6',
  'image/jpeg': '#8b5cf6',
}
const ENTITY_BORDER_COLOR = '#ec4899'

/**
 * 按图层过滤混合图谱。
 */
function filterGraphByLayer(g: WikiGraphDataItem, layer: LayerControl, showHistory: boolean): WikiGraphDataItem {
  const layers: WikiGraphLayer[] = (() => {
    if (layer === 'all') return ['structure', 'entities']
    if (layer === 'structure') return ['structure']
    if (layer === 'entities') return ['entities']
    return []
  })()
  if (showHistory && !layers.includes('history')) layers.push('history')

  // 前端不重新查询，只过滤已拉取的节点/边
  const allowedKinds = new Set<string>()
  if (layers.includes('structure')) {
    allowedKinds.add('category')
    allowedKinds.add('subtopic')
    allowedKinds.add('source')
  }
  if (layers.includes('entities')) {
    allowedKinds.add('entity')
    allowedKinds.add('source') // entity 的 mentioned_in 边指向 source
  }
  if (layers.includes('history')) {
    allowedKinds.add('page')
  }

  const nodes = g.nodes.filter((n) => allowedKinds.has(n.kind))
  const ids = new Set(nodes.map((n) => n.id))

  const allowedEdgeKinds = new Set<string>()
  if (layers.includes('structure')) {
    allowedEdgeKinds.add('belongs_to')
    allowedEdgeKinds.add('sibling')
  }
  if (layers.includes('entities')) {
    allowedEdgeKinds.add('relation')
    allowedEdgeKinds.add('mentioned_in')
  }
  if (layers.includes('history')) {
    allowedEdgeKinds.add('wikilink')
  }

  const edges = g.edges.filter((e) => allowedEdgeKinds.has(e.kind) && ids.has(e.source) && ids.has(e.target))

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
        borderLeftColor: CATEGORY_COLOR,
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

/** 资料节点 */
function WikiSourceNode({ data }: NodeProps) {
  const title = (data.title as string) ?? ''
  const mediaType = (data.mediaType as string) ?? ''
  const label = title.length > 16 ? `${title.slice(0, 16)}…` : title
  const borderColor = SOURCE_MEDIA_TYPE_COLORS[mediaType] ?? '#6b7280'

  return (
    <div
      style={{
        padding: '6px 8px',
        borderRadius: 6,
        border: '1px solid var(--color-border)',
        background: 'var(--color-bg-secondary)',
        borderLeftWidth: 3,
        borderLeftColor: borderColor,
        width: NODE_W * 0.8,
        boxSizing: 'border-box',
        cursor: 'pointer',
      }}
    >
      <Handle type="target" position={Position.Left} style={{ width: 6, height: 6 }} />
      <div style={{ fontSize: 11, fontWeight: 500, color: 'var(--color-text-primary)' }}>{label}</div>
      <Handle type="source" position={Position.Right} style={{ width: 6, height: 6 }} />
    </div>
  )
}

const nodeTypes: NodeTypes = { wikiPage: WikiPageNode, wikiEntity: WikiEntityNode, wikiSource: WikiSourceNode }

export const WikiGraphView: React.FC<WikiGraphViewProps> = ({
  currentNav,
  getGraphData,
  extractEroFromSources,
  listEntitySources,
  openSource,
  onNavigateTo,
  runLongTask,
}) => {
  const [layer, setLayer] = useState<LayerControl>('all')
  const [showHistory, setShowHistory] = useState(false)
  const [graph, setGraph] = useState<WikiGraphDataItem | null>(null)
  const [selectedEntity, setSelectedEntity] = useState<SelectedEntity | null>(null)
  const [entitySources, setEntitySources] = useState<readonly WikiEntitySourceRef[]>([])
  const [sourcesLoading, setSourcesLoading] = useState(false)
  const [loading, setLoading] = useState(false)
  const [extractMsg, setExtractMsg] = useState<string | null>(null)
  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([])
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([])

  const filteredGraph = useMemo(
    () => (graph ? filterGraphByLayer(graph, layer, showHistory) : null),
    [graph, layer, showHistory],
  )

  /** 切换图层时关闭实体侧栏 */
  const handleLayerChange = useCallback((next: LayerControl) => {
    setLayer(next)
    setSelectedEntity(null)
    setEntitySources([])
  }, [])

  /** 选中实体后拉取资料列表 */
  useEffect(() => {
    if (!selectedEntity) {
      setEntitySources([])
      return
    }
    let cancelled = false
    setSourcesLoading(true)
    void listEntitySources(selectedEntity.id).then((rows) => {
      if (!cancelled) {
        setEntitySources(rows)
        setSourcesLoading(false)
      }
    })
    return () => {
      cancelled = true
    }
  }, [selectedEntity, listEntitySources])

  /** 根据 currentNav 自动构造查询 */
  const load = useCallback(async () => {
    setLoading(true)
    setSelectedEntity(null)
    setEntitySources([])
    try {
      const baseLayers: WikiGraphLayer[] = (() => {
        if (layer === 'all') return ['structure', 'entities']
        if (layer === 'structure') return ['structure']
        if (layer === 'entities') return ['entities']
        return []
      })()
      const layers = showHistory && !baseLayers.includes('history')
        ? [...baseLayers, 'history' as const]
        : baseLayers

      let category: string | undefined
      let subtopic: string | undefined
      if (currentNav.kind === 'subtopic') {
        category = currentNav.category
        subtopic = currentNav.subtopic
      } else if (currentNav.kind === 'category') {
        category = currentNav.name
      }
      // 其他 kind（inbox/parking/history）缺省到默认大类
      const data = await getGraphData({ radius: 1, limit: 50, layers, category, subtopic })
      setGraph(data)
    } finally {
      setLoading(false)
    }
  }, [currentNav, layer, showHistory, getGraphData])

  /** 从本目录抽取实体 */
  const handleExtractEro = useCallback(async () => {
    setExtractMsg('正在 AI 抽取实体关系…')
    const scope: { category?: string; subtopic?: string } = {}
    if (currentNav.kind === 'subtopic') {
      scope.category = currentNav.category
      scope.subtopic = currentNav.subtopic
    } else if (currentNav.kind === 'category') {
      scope.category = currentNav.name
    }
    const r = await runLongTask('抽取实体关系', () => extractEroFromSources(scope))
    if (r) {
      const scanned = r.sourcesScanned ?? 0
      const skipped = r.sourcesSkipped ?? 0
      const failed = r.sourcesFailed ?? 0
      const errHint = failed > 0 ? `，${failed} 个失败` : ''
      setExtractMsg(
        `已扫描 ${scanned} 个资料（跳过 ${skipped}）：${r.entitiesUpserted} 实体、${r.relationsUpserted} 关系、${r.observationsAdded} 观察${errHint}`,
      )
      void load()
    } else {
      setExtractMsg('AI 抽取失败')
    }
  }, [currentNav, extractEroFromSources, load, runLongTask])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!filteredGraph) {
      setNodes([])
      setEdges([])
      return
    }
    const rawNodes: Node[] = filteredGraph.nodes.map((n) => {
      let nodeType = 'wikiPage'
      if (n.kind === 'entity') nodeType = 'wikiEntity'
      else if (n.kind === 'source') nodeType = 'wikiSource'
      return {
        id: n.id,
        type: nodeType,
        position: { x: 0, y: 0 },
        data: {
          title: n.title,
          category: n.category,
          useCount: n.useCount,
          kind: n.kind,
          entityType: n.entityType,
          mediaType: (n as { mediaType?: string }).mediaType,
        },
      }
    })
    const rawEdges: Edge[] = filteredGraph.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: e.label || e.anchorText || '',
      style:
        e.kind === 'sibling' || e.kind === 'mentioned_in'
          ? { strokeDasharray: '4 4' }
          : undefined,
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

  /** 节点点击：source 打开，entity 侧栏，category/subtopic 导航 */
  const onNodeClick = useCallback(
    (_: React.MouseEvent, node: Node) => {
      const kind = node.data?.kind as string | undefined
      if (kind === 'entity') {
        setSelectedEntity({
          id: node.id,
          title: String(node.data?.title ?? ''),
          entityType: node.data?.entityType as string | undefined,
        })
        return
      }
      if (kind === 'source') {
        void openSource(node.id).catch(() => {
          alert('无法打开原文件')
        })
        return
      }
      if (kind === 'subtopic') {
        const subtopic = String(node.data?.title ?? '')
        const category = String(node.data?.category ?? '')
        if (category) onNavigateTo({ kind: 'subtopic', category, subtopic })
        return
      }
      if (kind === 'category') {
        const name = String(node.data?.title ?? '')
        if (name) onNavigateTo({ kind: 'category', name })
        return
      }
    },
    [openSource, onNavigateTo],
  )

  const emptyHint = useMemo(() => {
    if (loading) return '加载中…'
    if (filteredGraph && filteredGraph.nodes.length === 0) {
      return layer === 'entities' ? '当前范围内暂无实体，请先点击「抽取实体」' : '当前范围内暂无节点'
    }
    return null
  }, [loading, filteredGraph, layer])

  return (
    <div className="wiki-graph-view">
      <div className="wiki-cleanup-header">
        <h3>知识图谱</h3>
        <div className="wiki-cleanup-actions">
          <Button variant="primary" size="sm" disabled={loading} onClick={() => void load()}>
            刷新
          </Button>
          <Button variant="secondary" size="sm" onClick={() => void handleExtractEro()}>
            从本目录抽取实体
          </Button>
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
          <label style={{ marginLeft: 16, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={showHistory}
              onChange={(e) => setShowHistory(e.target.checked)}
            />
            <span style={{ marginLeft: 4 }}>包含历史页面</span>
          </label>
        </div>
      )}

      {extractMsg && <p className="wiki-empty-hint">{extractMsg}</p>}
      {graph?.truncated && <p className="wiki-empty-hint">节点已截断至上限</p>}
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
              <section className="wiki-graph-entity-sources" aria-label="出现于以下资料">
                <h5>出现于以下资料</h5>
                {sourcesLoading ? (
                  <p className="wiki-empty-hint">加载中…</p>
                ) : entitySources.length === 0 ? (
                  <p className="wiki-empty-hint">暂无资料</p>
                ) : (
                  <ul className="wiki-graph-entity-source-list">
                    {entitySources.map((src) => (
                      <li key={src.id} className="wiki-graph-entity-source-item">
                        <div>
                          <p style={{ fontWeight: 500 }}>{src.title}</p>
                          {src.topicCategory && (
                            <p style={{ fontSize: 11, color: 'var(--color-text-tertiary)' }}>
                              {src.topicCategory}
                              {src.topicSubtopic && ` / ${src.topicSubtopic}`}
                            </p>
                          )}
                        </div>
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => void openSource(src.id).catch(() => alert('无法打开'))}
                        >
                          打开
                        </Button>
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
