#!/usr/bin/env node
/**
 * 隔离复现：sherpa VAD 加载 与 transformers E5 嵌入 能否共存于同一进程
 *
 * ## 背景
 *
 * 打开 `LUMII_PALACE_VECTOR=1` 后连续 **3 次**启动都在同一指纹处崩溃：
 * ```
 * [VadEngine] [initialize] 加载 Silero VAD 模型: ...\silero_vad.onnx
 * The given version [27] is not supported, only version 1 to 14 is supported in this build.
 * Exit status 4294930435
 * ```
 * 而关掉开关时同一条代码路径**成功**（VAD 初始化完成，应用存活）。
 *
 * 已排除：模块冲突（`@xenova/transformers@2.17.2` 锁 `onnxruntime-node@1.14.0`；
 * sherpa-onnx-node 是自带二进制的原生插件、package.json 无依赖）。
 *
 * ## 这个脚本做什么
 *
 * 按顺序做四件事，每步之间打印，**在哪一步崩就是哪一步的问题**：
 * 1. 只加载 sherpa VAD（基线——应当成功）
 * 2. 只加载 transformers E5 并跑一次嵌入（基线——应当成功）
 * 3. 两者**同时存活**时再跑一次 VAD 推理
 * 4. 反复交替，看是否时序相关
 *
 * 用法：node scripts/repro-vad-crash.mjs
 */
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const VAD_PATH = path.join(os.homedir(), '.lumii', 'models', 'voice', 'vad', 'silero_vad.onnx')
const CACHE = path.join(os.homedir(), '.lumii', 'models', 'wiki-embeddings', 'Xenova')

const step = (n, msg) => console.log(`\n[${n}] ${msg}`)

step(1, '只加载 sherpa VAD …')
const SherpaOnnx = require('sherpa-onnx-node')
const vad = new SherpaOnnx.Vad(
  {
    sileroVad: {
      model: VAD_PATH,
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: 0.5,
      windowSize: 512,
    },
    sampleRate: 16000,
    numThreads: 1,
    debug: 0,
  },
  60,
)
const buf = new SherpaOnnx.CircularBuffer(30 * 16000)
console.log('    ✅ VAD 加载成功')

step(2, '只加载 transformers E5 并嵌入一次 …')
const { pipeline, env } = require('@xenova/transformers')
env.allowLocalModels = true
env.cacheDir = CACHE
env.localModelPath = CACHE
env.allowRemoteModels = false
const ext = await pipeline('feature-extraction', 'multilingual-e5-small', {
  quantized: true,
  local_files_only: true,
})
const out = await ext('passage: 测试文本', { pooling: 'mean', normalize: true })
console.log(`    ✅ E5 嵌入成功 dims=${out.dims}`)

step(3, '两者共存时推音频帧进 VAD …')
const silence = new Float32Array(512)
for (let i = 0; i < 20; i++) {
  buf.push(silence)
  while (buf.size() > 512) {
    const frame = buf.get(buf.head(), 512, false)
    buf.pop(512)
    vad.acceptWaveform(frame)
    while (!vad.isEmpty()) {
      vad.front(false)
      vad.pop()
    }
  }
}
console.log('    ✅ VAD 推理成功')

step(4, '交替跑 30 轮（每轮：E5 嵌入 + VAD 帧）…')
for (let i = 0; i < 30; i++) {
  await ext('passage: 交替测试 ' + i, { pooling: 'mean', normalize: true })
  buf.push(silence)
  while (buf.size() > 512) {
    const frame = buf.get(buf.head(), 512, false)
    buf.pop(512)
    vad.acceptWaveform(frame)
    while (!vad.isEmpty()) {
      vad.front(false)
      vad.pop()
    }
  }
  if (i % 10 === 9) console.log(`    第 ${i + 1} 轮 OK`)
}
console.log('\n✅ 全部通过：两者可以共存于同一进程，未复现崩溃')
