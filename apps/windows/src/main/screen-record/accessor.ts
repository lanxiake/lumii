/**
 * 录屏服务访问器（避免 main/index ↔ bridge 循环依赖）。
 *
 * 状态挂在 `globalThis`：录屏是官方外部扩展，bundle 里有本模块的第二份拷贝；
 * 模块级变量会让工具层 `getScreenRecordService()` 永远拿到 null（静默失能）。
 */
import type { ScreenRecordService } from './screen-record-service'

const KEY = Symbol.for('lumii.screen-record.accessor')
const shared = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  service: null,
}) as { service: ScreenRecordService | null }

/** 设置全局录屏服务单例（main 初始化时调用） */
export function setScreenRecordService(svc: ScreenRecordService | null): void {
  shared.service = svc
}

/** 读取全局录屏服务单例 */
export function getScreenRecordService(): ScreenRecordService | null {
  return shared.service
}
