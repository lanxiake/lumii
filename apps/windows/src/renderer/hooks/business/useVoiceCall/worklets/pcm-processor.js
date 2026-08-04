/**
 * AudioWorklet PCM 处理器
 * 运行在音频工作线程中，将麦克风音频降采样至 16kHz 并分帧发送
 *
 * 注意：AudioWorklet 上下文中不能使用 ES import，必须用全局 sampleRate 和 AudioWorkletProcessor
 */

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._targetSampleRate = 16000
    this._inputSampleRate = sampleRate // AudioWorklet 全局变量
    this._ratio = this._inputSampleRate / this._targetSampleRate
    this._buffer = []
    this._chunkSize = 480 // 30ms @ 16kHz
  }

  process(inputs) {
    const input = inputs[0]
    if (!input || !input[0] || input[0].length === 0) return true

    const inputData = input[0] // Float32Array, 通常 128 samples

    // 线性插值降采样
    const outputLength = Math.floor(inputData.length / this._ratio)
    for (let i = 0; i < outputLength; i++) {
      const srcIndex = Math.min(Math.floor(i * this._ratio), inputData.length - 1)
      this._buffer.push(inputData[srcIndex])
    }

    // 每积累 chunkSize 个样本发送一次
    while (this._buffer.length >= this._chunkSize) {
      const chunk = new Float32Array(this._buffer.splice(0, this._chunkSize))
      // 使用 transferable 避免数据拷贝
      this.port.postMessage(chunk, [chunk.buffer])
    }

    return true
  }
}

registerProcessor('pcm-processor', PcmProcessor)
