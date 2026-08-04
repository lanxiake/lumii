import React, { useMemo, useState, useCallback, useEffect } from 'react'
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
import clsx from 'clsx'
import { Bot, Wrench, Cpu } from '../../../components/ui/Icon'
import type { ViewProps, Agent } from './types'
import { agentColor, TIER_LABELS } from './types'
import { decodeGroupFromDescription } from '../components/GenerateTeamWizard/utils'
import { DetailPanel } from './DetailPanel'
import styles from './MapView.module.css'

const NODE_W = 260
const NODE_H = 110

function layoutNodes(rawNodes: Node[], rawEdges: Edge[]) {
  const g = new dagre.graphlib.Graph()
  g.setDefaultEdgeLabel(() => ({}))
  g.setGraph({ rankdir: 'TB', nodesep: 60, ranksep: 80, marginx: 40, marginy: 40 })
  for (const n of rawNodes) {
    g.setNode(n.id, { width: NODE_W, height: NODE_H })
  }
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

function SystemNode({ data }: NodeProps) {
  const agent = data.agent as Agent
  return (
    <div className={styles['node-system']}>
      <Handle type="source" position={Position.Bottom} className={styles.handle} />
      <div className={styles['node-emoji']}><Cpu size={20} /></div>
      <div className={styles['node-body']}>
        <div className={styles['node-name']}>{agent.name}</div>
        <div className={styles['node-desc']}>AI 协调者</div>
        <span className={styles['node-badge--system']}>系统内置</span>
      </div>
    </div>
  )
}

function AgentNode({ data }: NodeProps) {
  const agent = data.agent as Agent
  const runtimeState = data.runtimeState as { anyRunning?: boolean; runningCount?: number } | undefined
  const color = agentColor(agent)
  const toolCount = agent.skillBlacklist ? 6 - agent.skillBlacklist.length : 6
  // 显示干净的 description（去掉 [group:...] 编码）
  const { cleanDescription } = decodeGroupFromDescription(agent.description ?? '')
  return (
    <div className={styles['node-agent']} style={{ borderTopColor: color }}>
      <Handle type="target" position={Position.Top} className={styles.handle} />
      <div className={styles['node-emoji']}>{agent.identity?.emoji ?? <Bot size={20} />}</div>
      <div className={styles['node-body']}>
        <div className={styles['node-name']}>{agent.name}</div>
        {cleanDescription && (
          <div className={styles['node-desc']}>{cleanDescription}</div>
        )}
        <div className={styles['node-tags']}>
          {runtimeState?.anyRunning && (
            <span className={styles['node-tag--running']}>
              <span className={styles['runningDot']} />
              运行中{runtimeState.runningCount ? ` (${runtimeState.runningCount})` : ''}
            </span>
          )}
          {agent.modelTier && (
            <span className={clsx(styles['node-tag'], styles[`node-tag--${agent.modelTier}`])}>
              {TIER_LABELS[agent.modelTier]}
            </span>
          )}
          <span className={styles['node-tag']}><Wrench size={9} />{toolCount}</span>
          {agent.model?.primary && (
            <span className={styles['node-tag--model']}>
              {agent.model.primary.split('/').pop()}
            </span>
          )}
        </div>
      </div>
    </div>
  )
}

const nodeTypes: NodeTypes = {
  systemNode: SystemNode,
  agentNode: AgentNode,
}

export const MapView: React.FC<ViewProps> = ({
  userAgents,
  systemAgents,
  searchQuery,
  runtimeStateMap,
  onEdit,
  onDelete,
  onFork,
  onStartChat,
}) => {
  const [selectedAgent, setSelectedAgent] = useState<Agent | null>(null)

  const { nodes: layoutedNodes, edges: layoutedEdges } = useMemo(() => {
    const nodes: Node[] = []
    const edges: Edge[] = []

    const main =
      systemAgents.find((a) => a.isDefault) ??
      systemAgents.find((a) => a.id === 'main') ??
      systemAgents[0]

    if (!main) return { nodes, edges }

    nodes.push({
      id: main.id,
      position: { x: 0, y: 0 },
      data: { agent: main },
      type: 'systemNode',
    })

    const filtered = userAgents.filter(
      (a) =>
        !searchQuery ||
        a.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        a.description?.toLowerCase().includes(searchQuery.toLowerCase()),
    )

    // 星形拓扑：系统节点直接连所有 Agent
    for (const agent of filtered) {
      nodes.push({
        id: agent.id,
        position: { x: 0, y: 0 },
        data: { agent },
        type: 'agentNode',
      })
      edges.push({
        id: `e-${main.id}-${agent.id}`,
        source: main.id,
        target: agent.id,
        style: { stroke: '#60a5fa', strokeWidth: 2, opacity: 0.4 },
        type: 'smoothstep',
      })
    }

    return layoutNodes(nodes, edges)
  }, [userAgents, systemAgents, searchQuery])

  const [nodes, setNodes, onNodesChange] = useNodesState(layoutedNodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState(layoutedEdges)

  useEffect(() => {
    setNodes(layoutedNodes)
    setEdges(layoutedEdges)
  }, [layoutedNodes, layoutedEdges, setNodes, setEdges])

  // 仅更新运行态，不触发布局重算
  useEffect(() => {
    setNodes((prev) =>
      prev.map((node) => {
        if (node.type !== 'agentNode') return node
        const data = node.data as { agent?: Agent; runtimeState?: unknown }
        return { ...node, data: { ...data, runtimeState: runtimeStateMap[node.id] } }
      }),
    )
  }, [runtimeStateMap, setNodes])

  const handleNodeClick = useCallback((_: React.MouseEvent, node: Node) => {
    if (node.type === 'agentNode') setSelectedAgent(node.data.agent as Agent)
  }, [])

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') setSelectedAgent(null) }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [])

  return (
    <div className={styles.mapContainer}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={handleNodeClick}
        onPaneClick={() => setSelectedAgent(null)}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.3 }}
        minZoom={0.2}
        maxZoom={2}
        proOptions={{ hideAttribution: true }}
      >
        <Background color="rgba(255,255,255,0.03)" gap={24} />
        <Controls showInteractive={false} className={styles.controls} />
      </ReactFlow>

      {selectedAgent && (
        <DetailPanel
          agent={selectedAgent}
          isSystem={!selectedAgent.userId}
          onClose={() => setSelectedAgent(null)}
          onStartChat={onStartChat}
          onEdit={onEdit}
          onDelete={onDelete}
          onFork={onFork}
        />
      )}
    </div>
  )
}
