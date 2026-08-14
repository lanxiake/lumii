/**
 * 全局类型声明
 */

import type { ElectronAPI } from '../preload/index'

declare global {
  interface Window {
    electronAPI: ElectronAPI
    /** Agent App UI 状态回读（主进程 executeJavaScript 调用） */
    __LUMII_APP_UI_STATE__?: () => string
  }
}

declare module '*?raw' {
  const content: string
  export default content
}

declare module '*.png' {
  const src: string
  export default src
}

declare module '*.jpg' {
  const src: string
  export default src
}

declare module '*.jpeg' {
  const src: string
  export default src
}

declare module '*.webp' {
  const src: string
  export default src
}

declare module '*.svg' {
  const src: string
  export default src
}

declare module '*.mp4' {
  const src: string
  export default src
}

declare module '@app-assets/*' {
  const src: string
  export default src
}

declare module '@app-assets/splash.mp4' {
  const src: string
  export default src
}

declare module '@app-assets/splash-poster.jpg' {
  const src: string
  export default src
}

export {}
