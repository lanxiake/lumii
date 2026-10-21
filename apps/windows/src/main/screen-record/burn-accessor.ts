/**
 * BurnSubtitlesService 单例访问。
 *
 * 同样挂 `globalThis`：录屏官方外部扩展与主进程各有一份模块拷贝。
 */
import type { BurnSubtitlesService } from './burn-subtitles-service'

const KEY = Symbol.for('lumii.screen-record.burn-accessor')
const shared = ((globalThis as Record<symbol, unknown>)[KEY] ??= {
  service: null,
}) as { service: BurnSubtitlesService | null }

/** 挂接烧录服务实例 */
export function setBurnSubtitlesService(svc: BurnSubtitlesService | null): void {
  shared.service = svc
}

/** 获取烧录服务（未初始化返回 null） */
export function getBurnSubtitlesService(): BurnSubtitlesService | null {
  return shared.service
}
