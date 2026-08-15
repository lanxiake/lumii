/**
 * useProjectGitStatus — 只读获取项目的 Git 状态（分支/ahead-behind/远程/文件状态）
 */
import { useCallback, useEffect, useState } from 'react'
import type { ProjectGitStatus } from '@main/project-git/types'

export function useProjectGitStatus(projectName: string | null) {
  const [status, setStatus] = useState<ProjectGitStatus | null>(null)
  const [loading, setLoading] = useState(false)

  const refresh = useCallback(async () => {
    if (!projectName) {
      setStatus(null)
      return
    }
    setLoading(true)
    try {
      const result = await window.electronAPI.app.getProjectGitStatus(projectName)
      setStatus(result)
    } finally {
      setLoading(false)
    }
  }, [projectName])

  useEffect(() => {
    void refresh()
  }, [refresh])

  return { status, loading, refresh }
}
