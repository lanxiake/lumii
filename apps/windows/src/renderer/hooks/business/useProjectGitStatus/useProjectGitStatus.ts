/**
 * useProjectGitStatus — 只读获取项目的 Git 状态（分支/ahead-behind/远程/文件状态）
 *
 * 数据拉取走通用 useQuery：projectName 变化自动重新拉取，附带竞态保护与 5 分钟缓存。
 * 注意 projectName 为 null 时查询不执行，对外状态恒为 null（与原实现一致）。
 */
import { useQuery } from '../../common/useQuery'
import type { ProjectGitStatus } from '@main/project-git/types'

export function useProjectGitStatus(projectName: string | null) {
  const { data } = useQuery<ProjectGitStatus | null>({
    queryKey: ['project-git-status', projectName],
    queryFn: async () => {
      if (!projectName) return null
      return window.electronAPI.app.getProjectGitStatus(projectName)
    },
    enabled: !!projectName,
  })

  // enabled=false 时 data 会保留上一个项目的值（或缓存），对外按原语义收敛为 null
  return { status: projectName ? data : null }
}
