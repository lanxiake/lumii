/**
 * 工作空间服务 — 封装 window.electronAPI.workspace 的薄层
 */

/** 获取当前工作空间目录（主进程权威源） */
export async function getWorkspaceDir(): Promise<string> {
  return window.electronAPI.workspace.getDir()
}

/** 打开目录选择对话框，返回选中的目录；取消返回 null */
export async function selectWorkspaceDir(currentPath?: string): Promise<string | null> {
  return window.electronAPI.workspace.selectDir(currentPath)
}

/** 确保工作空间目录及基本子结构存在 */
export async function ensureWorkspaceDir(dirPath: string): Promise<string> {
  return window.electronAPI.workspace.ensureDir(dirPath)
}

/** 验证并设置工作空间目录（返回主进程实际采用的路径） */
export async function setWorkspaceDir(dirPath: string): Promise<string> {
  return window.electronAPI.workspace.setDir(dirPath)
}

/** 通知主进程工作空间目录已更改（节点重连并上报新路径，无需重启应用） */
export async function notifyWorkspaceChanged(newDirPath?: string): Promise<void> {
  await window.electronAPI.workspace.notifyChanged(newDirPath)
}
