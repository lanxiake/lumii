/**
 * 独立 Vite 配置 - 仅用于浏览器测试 Windows renderer
 * 不需要 electron-vite，直接用 vite 启动 renderer 部分
 */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(__dirname, 'src/renderer'),
      '@renderer': resolve(__dirname, 'src/renderer'),
      '@shared': resolve(__dirname, 'src/shared'),
    },
  },
  server: {
    port: 5199,
    strictPort: true,
  },
})
