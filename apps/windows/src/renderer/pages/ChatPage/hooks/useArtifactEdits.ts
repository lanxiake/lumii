/**
 * 已应用的本地编辑（P2 T1）
 *
 * 工作台 rail 需要把「工作台改过 / 手工保存过」的产物也算进来，否则本地编辑
 * 在 UI 上不存在。数据源是主进程的 `.lumii/edits/index.jsonl`；这里只做拉取与
 * 事件刷新，不做合并（合并是 `WorkspaceArtifactsPanel/local-edits.ts` 的纯函数）。
 */

import { useCallback, useEffect, useState } from 'react'
import type { LocalArtifactEdit } from '../../../../shared/artifact-edit-types'
import { artifactEditService } from '../../../services/artifact-edit-service'

/** 应用/撤销后由调用方派发；所有打开中的工作台会刷新（调用方 helper 在 T2 接） */
export const ARTIFACT_EDITS_CHANGED_EVENT = 'lumii:artifact-edits-changed'

export function useArtifactEdits(
  sessionKey: string | undefined,
  enabled: boolean,
): { edits: readonly LocalArtifactEdit[]; refresh: () => Promise<void> } {
  const [edits, setEdits] = useState<readonly LocalArtifactEdit[]>([])

  const refresh = useCallback(async () => {
    if (!sessionKey) {
      setEdits([])
      return
    }
    try {
      const result = await artifactEditService.listEdits(sessionKey, 100)
      if (result.ok) setEdits(result.edits)
    } catch {
      // 读不到就保持现状；下次打开工作台会再试
    }
  }, [sessionKey])

  useEffect(() => {
    if (!enabled || !sessionKey) return
    void refresh()
  }, [enabled, sessionKey, refresh])

  useEffect(() => {
    const handler = () => void refresh()
    window.addEventListener(ARTIFACT_EDITS_CHANGED_EVENT, handler)
    return () => window.removeEventListener(ARTIFACT_EDITS_CHANGED_EVENT, handler)
  }, [refresh])

  return { edits, refresh }
}
