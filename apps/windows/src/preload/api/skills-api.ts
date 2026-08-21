/**
 * 技能相关 API
 */
import { ipcRenderer } from 'electron'

export const skillsApi = {
  listLocalInstalled: () => ipcRenderer.invoke('skills:listLocalInstalled'),
  installFromDirectory: (sourceDir: string) =>
    ipcRenderer.invoke('skills:installFromDirectory', sourceDir),
  importDirectory: (sourceDir: string) => ipcRenderer.invoke('skills:importDirectory', sourceDir),
  uninstallLocal: (skillId: string) => ipcRenderer.invoke('skills:uninstallLocal', skillId),
  executeLocal: (params: {
    skillId: string
    params: Record<string, unknown>
    timeoutMs?: number
  }) => ipcRenderer.invoke('skills:executeLocal', params),
  setEnabled: (skillId: string, enabled: boolean) =>
    ipcRenderer.invoke('skills:setEnabled', skillId, enabled),
  getSkillDetail: (skillId: string) => ipcRenderer.invoke('skills:getSkillDetail', skillId),
  refresh: () => ipcRenderer.invoke('skills:refresh'),
  getSkillDir: (skillId: string) => ipcRenderer.invoke('skills:getSkillDir', skillId),
  installFromScript: (filePath: string, meta?: { name?: string; description?: string }) =>
    ipcRenderer.invoke('skills:installFromScript', filePath, meta),
}
