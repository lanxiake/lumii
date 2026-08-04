/**
 * Pipeline 工具函数
 */

import type { Pipeline, PipelineEdge, CronJob } from '../../../hooks/business/useCron/types'

/**
 * 获取 Pipeline 中涉及的所有 jobId（去重）
 */
export function getPipelineJobIds(pipeline: Pipeline): string[] {
  const ids = new Set<string>()
  for (const edge of pipeline.edges ?? []) {
    ids.add(edge.fromJobId)
    ids.add(edge.toJobId)
  }
  return Array.from(ids)
}

/**
 * 查找 Pipeline 中的入口节点（没有入边的 jobId）
 */
export function findEntryNodes(edges: PipelineEdge[]): string[] {
  const allFrom = new Set(edges.map((e) => e.fromJobId))
  const allTo = new Set(edges.map((e) => e.toJobId))

  return Array.from(allFrom).filter((id) => !allTo.has(id))
}

/**
 * 查找 Pipeline 中的出口节点（没有出边的 jobId）
 */
export function findExitNodes(edges: PipelineEdge[]): string[] {
  const allFrom = new Set(edges.map((e) => e.fromJobId))
  const allTo = new Set(edges.map((e) => e.toJobId))

  return Array.from(allTo).filter((id) => !allFrom.has(id))
}

/**
 * 检测 Pipeline 是否有环（简单 DFS）
 */
export function hasCycle(edges: PipelineEdge[]): boolean {
  const adj = new Map<string, string[]>()
  for (const edge of edges) {
    const list = adj.get(edge.fromJobId) ?? []
    list.push(edge.toJobId)
    adj.set(edge.fromJobId, list)
  }

  const visited = new Set<string>()
  const stack = new Set<string>()

  function dfs(node: string): boolean {
    if (stack.has(node)) return true
    if (visited.has(node)) return false

    visited.add(node)
    stack.add(node)

    for (const next of adj.get(node) ?? []) {
      if (dfs(next)) return true
    }

    stack.delete(node)
    return false
  }

  for (const node of adj.keys()) {
    if (dfs(node)) return true
  }
  return false
}

/**
 * 拓扑排序（返回执行顺序）
 * 如果有环返回 null
 */
export function topologicalSort(edges: PipelineEdge[]): string[] | null {
  if (hasCycle(edges)) return null

  const adj = new Map<string, string[]>()
  const inDegree = new Map<string, number>()
  const allNodes = new Set<string>()

  for (const edge of edges) {
    allNodes.add(edge.fromJobId)
    allNodes.add(edge.toJobId)

    const list = adj.get(edge.fromJobId) ?? []
    list.push(edge.toJobId)
    adj.set(edge.fromJobId, list)

    inDegree.set(edge.toJobId, (inDegree.get(edge.toJobId) ?? 0) + 1)
  }

  // 初始化入度为 0 的节点
  const queue: string[] = []
  for (const node of allNodes) {
    if (!inDegree.has(node) || inDegree.get(node) === 0) {
      queue.push(node)
    }
  }

  const result: string[] = []
  while (queue.length > 0) {
    const node = queue.shift()!
    result.push(node)

    for (const next of adj.get(node) ?? []) {
      const newDeg = (inDegree.get(next) ?? 1) - 1
      inDegree.set(next, newDeg)
      if (newDeg === 0) {
        queue.push(next)
      }
    }
  }

  return result.length === allNodes.size ? result : null
}

/**
 * 生成 Pipeline 摘要描述
 */
export function describePipeline(pipeline: Pipeline, jobNameMap: Map<string, string>): string {
  const edges = pipeline.edges ?? []
  if (edges.length === 0) return '空 Pipeline'

  const entries = findEntryNodes(edges)
  const exits = findExitNodes(edges)

  const entryNames = entries.map((id) => jobNameMap.get(id) ?? id.slice(0, 8)).join(', ')
  const exitNames = exits.map((id) => jobNameMap.get(id) ?? id.slice(0, 8)).join(', ')

  return `${entryNames} → ... → ${exitNames}（${edges.length} 条边）`
}
