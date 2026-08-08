/**
 * 将 Float32 PCM 编码为 16-bit mono WAV（ArrayBuffer）
 */

/**
 * 把 -1~1 的 Float32 样本钳制并转为 Int16
 */
function floatToInt16(sample: number): number {
  const s = Math.max(-1, Math.min(1, sample))
  return s < 0 ? Math.round(s * 0x8000) : Math.round(s * 0x7fff)
}

/**
 * 编码标准 PCM WAV（44 字节头 + 交错 Int16 数据）
 */
export function encodePcmToWav(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numChannels = 1
  const bitsPerSample = 16
  const blockAlign = (numChannels * bitsPerSample) / 8
  const byteRate = sampleRate * blockAlign
  const dataSize = samples.length * blockAlign
  const buffer = new ArrayBuffer(44 + dataSize)
  const view = new DataView(buffer)

  /**
   * 写入 ASCII 四字符标识
   */
  const writeFourCC = (offset: number, text: string) => {
    for (let i = 0; i < 4; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }

  writeFourCC(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  writeFourCC(8, 'WAVE')
  writeFourCC(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM fmt chunk size
  view.setUint16(20, 1, true) // PCM format
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, byteRate, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitsPerSample, true)
  writeFourCC(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < samples.length; i++) {
    view.setInt16(offset, floatToInt16(samples[i]!), true)
    offset += 2
  }

  return buffer
}

/**
 * ArrayBuffer 转 base64（供 IPC 传主进程）
 */
export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const chunk = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
  }
  return btoa(binary)
}
