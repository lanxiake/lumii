/**
 * 流水线 IPC 表（计划 Task 7）。五个 invoke + 两个 on。
 *
 * 服务是单例（`S.pipeline`）：`cancel(runId)` 要能命中同一个在飞的 run，
 * 就只能是同一份 running Map —— 所以这里不新建服务，只转发。
 *
 * `pipeline:list` 这类由插件注册，停用即摘（`ctx.registerIpc`）——**不经过命令总线**，
 * 因为流水线页要的是「插件在不在」决定表在不在，而不是一条永远存在但报错的命令。
 */
import type { PipelineService } from './service-api'
import type { IpcHandleRegistrar } from '../../../main/kernel/ipc-registry'

interface PipelineIpcDeps {
  /** 现取服务（插件 wire() 之后才有真实现；未就绪时返回 null，各 handler 给可读错误） */
  getService: () => PipelineService | null
  /** 打开 spec / run 所在目录（用系统文件管理器） */
  openPath: (p: string) => Promise<string>
  /** spec 或 run 目录的绝对路径 */
  resolvePath: (target: 'spec' | 'run', id: string) => string
}

export function registerPipelineIpcHandlers(
  deps: PipelineIpcDeps,
  registrar: IpcHandleRegistrar,
): void {
  const need = (): PipelineService => {
    const s = deps.getService()
    if (!s) throw new Error('流水线引擎尚未就绪（插件加载中或已停用）')
    return s
  }

  registrar.handle('pipeline:list', async () => need().list())

  registrar.handle('pipeline:detail', async (_e, id: string) => {
    if (typeof id !== 'string' || !id) return null
    return need().detail(id)
  })

  registrar.handle(
    'pipeline:run',
    async (_e, args: { id: string; mode: 'record' | 'rehearsal'; resumeRunId?: string }) => {
      if (!args || typeof args.id !== 'string' || !args.id) {
        return { ok: false, runId: '', journalPath: '', steps: [], error: '缺少 id' }
      }
      const mode = args.mode === 'record' ? 'record' : 'rehearsal'
      return need().run(args.id, { mode, resumeRunId: args.resumeRunId })
    },
  )

  // 取消不存在的 run 是常态（已经跑完 / 页面刷新过），返回 {ok:false} 而不是抛
  registrar.handle('pipeline:cancel', (_e, runId: string) => {
    if (typeof runId !== 'string' || !runId) return { ok: false }
    need().cancel(runId)
    return { ok: true }
  })

  registrar.handle('pipeline:openDir', async (_e, args: { target: 'spec' | 'run'; id: string }) => {
    if (!args || typeof args.id !== 'string' || !args.id) return { ok: false }
    const target = args.target === 'run' ? 'run' : 'spec'
    try {
      const err = await deps.openPath(deps.resolvePath(target, args.id))
      return err ? { ok: false, error: err } : { ok: true }
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) }
    }
  })
}
