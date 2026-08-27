/**
 * WikiGraphView：知识图谱图层、实体侧栏与节点交互
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import {
  WikiGraphView,
  filterGraph,
} from '../../renderer/pages/MemoriesPage/components/WikiGraphView'
import type { WikiGraphDataItem } from '../../renderer/hooks/business/useWikiPage'

vi.mock('@xyflow/react', () => {
  const ReactMod = require('react')
  return {
    ReactFlow: ({
      nodes,
      edges,
      onNodeClick,
    }: {
      nodes: Array<{ id: string; type?: string; data?: Record<string, unknown> }>
      edges: Array<{ id: string; label?: string }>
      onNodeClick?: (event: React.MouseEvent, node: { id: string; data?: Record<string, unknown> }) => void
    }) => (
      <div data-testid="react-flow">
        {nodes.map((n) => (
          <button
            key={n.id}
            type="button"
            data-testid={`node-${n.id}`}
            data-node-type={n.type}
            onClick={(e) => onNodeClick?.(e, n)}
          >
            {String(n.data?.title ?? n.id)}
          </button>
        ))}
        <div data-testid="edges">
          {edges.map((e) => (
            <span key={e.id} data-testid={`edge-${e.id}`}>
              {e.label}
            </span>
          ))}
        </div>
      </div>
    ),
    Background: () => null,
    Controls: () => null,
    Handle: () => null,
    Position: { Left: 'left', Right: 'right' },
    useNodesState: (initial: unknown[]) => {
      const [nodes, setNodes] = ReactMod.useState(initial)
      return [nodes, setNodes, vi.fn()]
    },
    useEdgesState: (initial: unknown[]) => {
      const [edges, setEdges] = ReactMod.useState(initial)
      return [edges, setEdges, vi.fn()]
    },
  }
})

vi.mock('@dagrejs/dagre', () => ({
  default: {
    graphlib: {
      Graph: class {
        setDefaultEdgeLabel() {}
        setGraph() {}
        setNode() {}
        setEdge() {}
        node() {
          return { x: 100, y: 100 }
        }
      },
    },
    layout: () => {},
  },
}))

const MOCK_GRAPH: WikiGraphDataItem = {
  nodes: [
    { id: 'p1', kind: 'page', title: '页A', path: 'sources/a', category: 'sources', useCount: 0 },
    { id: 'entity:e1', kind: 'entity', title: '实体E', entityType: 'concept', pageId: 'p1' },
  ],
  edges: [
    { id: 'l1', kind: 'wikilink', source: 'p1', target: 'p1', label: '自链', anchorText: '自链' },
    { id: 'r1', kind: 'relation', source: 'entity:e1', target: 'entity:e1', label: 'related_to', strength: 0.5 },
  ],
  truncated: false,
}

function renderWikiGraphView(
  overrides: Partial<Parameters<typeof WikiGraphView>[0]> = {},
  graphData: WikiGraphDataItem | null = MOCK_GRAPH,
) {
  const getGraphData = vi.fn(async () => graphData)
  const onOpenPage = vi.fn()
  const bootstrapEro = vi.fn(async () => ({ entities: 1, relations: 1 }))
  const runLongTask = vi.fn()
  /** 记录长任务调度并执行传入操作。 */
  const executeLongTask = async <T,>(title: string, fn: () => Promise<T>): Promise<T> => {
    runLongTask(title, fn)
    return fn()
  }
  const listEntityObservations = vi.fn(async () => [])

  render(
    <WikiGraphView
      pages={[{ id: 'p1', path: 'sources/a', category: 'sources', title: '页A', version: 1, updatedAt: 1 }]}
      getGraphData={getGraphData}
      onOpenPage={onOpenPage}
      bootstrapEro={bootstrapEro}
      runLongTask={executeLongTask}
      listEntityObservations={listEntityObservations}
      {...overrides}
    />,
  )

  return { getGraphData, onOpenPage, bootstrapEro, runLongTask, listEntityObservations }
}

/** 选择分类并加载图谱 */
async function loadGraphByCategory(category = 'sources') {
  fireEvent.change(screen.getByDisplayValue('或分类…'), { target: { value: category } })
  fireEvent.click(screen.getByRole('button', { name: '查看图谱' }))
  await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument())
}

describe('filterGraph', () => {
  it('全部图层返回原图', () => {
    expect(filterGraph(MOCK_GRAPH, 'all')).toEqual(MOCK_GRAPH)
  })

  it('仅实体关系过滤页面节点与 wikilink 边', () => {
    const filtered = filterGraph(MOCK_GRAPH, 'entities')
    expect(filtered.nodes).toHaveLength(1)
    expect(filtered.nodes[0]?.kind).toBe('entity')
    expect(filtered.edges).toHaveLength(1)
    expect(filtered.edges[0]?.kind).toBe('relation')
  })

  it('仅页面双链过滤实体节点与 relation 边', () => {
    const filtered = filterGraph(MOCK_GRAPH, 'pages')
    expect(filtered.nodes).toHaveLength(1)
    expect(filtered.nodes[0]?.kind).toBe('page')
    expect(filtered.edges).toHaveLength(1)
    expect(filtered.edges[0]?.kind).toBe('wikilink')
  })
})

