/**
 * 桌面轨与麦克风轨混音（AudioContext）
 * MVP 已知限制：两路混轨可能有 <500ms 偏移（设计 §6），不做 delay 补偿。
 * 二期：可同时混系统声（desktop audio tracks）与麦克风。
 */

/**
 * 将麦克风音轨接到 destination；无麦时返回 null（仅视频轨录制）。
 * @returns MediaStreamAudioDestinationNode 的 stream，或 null
 */
export function mixMicIntoDestination(
  audioCtx: AudioContext,
  micStream: MediaStream,
): MediaStream {
  const micSrc = audioCtx.createMediaStreamSource(micStream)
  const dest = audioCtx.createMediaStreamDestination()
  micSrc.connect(dest)
  return dest.stream
}

/**
 * 混入桌面系统声与可选麦克风，输出单一音频 MediaStream。
 * 两路皆无时返回 null。
 */
export function mixDesktopAndMic(
  audioCtx: AudioContext,
  desktopStream: MediaStream | null,
  micStream: MediaStream | null,
): MediaStream | null {
  const dest = audioCtx.createMediaStreamDestination()
  let connected = false
  if (desktopStream && desktopStream.getAudioTracks().length > 0) {
    audioCtx.createMediaStreamSource(desktopStream).connect(dest)
    connected = true
  }
  if (micStream && micStream.getAudioTracks().length > 0) {
    audioCtx.createMediaStreamSource(micStream).connect(dest)
    connected = true
  }
  return connected ? dest.stream : null
}

/**
 * 从候选 MIME 列表中选出 MediaRecorder 支持的类型。
 */
export function pickSupportedMime(candidates: string[]): string | null {
  if (typeof MediaRecorder === 'undefined') return candidates[0] ?? null
  for (const mime of candidates) {
    if (MediaRecorder.isTypeSupported(mime)) return mime
  }
  return null
}

/**
 * 将 Blob 拆成不超过 maxBytes 的 ArrayBuffer 片段（IPC 防阻塞）。
 */
export async function splitBlobToChunks(
  blob: Blob,
  maxBytes: number,
): Promise<ArrayBuffer[]> {
  if (blob.size <= maxBytes) {
    return [await blob.arrayBuffer()]
  }
  const buf = await blob.arrayBuffer()
  const out: ArrayBuffer[] = []
  for (let offset = 0; offset < buf.byteLength; offset += maxBytes) {
    out.push(buf.slice(offset, Math.min(offset + maxBytes, buf.byteLength)))
  }
  return out
}

/**
 * ArrayBuffer → base64（浏览器环境）。
 */
export function arrayBufferToBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf)
  let binary = ''
  const chunk = 0x8000
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
