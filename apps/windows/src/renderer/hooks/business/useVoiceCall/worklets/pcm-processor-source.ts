/**
 * PCM AudioWorklet 源码字符串（避免 ?raw 在 tsc 下无类型）
 * 内容需与 pcm-processor.js 保持同步
 */
export const pcmProcessorSource = `
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._targetSampleRate = 16000
    this._inputSampleRate = sampleRate
    this._ratio = this._inputSampleRate / this._targetSampleRate
    this._buffer = []
    this._chunkSize = 480
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0] || input[0].length === 0) return true

    const inputData = input[0]
    const outputLength = Math.floor(inputData.length / this._ratio)
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = Math.min(Math.floor(i * this._ratio), inputData.length - 1)
      this._buffer.push(inputData[srcIndex])
    }

    while (this._buffer.length >= this._chunkSize) {
      const chunk = new Float32Array(this._buffer.splice(0, this._chunkSize))
      this.port.postMessage(chunk, [chunk.buffer])
    }

    return true
  }
}

registerProcessor('pcm-processor', PcmProcessor)
`
