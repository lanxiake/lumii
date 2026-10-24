/**
 * 远端媒体代理地址构造（**纯函数，不依赖 electron**）。
 *
 * 单独成模块是因为它被两处 import：
 *   - 主进程协议处理器（remote-media-protocol.ts）
 *   - 任务产出解析（comfyui-job-follower.ts，跑在单测里，不能碰 electron）
 */

export const REMOTE_MEDIA_SCHEME = 'lumii-remote'

/** 构造渲染层可直接加载的代理地址 */
export function buildRemoteMediaUrl(remoteUrl: string): string {
  return `${REMOTE_MEDIA_SCHEME}://media/?src=${encodeURIComponent(remoteUrl)}`
}
