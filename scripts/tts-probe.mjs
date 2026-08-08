/**
 * TTS 快速验证脚本（不改 app 代码）
 * 下载并试跑 Kokoro 多语双语 + Matcha 中文，测 RTF/耗时，输出 wav 供试听。
 *
 * 用法:
 *   node scripts/tts-probe.mjs kokoro     # 只验 Kokoro
 *   node scripts/tts-probe.mjs matcha     # 只验 Matcha
 *   node scripts/tts-probe.mjs            # 两个都验
 *
 * 依赖已装的 apps/windows/node_modules/sherpa-onnx-node，不新增依赖。
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import https from 'node:https'
import { execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const APP = path.join(ROOT, 'apps', 'windows')

// 从 app 的 node_modules 加载原生模块
const require = createRequire(path.join(APP, 'package.json'))
let SherpaOnnx
try {
  SherpaOnnx = require('sherpa-onnx-node')
} catch (e) {
  console.error('[FATAL] 无法加载 sherpa-onnx-node，请先在 apps/windows 下 pnpm install。', e.message)
  process.exit(1)
}

const WORK = path.join(ROOT, '.tts-probe')
fs.mkdirSync(WORK, { recursive: true })

// GitHub 下载镜像前缀（与 model-manager 同思路，国内直连易超时）
const MIRRORS = ['https://gh.ddlc.top/', 'https://gh-proxy.com/', 'https://ghfast.top/', '']

const log = (...a) => console.log('[probe]', ...a)

// ─── 下载（支持重定向 + 镜像回退），单文件整下 ──────────────────────────────
function downloadOnce(url, dest) {
  return new Promise((resolve, reject) => {
    const doReq = (u, redirects = 0) => {
      if (redirects > 6) return reject(new Error('重定向过多'))
      const req = https.get(u, { headers: { 'User-Agent': 'lumii-probe' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume()
          return doReq(new URL(res.headers.location, u).toString(), redirects + 1)
        }
        if (res.statusCode !== 200) {
          res.resume()
          return reject(new Error(`HTTP ${res.statusCode}`))
        }
        const total = parseInt(res.headers['content-length'] ?? '0', 10)
        let got = 0
        let lastPct = -1
        const out = fs.createWriteStream(dest)
        res.on('data', (c) => {
          got += c.length
          if (total > 0) {
            const pct = Math.floor((got / total) * 100)
            if (pct !== lastPct && pct % 5 === 0) {
              process.stdout.write(`\r  下载 ${path.basename(dest)}: ${pct}% (${(got / 1e6).toFixed(1)}MB)   `)
              lastPct = pct
            }
          }
        })
        res.pipe(out)
        out.on('finish', () => out.close(() => { process.stdout.write('\n'); resolve() }))
        out.on('error', reject)
        res.on('error', reject)
      })
      req.on('error', reject)
      req.setTimeout(60_000, () => { req.destroy(new Error('连接超时')) })
    }
    doReq(url)
  })
}

async function download(ghPath, dest) {
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    log(`已存在，跳过下载: ${path.basename(dest)}`)
    return
  }
  const errors = []
  for (const m of MIRRORS) {
    const url = m ? `${m}${ghPath}` : ghPath
    try {
      log(`尝试源: ${m || 'github.com'}`)
      await downloadOnce(url, dest)
      return
    } catch (e) {
      errors.push(`${m || 'github'}: ${e.message}`)
      try { if (fs.existsSync(dest)) fs.unlinkSync(dest) } catch { /* ignore */ }
    }
  }
  throw new Error(`全部源失败:\n${errors.join('\n')}`)
}

// ─── 解压 tar.bz2（用系统 tar） ─────────────────────────────────────────────
function extractTar(tarFile, outDir) {
  fs.mkdirSync(outDir, { recursive: true })
  const tarExe = process.platform === 'win32' ? 'C:\\Windows\\System32\\tar.exe' : 'tar'
  execFileSync(tarExe, ['-xf', tarFile, '-C', outDir], { stdio: 'inherit' })
}

