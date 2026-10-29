import type { RendererPlugin } from '../../api'
import { PerformanceDiagnostics } from './ui/PerformanceDiagnostics/PerformanceDiagnostics'
import { startRendererPerfProbe } from './ui/renderer-perf-probe'

const OWNER = 'com.lumii.perf'

/**
 * 性能监控的渲染层半边。
 *
 * - `settings.section.perf`：设置 › 隐私与数据 里的诊断面板（今日慢事件分析）；
 * - 渲染层探针：`setup` 时启动、`dispose` 时停（长任务 + 关键交互 + 内存尖峰，
 *   停用后必须真的停，否则通道已摘掉、探针还在 invoke）。
 *
 * 这是**仓库内**的渲染层半边（随主进程一起打 bundle），不是外部 `client.js`。
 */
export const perfRenderer: RendererPlugin = {
  id: OWNER,
  setup(api) {
    const stopProbe = startRendererPerfProbe()
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
