/**
 * 通过 Blob URL 加载 AudioWorklet 模块
 *
 * Electron 生产环境使用 file:// 加载页面时，Vite 会将 worklet 内联为 data: URL，
 * Chromium 的 AudioWorklet 无法加载该格式（报 "Unable to load a worklet's module"）。
 * 使用 Blob URL 可在 dev / preview / 打包环境下统一工作。
 */
export async function loadAudioWorkletModule(
  audioCtx: AudioContext,
  source: string,
): Promise<void> {
  const blob = new Blob([source], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    await audioCtx.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}