// 找体积最大的 .onnx（规避 LFS 指针占位小文件）
function largestOnnx(root) {
  let best = null
  let bestSize = 0
  const stack = [root]
  while (stack.length) {
    const d = stack.pop()
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) stack.push(p)
      else if (ent.name.endsWith('.onnx')) {
        const sz = fs.statSync(p).size
        if (sz > bestSize) { bestSize = sz; best = p }
      }
    }
  }
  return best
}

// 递归找第一个匹配文件名/目录的绝对路径
function findPath(root, predicate, wantDir = false) {
  const stack = [root]
  while (stack.length) {
    const d = stack.pop()
    let entries
    try { entries = fs.readdirSync(d, { withFileTypes: true }) } catch { continue }
    for (const ent of entries) {
      const p = path.join(d, ent.name)
      if (ent.isDirectory()) {
        if (wantDir && predicate(ent.name)) return p
        stack.push(p)
      } else if (!wantDir && predicate(ent.name)) {
        return p
      }
    }
  }
  return null
}

// ─── 写 wav（float32 → 16bit PCM） ─────────────────────────────────────────
function writeWav(samples, sampleRate, dest) {
  const n = samples.length
  const buf = Buffer.alloc(44 + n * 2)
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + n * 2, 4); buf.write('WAVE', 8)
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22); buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34)
  buf.write('data', 36); buf.writeUInt32LE(n * 2, 40)
  for (let i = 0; i < n; i++) {
    let s = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE((s < 0 ? s * 0x8000 : s * 0x7fff) | 0, 44 + i * 2)
  }
  fs.writeFileSync(dest, buf)
}

// 测一次合成的耗时/RTF
function synth(tts, text, sid, speed, outWav) {
  const t0 = Date.now()
  const audio = tts.generate({ text, sid, speed })
  const genMs = Date.now() - t0
  const durSec = audio.samples.length / audio.sampleRate
  const rtf = (genMs / 1000) / durSec
  writeWav(audio.samples, audio.sampleRate, outWav)
  return { genMs, durSec, rtf, sampleRate: audio.sampleRate, out: outWav }
}

// 三句测试文本：纯中文 / 中英混读 / 纯英文
const TEXTS = {
  zh: '你好，我是灵栖，很高兴认识你。今天天气不错，适合出去走走。',
  mix: '你好，今天的 weather 很好，我们下午去 coffee shop 喝杯咖啡吧，大概三点半。',
  en: 'Hello, I am Lumii, your local AI companion running fully offline on Windows.',
}

