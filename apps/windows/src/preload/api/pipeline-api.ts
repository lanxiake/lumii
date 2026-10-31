/**
 * 确定性流水线 preload 桥（计划 Task 7）。
 *
 * 五个 invoke + 两个 on。**不经过命令总线**：流水线页要的是「插件在不在」决定表在不在，
 * 而不是一条永远存在但报错的命令（与 selection 同取舍）。
 *
 * **进度/结束事件走 `agent-runtime:event` 复用通道**：主进程的 `forwardIpcEvent` 只往这一个
 * 通道发（`bridge-renderer-ipc.ts:80`），按 `type` 区分。所以这里不能自己
 * `ipcRenderer.on('pipeline:progress')`——那条通道没人发，会静默订阅到空气。
 */
import { ipcRenderer } from 'electron'

/** 复用通道上的订阅（与 agent-runtime-api 的 onEventType 同形） */
function onRuntimeEvent(type: string, cb: (e: unknown) => void): () => void {
  const listener = (_ipcEvt: Electron.IpcRendererEvent, evt: unknown) => {
    if (evt && typeof evt === 'object' && (evt as { type?: string }).type === type) cb(evt)
  }
  ipcRenderer.on('agent-runtime:event', listener)
  return () => ipcRenderer.removeListener('agent-runtime:event', listener)
}

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
  onProgress: (cb: (e: unknown) => void): (() => void) => onRuntimeEvent('pipeline:progress', cb),
  onFinished: (cb: (e: unknown) => void): (() => void) => onRuntimeEvent('pipeline:finished', cb),
}
