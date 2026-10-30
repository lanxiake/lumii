/**
 * 确定性流水线 preload 桥（计划 Task 7）。
 *
 * 五个 invoke + 两个 on。**不经过命令总线**：流水线页要的是「插件在不在」决定表在不在，
 * 而不是一条永远存在但报错的命令（与 selection 同取舍）。
 */
import { ipcRenderer } from 'electron'

export const pipelineApi = {
  list: (): Promise<unknown[]> => ipcRenderer.invoke('pipeline:list'),
  detail: (id: string): Promise<unknown | null> => ipcRenderer.invoke('pipeline:detail', id),
  run: (args: {
    id: string
    mode: 'record' | 'rehearsal'
    resumeRunId?: string
  }): Promise<unknown> => ipcRenderer.invoke('pipeline:run', args),
  cancel: (runId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke('pipeline:cancel', runId),
  openDir: (args: {
    target: 'spec' | 'run'
    id: string
  }): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('pipeline:openDir', args),

  /** 每步进度；返回取消订阅函数（挂载/卸载成对调用，别漏） */
  onProgress: (cb: (e: unknown) => void): (() => void) => {
    const listener = (_e: unknown, data: unknown) => cb(data)
    ipcRenderer.on('pipeline:progress', listener)
    return () => ipcRenderer.removeListener('pipeline:progress', listener)
  },
  onFinished: (cb: (e: unknown) => void): (() => void) => {
    const listener = (_e: unknown, data: unknown) => cb(data)
    ipcRenderer.on('pipeline:finished', listener)
    return () => ipcRenderer.removeListener('pipeline:finished', listener)
  },
}