// ─── Kokoro 多语（中英双语） ────────────────────────────────────────────────
async function probeKokoro() {
  console.log('\n========== Kokoro 多语（中英双语） ==========')
  const asset = 'kokoro-multi-lang-v1_1.tar.bz2'
  const gh = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${asset}`
  const tarFile = path.join(WORK, asset)
  const dir = path.join(WORK, 'kokoro-multi-lang-v1_1')
  if (!fs.existsSync(dir)) {
    await download(gh, tarFile)
    log('解压中…')
    extractTar(tarFile, WORK)
  }
  const model = findPath(dir, (n) => n === 'model.onnx')
  const voices = findPath(dir, (n) => n === 'voices.bin')
  const tokens = findPath(dir, (n) => n === 'tokens.txt')
  const espeak = findPath(dir, (n) => n === 'espeak-ng-data', true)
  const dict = findPath(dir, (n) => n === 'dict', true)
  const lexicons = fs.readdirSync(dir).filter((n) => /^lexicon.*\.txt$/.test(n))
    .map((n) => path.join(dir, n))
  log('识别文件:', { model, voices, tokens, espeak, dict, lexicons })
  if (!model || !voices || !tokens) throw new Error('Kokoro 关键文件缺失，检查解压结果')

  const cfg = {
    model: {
      kokoro: {
        model, voices, tokens,
        ...(lexicons.length ? { lexicon: lexicons.join(',') } : {}),
        ...(espeak ? { dataDir: espeak } : {}),
        ...(dict ? { dictDir: dict } : {}),
      },
      numThreads: 4, provider: 'cpu', debug: 0,
    },
    maxNumSentences: 1,
  }
  const t0 = Date.now()
  const tts = new SherpaOnnx.OfflineTts(cfg)
  log(`加载完成，耗时 ${Date.now() - t0}ms，说话人数=${tts.numSpeakers}，采样率=${tts.sampleRate}`)

  // 中文音色候选：多语版英文音色在前，中文 zf_/zm_ 在后。挑几个 sid 试听。
  const sids = [0, 45, 46, 50, 53].filter((s) => s < tts.numSpeakers)
  const results = []
  for (const sid of sids) {
    const r = synth(tts, TEXTS.mix, sid, 1.0, path.join(WORK, `kokoro_mix_sid${sid}.wav`))
    log(`[sid=${sid}] mix: gen=${r.genMs}ms 时长=${r.durSec.toFixed(2)}s RTF=${r.rtf.toFixed(3)} → ${path.basename(r.out)}`)
    results.push({ sid, ...r })
  }
  // 用 sid=0 补测纯中文/纯英文
  const zh = synth(tts, TEXTS.zh, sids[0], 1.0, path.join(WORK, 'kokoro_zh.wav'))
  const en = synth(tts, TEXTS.en, sids[0], 1.0, path.join(WORK, 'kokoro_en.wav'))
  log(`[sid=${sids[0]}] zh RTF=${zh.rtf.toFixed(3)}  en RTF=${en.rtf.toFixed(3)}`)
  return { engine: 'kokoro', numSpeakers: tts.numSpeakers, results, zh, en }
}

// ─── Matcha 中文（icefall-zh-baker + vocos vocoder） ────────────────────────
async function probeMatcha() {
  console.log('\n========== Matcha 中文（icefall-zh-baker） ==========')
  const asset = 'matcha-icefall-zh-baker.tar.bz2'
  const gh = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${asset}`
  const tarFile = path.join(WORK, asset)
  const dir = path.join(WORK, 'matcha-icefall-zh-baker')
  if (!fs.existsSync(dir)) {
    await download(gh, tarFile)
    log('解压中…')
    extractTar(tarFile, WORK)
  }
  // vocoder 单独下载（不在模型包内）
  const vocoderName = 'vocos-22khz-univ.onnx'
  const vocoder = path.join(WORK, vocoderName)
  await download(
    `https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models/${vocoderName}`,
    vocoder,
  )
  const acoustic = findPath(dir, (n) => /^model-steps-\d+\.onnx$/.test(n)) || findPath(dir, (n) => n.endsWith('.onnx'))
  const tokens = findPath(dir, (n) => n === 'tokens.txt')
  const lexicon = findPath(dir, (n) => n === 'lexicon.txt')
  const dict = findPath(dir, (n) => n === 'dict', true)
  log('识别文件:', { acoustic, vocoder, tokens, lexicon, dict })
  if (!acoustic || !tokens) throw new Error('Matcha 关键文件缺失，检查解压结果')

  const cfg = {
    model: {
      matcha: {
        acousticModel: acoustic, vocoder, tokens,
        ...(lexicon ? { lexicon } : {}),
        ...(dict ? { dictDir: dict } : {}),
      },
      numThreads: 4, provider: 'cpu', debug: 0,
    },
    maxNumSentences: 1,
  }
  const t0 = Date.now()
  const tts = new SherpaOnnx.OfflineTts(cfg)
  log(`加载完成，耗时 ${Date.now() - t0}ms，说话人数=${tts.numSpeakers}，采样率=${tts.sampleRate}`)

  const zh = synth(tts, TEXTS.zh, 0, 1.0, path.join(WORK, 'matcha_zh.wav'))
  const mix = synth(tts, TEXTS.mix, 0, 1.0, path.join(WORK, 'matcha_mix.wav'))
  log(`zh: gen=${zh.genMs}ms 时长=${zh.durSec.toFixed(2)}s RTF=${zh.rtf.toFixed(3)} → ${path.basename(zh.out)}`)
  log(`mix: gen=${mix.genMs}ms 时长=${mix.durSec.toFixed(2)}s RTF=${mix.rtf.toFixed(3)} → ${path.basename(mix.out)}`)
  return { engine: 'matcha', numSpeakers: tts.numSpeakers, zh, mix }
}

