/**
 * WikiGraphView：三期图层、实体侧栏与节点交互
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'
import '@testing-library/jest-dom'
import { WikiGraphView } from '../../renderer/pages/MemoriesPage/components/WikiGraphView'
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

const STRUCTURE_GRAPH: WikiGraphDataItem = {
  nodes: [
    { id: '做事记录', kind: 'category', title: '做事记录' },
    { id: '["做事记录","会议聊天记录"]', kind: 'subtopic', title: '会议聊天记录', category: '做事记录' },
    { id: 's1', kind: 'source', title: '会议A.pdf' },
  ],
  edges: [
    {
      id: 'b1',
      kind: 'belongs_to',
      source: 's1',
      target: '["做事记录","会议聊天记录"]',
      label: 'belongs_to',
    },
    {
      id: 'b2',
      kind: 'belongs_to',
      source: '["做事记录","会议聊天记录"]',
      target: '做事记录',
      label: 'belongs_to',
    },
  ],
  truncated: false,
}

const MIXED_GRAPH: WikiGraphDataItem = {
  nodes: [
    { id: 's1', kind: 'source', title: '会议A.pdf' },
    { id: 'entity:e1', kind: 'entity', title: '实体E', entityType: 'concept' },
  ],
  edges: [
    { id: 'm1', kind: 'mentioned_in', source: 'entity:e1', target: 's1', label: 'mentioned_in' },
    { id: 'r1', kind: 'relation', source: 'entity:e1', target: 'entity:e1', label: 'related_to', strength: 0.5 },
  ],
  truncated: false,
}

function renderWikiGraphView(
  overrides: Partial<Parameters<typeof WikiGraphView>[0]> = {},
  graphData: WikiGraphDataItem | null = MIXED_GRAPH,
) {
  const getGraphData = vi.fn(async () => graphData)
  const openSource = vi.fn(async () => {})
  const onNavigateTo = vi.fn()
  const extractEroFromSources = vi.fn(async () => ({
    sourcesScanned: 1,
    sourcesSkipped: 0,
    sourcesFailed: 0,
    entitiesUpserted: 2,
    relationsUpserted: 1,
    observationsAdded: 3,
    errors: [],
  }))
  const runLongTask = vi.fn()
  /** 记录长任务调度并执行传入操作。 */
  const executeLongTask = async <T,>(title: string, fn: () => Promise<T>): Promise<T> => {
    runLongTask(title, fn)
    return fn()
  }
  const listEntitySources = vi.fn(async () => [])

  const onPreviewSource = vi.fn()
  render(
    <WikiGraphView
      currentNav={{ kind: 'graph' }}
      getGraphData={getGraphData}
      extractEroFromSources={extractEroFromSources}
      listEntitySources={listEntitySources}
      openSource={openSource}
      onPreviewSource={onPreviewSource}
      onNavigateTo={onNavigateTo}
      runLongTask={executeLongTask}
      {...overrides}
    />,
  )

  return { getGraphData, openSource, onPreviewSource, onNavigateTo, extractEroFromSources, runLongTask, listEntitySources }
}

