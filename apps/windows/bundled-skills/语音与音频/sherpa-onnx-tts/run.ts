/**
 * sherpa-onnx-tts 入口脚本（Windows）
 *
 * 通过 sherpa-onnx-offline-tts.exe 将文本转为 WAV 语音文件。
 *
 * 参数（SKILL_PARAMS JSON）：
 *   text: string          必填，要合成的文本
 *   outputFile?: string   输出 WAV 路径（默认 %TEMP%/tts-TIMESTAMP.wav）
 *   runtimeDir?: string   覆盖 SHERPA_ONNX_RUNTIME_DIR 环境变量
 *   modelDir?: string     覆盖 SHERPA_ONNX_MODEL_DIR 环境变量
 *   speakerId?: number    说话人 ID（默认 0）
 *   speed?: number        语速（默认 1.0）
 *
 * 路径解析优先级：SKILL_PARAMS > 环境变量 > ~/.mtbot/tools/sherpa-onnx-tts/ 默认位置
 *
 * 输出（stdout）：
 *   __SKILL_RESULT__:{"success":true,"outputFile":"...","durationMs":...,"text":"..."}
 */

import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const RESULT_PREFIX = '__SKILL_RESULT__:'

function output(data: unknown): void {
  process.stdout.write(RESULT_PREFIX + JSON.stringify(data) + '\n')
}

function fail(message: string): never {
  output({ success: false, error: message })
  process.exit(1)
}

function expandTilde(p: string): string {
  return p.startsWith('~') ? p.replace(/^~/, os.homedir()) : p
}

// ── 解析参数 ──────────────────────────────────────────────────────────────────
let params: Record<string, unknown> = {}
try {
  const raw = process.env.SKILL_PARAMS
  if (raw) params = JSON.parse(raw)
} catch {
  fail('SKILL_PARAMS 解析失败，请确保传入有效的 JSON')
}

const text = (params.text as string | undefined)?.trim()
if (!text) fail('缺少必填参数 text（要合成的文本）')

// ── 路径解析 ──────────────────────────────────────────────────────────────────
const defaultBase = path.join(os.homedir(), '.mtbot', 'tools', 'sherpa-onnx-tts')

const runtimeDir = path.resolve(expandTilde(
  (params.runtimeDir as string | undefined)
  ?? process.env.SHERPA_ONNX_RUNTIME_DIR
  ?? path.join(defaultBase, 'runtime')
))

const modelDir = path.resolve(expandTilde(
  (params.modelDir as string | undefined)
  ?? process.env.SHERPA_ONNX_MODEL_DIR
  ?? path.join(defaultBase, 'models')
))

// ── 检查运行时目录 ─────────────────────────────────────────────────────────────
if (!fs.existsSync(runtimeDir)) {
  fail(
    `sherpa-onnx 运行时目录不存在: ${runtimeDir}\n` +
    `请先通过 mtbot UI 安装 sherpa-onnx-tts 技能，或设置 SHERPA_ONNX_RUNTIME_DIR 环境变量。`
  )
}

// ── 查找可执行文件 ─────────────────────────────────────────────────────────────
const exeName = 'sherpa-onnx-offline-tts.exe'
const exeInBin = path.join(runtimeDir, 'bin', exeName)
const exeInRoot = path.join(runtimeDir, exeName)
const exePath = fs.existsSync(exeInBin) ? exeInBin : fs.existsSync(exeInRoot) ? exeInRoot : null

if (!exePath) {
  fail(
    `未找到可执行文件 ${exeName}，已查找位置：\n  ${exeInBin}\n  ${exeInRoot}`
  )
}

// ── 检查模型目录 ───────────────────────────────────────────────────────────────
if (!fs.existsSync(modelDir)) {
  fail(
    `模型目录不存在: ${modelDir}\n` +
    `请先通过 mtbot UI 下载语音模型，或设置 SHERPA_ONNX_MODEL_DIR 环境变量。`
  )
}

// 查找 .onnx 模型文件（优先 int8 量化版本）
const onnxFiles = fs.readdirSync(modelDir).filter(f => f.endsWith('.onnx'))
if (onnxFiles.length === 0) {
  fail(`模型目录中未找到 .onnx 文件: ${modelDir}`)
}
const preferInt8 = onnxFiles.find(f => f.includes('int8')) ?? onnxFiles[0]
const modelFile = path.join(modelDir, process.env.SHERPA_ONNX_MODEL_FILE ?? preferInt8)

// ── 查找 tokens.txt ────────────────────────────────────────────────────────────
const tokensFile = path.join(modelDir, 'tokens.txt')
if (!fs.existsSync(tokensFile)) {
  fail(`未找到 tokens.txt: ${tokensFile}`)
}

// ── 确定输出文件路径 ──────────────────────────────────────────────────────────
const defaultOutput = path.join(
  process.env.TEMP ?? os.tmpdir(),
  `tts-${Date.now()}.wav`
)
const outputFile = path.resolve(expandTilde(
  (params.outputFile as string | undefined) ?? defaultOutput
))
fs.mkdirSync(path.dirname(outputFile), { recursive: true })

// ── 构建命令参数 ───────────────────────────────────────────────────────────────
const speakerId = (params.speakerId as number | undefined) ?? 0
const speed = (params.speed as number | undefined) ?? 1.0

const args: string[] = [
  `--vits-model=${modelFile}`,
  `--vits-tokens=${tokensFile}`,
  `--sid=${speakerId}`,
  `--vits-length-scale=${speed}`,  // --speed 不存在，正确参数名为 --vits-length-scale
  `--output-filename=${outputFile}`,
]

// 可选参数：lexicon（部分模型需要）
const lexiconFile = path.join(modelDir, 'lexicon.txt')
if (fs.existsSync(lexiconFile)) {
  args.push(`--vits-lexicon=${lexiconFile}`)
}

// 注：--vits-dict-dir 在新版 sherpa-onnx 中已废弃（"Not used"），不再传递

// 可选参数：rule fsts（数字/日期/电话读音规则）
const fstCandidates = ['number.fst', 'phone.fst', 'date.fst', 'new_heteronym.fst']
const existingFsts = fstCandidates
  .map(f => path.join(modelDir, f))
  .filter(f => fs.existsSync(f))
if (existingFsts.length > 0) {
  args.push(`--tts-rule-fsts=${existingFsts.join(',')}`)
}

args.push(text!)

// ── 注入 DLL 路径到子进程 PATH ────────────────────────────────────────────────
// sherpa-onnx 可执行文件依赖同目录或 bin/ 目录下的 onnxruntime.dll 等
const binDir = path.join(runtimeDir, 'bin')
const dllSearchDirs = [binDir, runtimeDir]
  .filter(d => fs.existsSync(d))
  .join(path.delimiter)

const childEnv = {
  ...process.env,
  PATH: [dllSearchDirs, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
}

// ── 执行 ──────────────────────────────────────────────────────────────────────
const startTime = Date.now()
const result = spawnSync(exePath!, args, {
  env: childEnv,
  encoding: 'utf-8',
  timeout: 60000,
  windowsHide: true,
})

if (result.error) {
  fail(`执行失败: ${result.error.message}`)
}

if (result.status !== 0) {
  const errMsg = (result.stderr as string)?.trim() || `进程退出码: ${result.status}`
  fail(`sherpa-onnx-offline-tts 执行失败:\n${errMsg}`)
}

const durationMs = Date.now() - startTime

output({
  success: true,
  outputFile,
  durationMs,
  text,
  runtimeDir,
  modelDir,
})
