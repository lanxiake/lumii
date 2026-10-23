// 示例：主进程扩展（ESM）。
//
// 要点：
// - manifest 必须与 definition 的 id 一致，description 必填
// - IPC 用 ctx.registerIpc / ctx.registerIpcListener —— 不要直接碰 ipcMain
// - 定时器等副作用放进 ctx.effect，插件停用/热重载时自动清理
export default {
  manifest: {
    id: '__PLUGIN_ID__',
    name: '示例扩展',
    version: '0.1.0',
    description: '主进程扩展示例：注册 IPC、定时器与随插件停用清理的副作用',
    engines: { lumii: '>=0.1.0' },
    kind: 'code',
    main: './main.js',
  },
  definition: {
    id: '__PLUGIN_ID__',
    apply(ctx) {
      let ticks = 0

      // 1) 请求/响应式 IPC（渲染层或 Agent 可 invoke）
      ctx.registerIpc?.('__PLUGIN_ID__:stats', async () => ({ ok: true, ticks }))

      // 2) 单向 IPC（ipcRenderer.send）
      ctx.registerIpcListener?.('__PLUGIN_ID__:reset', () => {
        ticks = 0
      })

      // 3) 定时器：作用域销毁时自动清理
      const timer = setInterval(() => {
        ticks += 1
      }, 60_000)
      ctx.effect(() => clearInterval(timer))

      ctx.log.info('[__PLUGIN_ID__] 已装配')
    },
  },
}