// ─── MeloTTS 中英双语（VITS，单音色原生混读） ──────────────────────────────
async function probeMelo() {
  console.log('\n========== MeloTTS 中英双语（vits-melo-tts-zh_en） ==========')
  const asset = 'vits-melo-tts-zh_en.tar.bz2'
  const gh = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${asset}`
  const tarFile = path.join(WORK, asset)
  const dir = path.join(WORK, 'vits-melo-tts-zh_en')
  if (!fs.existsSync(dir)) {
    await download(gh, tarFile)
    log('解压中…')
    extractTar(tarFile, WORK)
  }
  // 选最大的 .onnx，避开 133 字节的 LFS 指针占位文件（model.int8.onnx 是坏的）
  const model = largestOnnx(dir)
  const tokens = findPath(dir, (n) => n === 'tokens.txt')
  const lexicon = findPath(dir, (n) => n === 'lexicon.txt')
  const dict = findPath(dir, (n) => n === 'dict', true)
  const fsts = ['date.fst', 'number.fst', 'phone.fst']
    .map((f) => findPath(dir, (n) => n === f)).filter(Boolean)
  log('识别文件:', { model, tokens, lexicon, dict, fsts })
  if (!model || !tokens) throw new Error('MeloTTS 关键文件缺失')

  const cfg = {
    model: {
      vits: {
        model, tokens,
        ...(lexicon ? { lexicon } : {}),
        ...(dict ? { dictDir: dict } : {}),
      },
      numThreads: 4, provider: 'cpu', debug: 0,
    },
    maxNumSentences: 1,
    ...(fsts.length ? { ruleFsts: fsts.join(',') } : {}),
  }
  const t0 = Date.now()
  const tts = new SherpaOnnx.OfflineTts(cfg)
  log(`加载完成，耗时 ${Date.now() - t0}ms，说话人数=${tts.numSpeakers}，采样率=${tts.sampleRate}`)

  const zh = synth(tts, TEXTS.zh, 0, 1.0, path.join(WORK, 'melo_zh.wav'))
  const mix = synth(tts, TEXTS.mix, 0, 1.0, path.join(WORK, 'melo_mix.wav'))
  const en = synth(tts, TEXTS.en, 0, 1.0, path.join(WORK, 'melo_en.wav'))
  log(`zh RTF=${zh.rtf.toFixed(3)}  mix RTF=${mix.rtf.toFixed(3)}  en RTF=${en.rtf.toFixed(3)}`)
  return { engine: 'melo', numSpeakers: tts.numSpeakers, zh, mix, en }
}

// ─── 通用 VITS/BERT-VITS2 中文模型探测（传 sherpa 资产名，自动识别结构） ──────
async function probeVits(assetBase) {
  console.log(`\n========== VITS 中文（${assetBase}） ==========`)
  const asset = `${assetBase}.tar.bz2`
  const gh = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${asset}`
  const tarFile = path.join(WORK, asset)
  const dir = path.join(WORK, assetBase)
  if (!fs.existsSync(dir)) {
    await download(gh, tarFile)
    log('解压中…')
    extractTar(tarFile, WORK)
  }
  const model = largestOnnx(dir)
  const tokens = findPath(dir, (n) => n === 'tokens.txt')
  const lexicon = findPath(dir, (n) => n === 'lexicon.txt')
  const dict = findPath(dir, (n) => n === 'dict', true)
  const espeak = findPath(dir, (n) => n === 'espeak-ng-data', true)
  const fsts = ['date.fst', 'number.fst', 'phone.fst', 'rule.fst']
    .map((f) => findPath(dir, (n) => n === f)).filter(Boolean)
  log('识别文件:', { model, tokens, lexicon, dict, espeak, fsts })
  if (!model || !tokens) throw new Error(`${assetBase} 关键文件缺失`)

  const cfg = {
    model: {
      vits: {
        model, tokens,
        ...(lexicon ? { lexicon } : {}),
        ...(dict ? { dictDir: dict } : {}),
        ...(espeak ? { dataDir: espeak } : {}),
      },
      numThreads: 4, provider: 'cpu', debug: 0,
    },
    maxNumSentences: 1,
    ...(fsts.length ? { ruleFsts: fsts.join(',') } : {}),
  }
  const t0 = Date.now()
  const tts = new SherpaOnnx.OfflineTts(cfg)
  log(`加载完成，耗时 ${Date.now() - t0}ms，说话人数=${tts.numSpeakers}，采样率=${tts.sampleRate}`)

  const tag = assetBase.replace(/[^a-z0-9]+/gi, '_')
  // 多说话人：多挑几个 sid 试听；单说话人只用 0
  const sids = tts.numSpeakers > 1 ? [0, 10, 50, 100].filter((s) => s < tts.numSpeakers) : [0]
  const results = []
  for (const sid of sids) {
    const r = synth(tts, TEXTS.zh, sid, 1.0, path.join(WORK, `${tag}_zh_sid${sid}.wav`))
    log(`[sid=${sid}] zh: RTF=${r.rtf.toFixed(3)} 时长=${r.durSec.toFixed(2)}s → ${path.basename(r.out)}`)
    results.push({ sid, ...r })
  }
  const mix = synth(tts, TEXTS.mix, sids[0], 1.0, path.join(WORK, `${tag}_mix.wav`))
  log(`mix(sid=${sids[0]}): RTF=${mix.rtf.toFixed(3)} → ${path.basename(mix.out)}（注意听英文是否丢失）`)
  return { engine: assetBase, numSpeakers: tts.numSpeakers, results, mix }
}

