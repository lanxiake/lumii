/**
 * useSkills.ts - 技能管理 Hook
 *
 * 管理用户已安装技能的自定义 Hook
 * 技能安装状态完全由本地 workspace/skills/ 目录管理
 */

import { useCallback } from 'react'
import { useQuery } from '../../common/useQuery'
import { useMutation } from '../../common/useMutation'
import type {
  InstalledSkillInfo,
  SkillStats,
} from './useSkills.types'

function computeStats(skills: InstalledSkillInfo[] | null): SkillStats {
  if (!skills || skills.length === 0) {
    return { total: 0, enabled: 0, disabled: 0 }
  }
  const enabled = skills.filter((s) => s.isEnabled).length
  return { total: skills.length, enabled, disabled: skills.length - enabled }
}

export function useSkills() {
  const { data, isLoading, error, refetch } = useQuery<InstalledSkillInfo[]>({
    queryKey: ['skills', 'installed'],
    queryFn: async () => {
      console.log('[useSkills] 获取本地技能列表')
      const raw = await window.electronAPI.skills.listLocalInstalled()
      // IPC 返回 { success, data } 格式，兼容旧版裸数组
      const localSkills: any[] = Array.isArray(raw) ? raw : ((raw as any)?.data ?? [])

      const converted: InstalledSkillInfo[] = (localSkills || []).map((s: any) => ({
        id: `local-${s.id}`,
        userId: 'local',
        skillItemId: s.id,
        installedVersion: s.version || '1.0.0',
        isEnabled: s.enabled ?? true,
        installedAt: s.installedAt || new Date().toISOString(),
        lastUsedAt: s.lastExecutedAt,
        category: s.category || '',
        skill: {
          id: s.id,
          name: s.name || s.id,
          description: s.description || '',
          version: s.version || '1.0.0',
          authorName: '本地',
          categoryId: s.category || undefined,
          tags: ['本地'],
          status: 'active',
          downloadCount: 0,
          ratingAvg: undefined,
          ratingCount: 0,
          iconUrl: undefined,
          sourceType: 'user' as const,
          isFeatured: false,
          createdAt: s.installedAt || new Date().toISOString(),
          updatedAt: s.installedAt || new Date().toISOString(),
        },
      }))

      console.log('[useSkills] 本地技能数量:', converted.length)
      return converted
    },
  })

  const installedSkills = data || []
  const stats = computeStats(installedSkills)

  const enableMutation = useMutation<InstalledSkillInfo[], [string]>(
    async (skillItemId: string) => {
      const actualSkillId = skillItemId.replace(/^local-/, '')
      const response = await window.electronAPI.skills.setEnabled(actualSkillId, true)
      if (!response) {
        throw new Error('启用技能失败')
      }
      return installedSkills.map((s) =>
        s.skillItemId === actualSkillId ? { ...s, isEnabled: true } : s
      )
    },
    { onSuccess: () => refetch() }
  )

  const disableMutation = useMutation<InstalledSkillInfo[], [string]>(
    async (skillItemId: string) => {
      const actualSkillId = skillItemId.replace(/^local-/, '')
      const response = await window.electronAPI.skills.setEnabled(actualSkillId, false)
      if (!response) {
        throw new Error('禁用技能失败')
      }
      return installedSkills.map((s) =>
        s.skillItemId === actualSkillId ? { ...s, isEnabled: false } : s
      )
    },
    { onSuccess: () => refetch() }
  )

  const uninstallMutation = useMutation<void, [string]>(
    async (skillItemId: string) => {
      const actualSkillId = skillItemId.replace(/^local-/, '')
      const response = (await window.electronAPI.skills.uninstallLocal(actualSkillId)) as {
        success: boolean
        error?: string
      }
      if (!response.success) {
        throw new Error(response.error || '卸载技能失败')
      }
    },
    { onSuccess: () => refetch() }
  )

  const enableSkill = useCallback(
    async (skillItemId: string): Promise<boolean> => {
      try {
        await enableMutation.mutateAsync(skillItemId)
        return true
      } catch {
        return false
      }
    },
    [enableMutation]
  )

  const disableSkill = useCallback(
    async (skillItemId: string): Promise<boolean> => {
      try {
        await disableMutation.mutateAsync(skillItemId)
        return true
      } catch {
        return false
      }
    },
    [disableMutation]
  )

  const uninstallSkill = useCallback(
    async (skillItemId: string): Promise<boolean> => {
      try {
        await uninstallMutation.mutateAsync(skillItemId)
        return true
      } catch {
        return false
      }
    },
    [uninstallMutation]
  )

  return {
    installedSkills,
    stats,
    isLoading,
    error,
    loadInstalledSkills: refetch,
    enableSkill,
    disableSkill,
    uninstallSkill,
  }
}

/** useSkills 返回值类型，供 index 与其它模块导出 */
export type UseSkillsReturn = ReturnType<typeof useSkills>
