#!/usr/bin/env node
/**
 * 隔离复现 v2：**并发**触发 E5 嵌入 与 sherpa VAD 加载
 *
 * v1 结论：顺序 + 交替（30 轮）在 Node 下**不崩**——两者可以共存。
 * 但生产的形状不是顺序，是**并发**：
 *   t=+1s  后台补齐开始，连续调 embedder.embed()
 *   t=+5s  VAD 预热开始（index.ts:925 的固定 5s 定时器）
 * 三次崩溃都落在这个重叠窗口里。
 *
 * 所以这个脚本让两者**同时**开跑，看 VAD 加载会不会失败。
 *
 * 用法：node scripts/repro-vad-concurrent.mjs
 */
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const VAD_PATH = path.join(os.homedir(), '.lumii', 'models', 'voice', 'vad', 'silero_vad.onnx')
const CACHE = path.join(os.homedir(), '.lumii', 'models', 'wiki-embeddings', 'Xenova')

const { pipeline, env } = require('@xenova/transformers')
env.allowLocalModels = true
env.cacheDir = CACHE
env.localModelPath = CACHE
env.allowRemoteModels = false
const ext = await pipeline('feature-extraction', 'multilingual-e5-small', {
  quantized: true,
  local_files_only: true,
})
console.log('[准备] E5 就绪')

// 造一批 300 字的语料，模拟宫殿补齐的真实负载
const corpus = Array.from({ length: 60 }, (_, i) =>
  `passage: 第 ${i} 条归档内容。用户报告了一个生产环境的故障，要求排查根因并给出结论。` +
  '以下是排查过程与最终结论，包含命令输出、日志片段与验证步骤。'.repeat(3),
)

let embedding = 0
let stop = false
async function embedLoop() {
  while (!stop) {
    await ext(corpus[embedding % corpus.length], { pooling: 'mean', normalize: true })
    embedding++
  }
}

console.log('[开始] 嵌入循环 + VAD 加载 并发…')
const embedTask = embedLoop()

// 让嵌入先跑起来（生产里补齐比 VAD 早约 4 秒）
await new Promise((r) => setTimeout(r, 1500))
console.log(`[进度] 已嵌入 ${embedding} 条，现在加载 VAD`)

let vad
try {
  const SherpaOnnx = require('sherpa-onnx-node')
  vad = new SherpaOnnx.Vad(
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
  console.log('✅ VAD 加载成功（并发下也成功）')
} catch (e) {
  console.error('❌ VAD 加载抛错:', e?.message ?? e)
}

stop = true
await embedTask
console.log(`[结束] 共嵌入 ${embedding} 条，VAD=${vad ? 'ok' : 'fail'}`)
