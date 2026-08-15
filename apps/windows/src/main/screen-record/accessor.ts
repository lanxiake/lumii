/**
 * 录屏服务访问器（避免 main/index ↔ bridge 循环依赖）
 */
import type { ScreenRecordService } from './screen-record-service'

let _service: ScreenRecordService | null = null

/** 设置全局录屏服务单例（main 初始化时调用） */
export function setScreenRecordService(svc: ScreenRecordService | null): void {
  _service = svc
}

/** 读取全局录屏服务单例 */
export function getScreenRecordService(): ScreenRecordService | null {
  return _service
}
