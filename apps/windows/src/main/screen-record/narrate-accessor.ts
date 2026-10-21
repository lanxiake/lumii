/**
 * NarrateService 单例访问（与 ScreenRecordService accessor 同模式）。
 *
 * 同样挂 `globalThis`：录屏官方外部扩展与主进程各有一份模块拷贝。
 */
import type { NarrateService } from './narrate-service'

const KEY = Symbol.for('lumii.screen-record.narrate-accessor')
const shared = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  service: null,
}) as { service: NarrateService | null }

/** 挂接旁白服务实例 */
export function setNarrateService(svc: NarrateService | null): void {
  shared.service = svc
}

/** 获取旁白服务（未初始化返回 null） */
export function getNarrateService(): NarrateService | null {
  return shared.service
}