// ─── main ───────────────────────────────────────────────────────────────────
async function main() {
  const which = process.argv[2]
  const summary = []
  try {
    if (!which || which === 'kokoro') summary.push(await probeKokoro())
  } catch (e) { console.error('[Kokoro 失败]', e.message) }
  try {
    if (which === 'melo') summary.push(await probeMelo())
  } catch (e) { console.error('[MeloTTS 失败]', e.message) }
  // 传任意 sherpa vits-zh 资产名直接测：node scripts/tts-probe.mjs vits vits-zh-hf-theresa
  try {
    if (which === 'vits' && process.argv[3]) summary.push(await probeVits(process.argv[3]))
  } catch (e) { console.error('[VITS 失败]', e.message) }
  try {
    if (!which || which === 'matcha') summary.push(await probeMatcha())
  } catch (e) { console.error('[Matcha 失败]', e.message) }

  console.log('\n========== 汇总 ==========')
  console.log(`输出目录: ${WORK}`)
  for (const s of summary) {
    if (s.engine === 'kokoro') {
      console.log(`Kokoro: 说话人=${s.numSpeakers}  中英混读 RTF≈${(s.results[0]?.rtf ?? 0).toFixed(3)}  纯中文 RTF≈${s.zh.rtf.toFixed(3)}`)
    } else if (s.engine === 'melo') {
      console.log(`MeloTTS: 纯中文 RTF≈${s.zh.rtf.toFixed(3)}  中英混读 RTF≈${s.mix.rtf.toFixed(3)}  纯英文 RTF≈${s.en.rtf.toFixed(3)}`)
    } else if (s.mix && s.results) {
      console.log(`${s.engine}: 说话人=${s.numSpeakers}  纯中文 RTF≈${(s.results[0]?.rtf ?? 0).toFixed(3)}  混读 RTF≈${s.mix.rtf.toFixed(3)}`)
    } else {
      console.log(`Matcha: 纯中文 RTF≈${s.zh.rtf.toFixed(3)}  中英混读 RTF≈${s.mix.rtf.toFixed(3)}`)
    }
  }
  console.log('\n请用播放器逐个试听 .wav，重点听：中英切换是否自然、中文韵律、有无杂音。')
  console.log('RTF<1 即快于实时；越小越快。')
}

main()
