/**
 * 应用相关 API
 */
import { ipcRenderer, webUtils } from 'electron'

export const appApi = {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  quit: () => ipcRenderer.send('app:quit'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('app:showItemInFolder', filePath),
  openLogFile: () => ipcRenderer.invoke('app:openLogFile'),
  getOpenAtLogin: () => ipcRenderer.invoke('app:getOpenAtLogin'),
  setOpenAtLogin: (enable: boolean) => ipcRenderer.invoke('app:setOpenAtLogin', enable),
  getPathForFile: (file: File) => webUtils.getPathForFile(file),
  getCodingDevEnvInfo: () => ipcRenderer.invoke('app:getCodingDevEnvInfo'),
  listCodingDevToolsMetadata: () => ipcRenderer.invoke('app:listCodingDevToolsMetadata'),
  detectCodingDevTool: (toolId: string) => ipcRenderer.invoke('app:detectCodingDevTool', toolId),
  installCodingDevTool: (toolId: string) => ipcRenderer.invoke('app:installCodingDevTool', toolId),
  uninstallCodingDevTool: (toolId: string) => ipcRenderer.invoke('app:uninstallCodingDevTool', toolId),
  previewUninstallCodingDevTool: (toolId: string) =>
    ipcRenderer.invoke('app:previewUninstallCodingDevTool', toolId),
  loginCodingDevTool: (toolId: string) => ipcRenderer.invoke('app:loginCodingDevTool', toolId),
  setCodingDevAcpWorkspace: (dirPath: string | undefined) =>
    ipcRenderer.invoke('app:setCodingDevAcpWorkspace', dirPath),
  listCodingDevProjects: () => ipcRenderer.invoke('app:listCodingDevProjects'),
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
}