describe('WikiGraphView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('标题为知识图谱；图层可过滤仅实体关系', async () => {
    renderWikiGraphView()
    expect(screen.getByText('知识图谱')).toBeInTheDocument()

    await loadGraphByCategory()
    expect(screen.getByTestId('node-p1')).toBeInTheDocument()
    expect(screen.getByTestId('node-entity:e1')).toBeInTheDocument()
    expect(screen.getByTestId('edge-l1')).toHaveTextContent('自链')

    fireEvent.click(screen.getByRole('tab', { name: '仅实体关系' }))

    await waitFor(() => {
      expect(screen.queryByTestId('node-p1')).not.toBeInTheDocument()
      expect(screen.getByTestId('node-entity:e1')).toBeInTheDocument()
      expect(screen.queryByTestId('edge-l1')).not.toBeInTheDocument()
      expect(screen.getByTestId('edge-r1')).toHaveTextContent('related_to')
    })
  })

  it('页面节点点击调用 onOpenPage；实体节点打开侧栏', async () => {
    const { onOpenPage } = renderWikiGraphView()
    await loadGraphByCategory()

    fireEvent.click(screen.getByTestId('node-p1'))
    expect(onOpenPage).toHaveBeenCalledWith('p1')

    fireEvent.click(screen.getByTestId('node-entity:e1'))
    expect(onOpenPage).toHaveBeenCalledTimes(1)
    const sidebar = screen.getByLabelText('实体详情')
    expect(within(sidebar).getByRole('heading', { name: '实体E' })).toBeInTheDocument()
    expect(within(sidebar).getByText('concept')).toBeInTheDocument()
    expect(within(sidebar).getByRole('button', { name: '打开关联页面' })).toBeInTheDocument()
  })

  it('实体侧栏打开关联页按钮调用 onOpenPage', async () => {
    const { onOpenPage } = renderWikiGraphView()
    await loadGraphByCategory()

    fireEvent.click(screen.getByTestId('node-entity:e1'))
    fireEvent.click(within(screen.getByLabelText('实体详情')).getByRole('button', { name: '打开关联页面' }))
    expect(onOpenPage).toHaveBeenCalledWith('p1')
  })

  it('边标签优先 label，否则 anchorText', async () => {
    const graph: WikiGraphDataItem = {
      nodes: [{ id: 'p1', kind: 'page', title: '页A', category: 'sources', useCount: 0 }],
      edges: [
        { id: 'e1', kind: 'wikilink', source: 'p1', target: 'p1', label: '', anchorText: '锚文本' },
      ],
      truncated: false,
    }
    renderWikiGraphView({}, graph)
    await loadGraphByCategory()
    expect(screen.getByTestId('edge-e1')).toHaveTextContent('锚文本')
  })

  it('保留从双链生成 ERO 按钮', () => {
    renderWikiGraphView()
    expect(screen.getByRole('button', { name: '从双链生成 ERO' })).toBeInTheDocument()
  })

  it('抽取实体关系通过长任务执行器运行', async () => {
    const extractEro = vi.fn(async () => ({
      pagesProcessed: 1,
      entitiesUpserted: 2,
      relationsUpserted: 1,
      observationsAdded: 3,
      errors: [],
    }))
    const { runLongTask } = renderWikiGraphView({ extractEro })

    fireEvent.click(screen.getByRole('button', { name: '抽取实体关系' }))

    await waitFor(() => {
      expect(runLongTask).toHaveBeenCalledWith('抽取图谱实体', expect.any(Function))
      expect(extractEro).toHaveBeenCalledTimes(1)
    })
  })

  it('实体侧栏展示观察摘要；无观察时显示暂无观察', async () => {
    const listEntityObservations = vi.fn(async () => [
      { id: 'o1', entityId: 'entity:e1', content: '第一条观察', sourcePageId: 'p1', createdAt: '2026-01-01' },
      { id: 'o2', entityId: 'entity:e1', content: '第二条观察', sourcePageId: null, createdAt: '2026-01-02' },
    ])
    renderWikiGraphView({ listEntityObservations })
    await loadGraphByCategory()

    fireEvent.click(screen.getByTestId('node-entity:e1'))
    const sidebar = screen.getByLabelText('实体详情')
    await waitFor(() => {
      expect(listEntityObservations).toHaveBeenCalledWith('entity:e1')
      expect(within(sidebar).getByText('第一条观察')).toBeInTheDocument()
      expect(within(sidebar).getByText('第二条观察')).toBeInTheDocument()
    })
    expect(within(sidebar).getByRole('button', { name: '来源页' })).toBeInTheDocument()
  })

  it('实体无观察时侧栏显示暂无观察', async () => {
    const listEntityObservations = vi.fn(async () => [])
    renderWikiGraphView({ listEntityObservations })
    await loadGraphByCategory()

    fireEvent.click(screen.getByTestId('node-entity:e1'))
    await waitFor(() => {
      expect(within(screen.getByLabelText('实体详情')).getByText('暂无观察')).toBeInTheDocument()
    })
  })

  it('切换图层时关闭实体侧栏', async () => {
    renderWikiGraphView()
    await loadGraphByCategory()

    fireEvent.click(screen.getByTestId('node-entity:e1'))
    expect(screen.getByLabelText('实体详情')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '仅页面双链' }))
    expect(screen.queryByLabelText('实体详情')).not.toBeInTheDocument()
  })
})
