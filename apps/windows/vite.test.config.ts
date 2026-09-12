/**
 * 独立 Vite 配置 - 仅用于浏览器测试 Windows renderer
 * 不需要 electron-vite，直接用 vite 启动 renderer 部分
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { appPath } from './paths'

export default defineConfig({
  root: appPath.renderer,
  plugins: [react()],
  resolve: {
    alias: {
      // `@` 统一指向 src（与 tsconfig paths、vitest、electron.vite 一致）
      '@': appPath.src,
      '@renderer': appPath.renderer,
      '@shared': appPath.shared,
    },
  },
  server: {
    port: 5199,
    strictPort: true,
  },
})
