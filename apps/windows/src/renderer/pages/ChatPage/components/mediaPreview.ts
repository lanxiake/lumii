/**
 * 聊天媒体预览共用能力。
 *
 * 工具卡结果图、Markdown 内联图、后台任务缩略图统一走 ImageLightbox；
 * 本地 workspace 路径经 IPC 读成 data URL，避免两套点击交互。
 */

/** 经 IPC 把本地/相对路径读成可给 ImageLightbox 用的 data URL */
export async function loadLocalImageDataUrl(filePath: string): Promise<string | null> {
  const api = window.electronAPI?.agentRuntime
  if (!api?.sendCommand || !filePath.trim()) return null
  try {
    const res = await api.sendCommand({
      type: 'files:read-preview-by-path',
      filePath,
      userId: 'local-user',
    } as Parameters<typeof api.sendCommand>[0])
    const payload = res as { content?: string; mimeType?: string; encoding?: string } | null
    if (payload?.content && payload.encoding === 'base64') {
      return `data:${payload.mimeType ?? 'image/png'};base64,${payload.content}`
    }
  } catch {
    return null
  }
  return null
}

/** http(s)/data 视为外部图，可直接塞进 ImageLightbox */
export function isExternalImageSrc(src: string): boolean {
  return /^(https?:)?\/\//i.test(src) || src.startsWith('data:')
}
