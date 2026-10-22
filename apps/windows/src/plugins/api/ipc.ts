/**
 * 插件内注册 IPC 的**唯一写法**。
 *
 * handler 一多，逐个 `ctx.registerIpc` 会散落在整个文件里，看不出「哪些通道归这个插件」。
 * 先攒表、apply 时一次性挂载：
 *
 * ```ts
 * const table = createIpcTable()
 * table.register('foo:bar', async (_event, x: string) => …)
 * apply(ctx) { table.install((ch, fn) => ctx.registerIpc?.(ch, fn)) }
 * ```
 *
 * 表只承载「通道 → handler」，不持有生命周期：挂载由 `ctx.registerIpc` 完成，
 * 停用插件时随作用域自动 `removeHandler` —— **不要**在这里直接 `ipcMain.handle`。
 */
export type IpcHandler = (event: unknown, ...args: any[]) => unknown

export interface IpcRegistrarLike {
  handle(channel: string, listener: IpcHandler): void
}

export interface IpcTable {
  /** 登记一个通道（重复登记后者覆盖前者，便于测试替换） */
  register(channel: string, handler: IpcHandler): void
  /** 把整张表挂到一个注册器上（通常是 `ctx.registerIpc`） */
  install(registrar: IpcRegistrarLike | ((channel: string, handler: IpcHandler) => void)): void
  /** 已登记的通道（测试与诊断用） */
  channels(): string[]
}

export function createIpcTable(): IpcTable {
  const handlers = new Map<string, IpcHandler>()

  return {
    register(channel, handler) {
      handlers.set(channel, handler)
    },
    install(registrar) {
      const handle = typeof registrar === 'function' ? registrar : registrar.handle.bind(registrar)
      for (const [channel, handler] of handlers) handle(channel, handler)
    },
    channels() {
      return [...handlers.keys()]
    },
  }
}
