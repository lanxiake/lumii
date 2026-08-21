/**
 * usePipelines - Pipeline CRUD Hook（灵栖/Lumii 独立版：无网关，降级为空实现）
 *
 * Pipeline DAG 编排原依赖 Gateway WebSocket，独立版无网关连接，
 * 故列表恒为空、增删改查均 no-op，仅保留接口以兼容 PipelinesTab。
 */

import { useCallback } from 'react'
import type { Pipeline } from './types'

export interface CreatePipelineParams {
  name: string
  description?: string
  edges?: Array<{ fromJobId: string; toJobId: string; artifact?: string }>
}

export interface UpdatePipelineParams {
  name?: string
  description?: string | null
  enabled?: boolean
  edges?: Array<{ fromJobId: string; toJobId: string; artifact?: string }>
}

export function usePipelines() {
  const noopFetch = useCallback(async () => {}, [])
  const getPipeline = useCallback(async (_id: string): Promise<Pipeline | null> => null, [])
  const createPipeline = useCallback(
    async (_params: CreatePipelineParams): Promise<Pipeline | null> => null,
    [],
  )
  const updatePipeline = useCallback(
    async (_id: string, _params: UpdatePipelineParams): Promise<boolean> => false,
    [],
  )
  const removePipeline = useCallback(async (_id: string): Promise<boolean> => false, [])

  return {
    pipelines: [] as Pipeline[],
    loading: false,
    error: null as string | null,
    fetchPipelines: noopFetch,
    getPipeline,
    createPipeline,
    updatePipeline,
    removePipeline,
  }
}
