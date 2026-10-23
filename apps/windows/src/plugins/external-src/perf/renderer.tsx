import type { RendererPlugin } from '../../api'
import { PerformanceDiagnostics } from './ui/PerformanceDiagnostics/PerformanceDiagnostics'
import { startRendererMemoryProbe } from './ui/renderer-memory-probe'

const OWNER = 'com.lumii.perf'

/**
 * 性能监控的渲染层半边。
 *
 * - `settings.section.perf`：设置 › 关于与更新 里的诊断面板；
 * - 渲染进程内存采样：`setup` 时启动、`dispose` 时停（每分钟上报一次，
 *   停用后必须真的停，否则通道已摘掉、探针还在 invoke）。
 *
 * 这是**仓库内**的渲染层半边（随主进程一起打 bundle），不是外部 `client.js`；
 * 官方外部扩展的 client 半边尚未纳入打包流水线（见 plugins/README.md）。
 */
export const perfRenderer: RendererPlugin = {
  id: OWNER,
  setup(api) {
    const stopProbe = startRendererMemoryProbe()
    const off = api.registerSlot('settings.section.perf', {
      id: 'perf.diagnostics',
      component: PerformanceDiagnostics,
      owner: OWNER,
    })
    return () => {
      off()
      stopProbe()
    }
  },
}

export default perfRenderer
