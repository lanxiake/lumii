/**
 * 应用相关 API
 */
import { ipcRenderer } from 'electron'

export const appApi = {
  getVersion: () => ipcRenderer.invoke('app:getVersion'),
  quit: () => ipcRenderer.send('app:quit'),
  openExternal: (url: string) => ipcRenderer.invoke('app:openExternal', url),
  showItemInFolder: (filePath: string) => ipcRenderer.invoke('app:showItemInFolder', filePath),
  openLogFile: () => ipcRenderer.invoke('app:openLogFile'),
  getOpenAtLogin: () => ipcRenderer.invoke('app:getOpenAtLogin'),
  setOpenAtLogin: (enable: boolean) => ipcRenderer.invoke('app:setOpenAtLogin', enable),
}

export const splashApi = {
  shouldSkip: () =>
    process.argv.includes('--skip-splash')
    || process.argv.includes('--test-mode')
    || process.argv.includes('--startup-launched')
    || process.env.LUMII_SKIP_SPLASH === '1',
}