describe('WikiGraphView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('标题为知识图谱；渲染结构层节点与 belongs_to 边', async () => {
    renderWikiGraphView({}, STRUCTURE_GRAPH)
    expect(screen.getByText('知识图谱')).toBeInTheDocument()

    await waitFor(() => {
      expect(screen.getByTestId('node-做事记录')).toBeInTheDocument()
      expect(screen.getByTestId('node-["做事记录","会议聊天记录"]')).toBeInTheDocument()
      expect(screen.getByTestId('node-s1')).toBeInTheDocument()
    })
  })

  it('点击 subtopic 节点调用 onNavigateTo', async () => {
    const { onNavigateTo } = renderWikiGraphView({}, STRUCTURE_GRAPH)
    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('node-["做事记录","会议聊天记录"]'))
    expect(onNavigateTo).toHaveBeenCalledWith({ kind: 'subtopic', category: '做事记录', subtopic: '会议聊天记录' })
  })

  it('点击 category 节点调用 onNavigateTo', async () => {
    const { onNavigateTo } = renderWikiGraphView({}, STRUCTURE_GRAPH)
    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('node-做事记录'))
    expect(onNavigateTo).toHaveBeenCalledWith({ kind: 'category', name: '做事记录' })
  })

  it('点击 source 节点调用 onPreviewSource', async () => {
    const { onPreviewSource } = renderWikiGraphView({}, STRUCTURE_GRAPH)
    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('node-s1'))
    expect(onPreviewSource).toHaveBeenCalledWith('s1')
  })

  it('点击实体节点打开侧栏并展示出现的资料', async () => {
    const listEntitySources = vi.fn(async () => [
      { id: 's1', title: '会议A.pdf', sourcePath: null, topicCategory: '做事记录', topicSubtopic: '会议聊天记录', mediaType: 'application/pdf' },
    ])
    renderWikiGraphView({ listEntitySources })
    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('node-entity:e1'))
    const sidebar = screen.getByLabelText('实体详情')
    expect(within(sidebar).getByRole('heading', { name: '实体E' })).toBeInTheDocument()

    await waitFor(() => {
      expect(listEntitySources).toHaveBeenCalledWith('entity:e1')
      expect(within(sidebar).getByText('会议A.pdf')).toBeInTheDocument()
    })
  })

  it('实体侧栏点打开按钮调用 openSource', async () => {
    const listEntitySources = vi.fn(async () => [
      { id: 's1', title: '会议A.pdf', sourcePath: null, topicCategory: '做事记录', topicSubtopic: '会议聊天记录', mediaType: 'application/pdf' },
    ])
    const { openSource } = renderWikiGraphView({ listEntitySources })
    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('node-entity:e1'))
    await waitFor(() => expect(screen.getByText('会议A.pdf')).toBeInTheDocument())
    fireEvent.click(within(screen.getByLabelText('实体详情')).getByRole('button', { name: '打开' }))
    expect(openSource).toHaveBeenCalledWith('s1')
  })

  it('实体无资料时侧栏显示暂无资料', async () => {
    renderWikiGraphView()
    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('node-entity:e1'))
    await waitFor(() => {
      expect(within(screen.getByLabelText('实体详情')).getByText('暂无资料')).toBeInTheDocument()
    })
  })

  it('从当前图谱抽取实体时传入可见 source 节点 id', async () => {
    const { runLongTask, extractEroFromSources } = renderWikiGraphView()

    await waitFor(() => expect(screen.getByTestId('node-s1')).toBeInTheDocument())
    fireEvent.click(screen.getByRole('button', { name: '从当前图谱抽取实体' }))

    await waitFor(() => {
      expect(runLongTask).toHaveBeenCalledWith('抽取实体关系', expect.any(Function))
      expect(extractEroFromSources).toHaveBeenCalledWith({ sourceIds: ['s1'] })
    })
  })

  it('历史页双链开关默认关闭', async () => {
    const getGraphData = vi.fn(async (_query: unknown) => MIXED_GRAPH)
    renderWikiGraphView({ getGraphData })
    await waitFor(() => expect(getGraphData).toHaveBeenCalled())

    const call = getGraphData.mock.calls[0] as [{ layers?: string[] }] | undefined
    expect(call).toBeDefined()
    expect(call![0]!.layers).not.toContain('history')
  })

  it('切换图层时关闭实体侧栏', async () => {
    renderWikiGraphView()
    await waitFor(() => expect(screen.getByTestId('react-flow')).toBeInTheDocument())

    fireEvent.click(screen.getByTestId('node-entity:e1'))
    expect(screen.getByLabelText('实体详情')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('tab', { name: '结构' }))
    expect(screen.queryByLabelText('实体详情')).not.toBeInTheDocument()
  })
})
