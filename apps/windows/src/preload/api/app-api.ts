/**
 * 应用相关 API
 */
import { ipcRenderer, webUtils } from 'electron'

export const appApi = {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('app:showItemInFolder', filePath),
  openLogFile: () => ipcRenderer.invoke('app:openLogFile'),
  getOpenAtLogin: () => ipcRenderer.invoke('app:getOpenAtLogin'),
  setOpenAtLogin: (enable: boolean) => ipcRenderer.invoke('app:setOpenAtLogin', enable),
  /** 功能可用性（能力矩阵）：渲染层据此置灰入口并展示原因 */
  getFeatureAvailability: () => ipcRenderer.invoke('app:getFeatureAvailability'),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getCodingDevEnvInfo: () => ipcRenderer.invoke('app:getCodingDevEnvInfo'),
  listCodingDevToolsMetadata: () => ipcRenderer.invoke('app:listCodingDevToolsMetadata'),
  detectCodingDevTool: (toolId: string) => ipcRenderer.invoke('app:detectCodingDevTool', toolId),
  installCodingDevTool: (toolId: string) => ipcRenderer.invoke('app:installCodingDevTool', toolId),
  uninstallCodingDevTool: (toolId: string) => ipcRenderer.invoke('app:uninstallCodingDevTool', toolId),
  previewUninstallCodingDevTool: (toolId: string) =>
    ipcRenderer.invoke('app:previewUninstallCodingDevTool', toolId),
  loginCodingDevTool: (toolId: string) => ipcRenderer.invoke('app:loginCodingDevTool', toolId),
  listCodingDevProjects: () => ipcRenderer.invoke('app:listCodingDevProjects'),
  getCodingDevAgentBindings: () => ipcRenderer.invoke('app:getCodingDevAgentBindings'),
  setCodingDevAgentBindings: (bindings: unknown) =>
    ipcRenderer.invoke('app:setCodingDevAgentBindings', bindings),
  createCodingDevProject: (name: string) => ipcRenderer.invoke('app:createCodingDevProject', name),
  openCodingDevProject: (name: string, targetPath: string) =>
    ipcRenderer.invoke('app:openCodingDevProject', name, targetPath),
  removeCodingDevProject: (name: string) => ipcRenderer.invoke('app:removeCodingDevProject', name),
  setCodingDevActiveProject: (name: string) =>
    ipcRenderer.invoke('app:setCodingDevActiveProject', name),
  getProjectGitStatus: (projectName: string) =>
    ipcRenderer.invoke('app:getProjectGitStatus', projectName),
}

export const splashApi = {
  shouldSkip: () =>
    process.argv.includes('--skip-splash')
    || process.argv.includes('--test-mode')
    || process.argv.includes('--startup-launched')
    || process.env.LUMII_SKIP_SPLASH === '1',
  /**
   * 订阅主进程的启动阶段进度，返回取消订阅函数。
   *
   * 早期画面在 React 挂载前就要听，所以这里是 `on` 而不是 `invoke`：
   * 广播是单向的，不需要回执。
   */
  onProgress: (callback: (payload: { phase: string; index: number; total: number }) => void) => {
    const listener = (_e: unknown, payload: { phase: string; index: number; total: number }) =>
      callback(payload)
    ipcRenderer.on('startup:progress', listener)
    return () => ipcRenderer.removeListener('startup:progress', listener)
  },
  /**
   * 拉取已经发生过的启动阶段。
   *
   * 启动的大部分阶段在窗口加载页面之前就发完了，广播全落空；
   * 渲染层就绪后主动问一次，才知道进度该从哪一格开始。
   */
  history: () =>
    ipcRenderer.invoke('splash:history') as Promise<{
      phases: Array<{ phase: string; index: number; total: number }>
      total: number
    }>,
}
