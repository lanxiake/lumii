/**
 * 全局类型声明
 */

import type { ElectronAPI } from '../preload/index'

declare global {
  interface Window {
    electronAPI: ElectronAPI
  }
}

declare module '*?raw' {
  const content: string
  export default content
}

export {}
