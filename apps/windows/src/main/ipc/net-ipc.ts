/**
 * 网络延迟 IPC
 *
 * 只此一条：`net:ping` —— 底部状态条低频轮询用，返回国内/国外两组与自适应 best。
 * （下载/上传测速已按需求移除。）
 */

import { ipcMain } from 'electron'
import { probeLatency } from '../net/net-latency'

export function registerNetIpcHandlers(): void {
  ipcMain.handle('net:ping', () => probeLatency())
}
