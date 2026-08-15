/**
 * NarrateService 单例访问（与 ScreenRecordService accessor 同模式）
 */
import type { NarrateService } from './narrate-service'

let _service: NarrateService | null = null

/** 挂接旁白服务实例 */
export function setNarrateService(svc: NarrateService | null): void {
  _service = svc
}

/** 获取旁白服务（未初始化返回 null） */
export function getNarrateService(): NarrateService | null {
  return _service
}
