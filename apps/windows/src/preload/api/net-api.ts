/**
 * 网络延迟探测 API
 */
import { ipcRenderer } from 'electron'
import type { PingReport } from '../../shared/net-latency-types'

export const netApi = {
  /** 低频延迟探测；返回国内/国外两组与自适应 best */
  ping: (): Promise<PingReport> => ipcRenderer.invoke('net:ping'),
}
