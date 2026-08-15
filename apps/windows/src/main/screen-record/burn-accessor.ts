/**
 * BurnSubtitlesService 单例访问
 */
import type { BurnSubtitlesService } from './burn-subtitles-service'

let _service: BurnSubtitlesService | null = null

/** 挂接烧录服务实例 */
export function setBurnSubtitlesService(svc: BurnSubtitlesService | null): void {
  _service = svc
}

/** 获取烧录服务（未初始化返回 null） */
export function getBurnSubtitlesService(): BurnSubtitlesService | null {
  return _service
}
