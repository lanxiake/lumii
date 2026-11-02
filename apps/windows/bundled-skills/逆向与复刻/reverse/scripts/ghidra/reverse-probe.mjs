#!/usr/bin/env node
/**
 * `reverse` 技能的 Ghidra 探针驱动器。
 *
 * 把「找 Ghidra → 建项目 → 跑 ReverseProbe.java → 整理输出」封成一条命令，
 * 让技能不必每次都手写一长串 analyzeHeadless 参数（写错的失败模式很难看：
 * script 名拼错就 abort，且提示在几十行 classpath 之后）。
 *
 * 用法：
 *   node scripts/ghidra/reverse-probe.mjs <target> [--decompile N] [--out FILE]
 *                                            [--ghidra DIR] [--project DIR]
 *
 * 退出码：0 = 产出成功；2 = 参数错；3 = 找不到 Ghidra；4 = analyzeHeadless 失败。
 *
 * **不做工具自动安装**（设计 §8.4）。找不到就给出一条能照做的提示，然后退出。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT_NAME = 'ReverseProbe.java'

function fail(code, message) {
  console.error(message)
  process.exit(code)
}

function parseArgs(argv) {
  const opts = { decompile: 0, out: null, ghidra: null, project: null, target: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--decompile') opts.decompile = Number(argv[++i] ?? 0) || 0
    else if (a === '--out') opts.out = argv[++i]
    else if (a === '--ghidra') opts.ghidra = argv[++i]
    else if (a === '--project') opts.project = argv[++i]
    else if (a.startsWith('--')) fail(2, `未知参数：${a}`)
    else opts.target = a
  }
  if (!opts.target) fail(2, '用法：reverse-probe.mjs <target> [--decompile N] [--out FILE] [--ghidra DIR]')
  return opts
}

/**
 * 找 Ghidra 安装目录。顺序：显式参数 → 环境变量 → 常见安装位置。
 * 都没有就返回 null，由调用方给出「装在哪、或设哪个环境变量」的提示。
 */
function resolveGhidraDir(explicit) {
  if (explicit) return fs.existsSync(explicit) ? explicit : null
  const env = process.env.LUMII_GHIDRA_DIR?.trim()
  if (env) return fs.existsSync(env) ? env : null
  const candidates = [
    'C:/myself/tools', // 本机惯例（见 AGENTS 里的工具目录）
    path.join(os.homedir(), 'tools'),
    'C:/ghidra',
    '/opt/ghidra',
    '/usr/share/ghidra',
    '/usr/local/ghidra',
  ]
  for (const base of candidates) {
    let entries = []
    try {
      entries = fs.readdirSync(base, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory() || !e.name.toLowerCase().startsWith('ghidra')) continue
      const dir = path.join(base, e.name)
      if (fs.existsSync(path.join(dir, 'support', 'analyzeHeadless.bat')) ||
          fs.existsSync(path.join(dir, 'support', 'analyzeHeadless'))) {
        return dir
      }
    }
  }
  return null
}

/** Windows 用 .bat，其它平台用无扩展名的 shell 版 */
function launcherFor(ghidraDir) {
  const bat = path.join(ghidraDir, 'support', 'analyzeHeadless.bat')
  const sh = path.join(ghidraDir, 'support', 'analyzeHeadless')
  if (process.platform === 'win32') return fs.existsSync(bat) ? bat : sh
  return fs.existsSync(sh) ? sh : bat
}

const opts = parseArgs(process.argv.slice(2))
const target = path.resolve(opts.target)
if (!fs.existsSync(target)) fail(2, `目标不存在：${target}`)

const ghidraDir = resolveGhidraDir(opts.ghidra)
if (!ghidraDir) {
  fail(
    3,
    [
      '找不到 Ghidra。这个技能**不会自动安装**，请手动处理其中一种：',
      '  1. 把 Ghidra 解压到 ~/tools/ 或 C:/myself/tools/（目录名以 ghidra 开头）',
      '  2. 设环境变量 LUMII_GHIDRA_DIR=<Ghidra 根目录>（含 support/analyzeHeadless）',
      '  3. 每次调用加 --ghidra <目录>',
      '',
      '没有 Ghidra 也可以继续：binary.md / desktop.md 的 Triage 与字符串段不依赖它。',
    ].join('\n'),
  )
}

// 项目目录每次单独建：同一 project 里重名导入会报「conflicting program file」，
// 而那是**报错但不失败**的形态（用户很容易当成「跑完了」）。独立目录最省事。
const projectDir = path.resolve(
  opts.project ?? path.join(os.tmpdir(), `lumii-ghidra-${process.pid}-${Date.now()}`),
)
const projectName = 'proj'
fs.mkdirSync(projectDir, { recursive: true })

const hasDecompile = opts.decompile > 0
// 耗时：完整分析 notepad(534KB) ≈3min、certutil(1.9MB) ≈4min。**先告诉调用方**，
// 否则 Agent 会先 nohup 起一遍、等 90 秒觉得没进展、再跑一遍——真机上就这么浪费了 4 分钟。
const estimateMin = hasDecompile ? 5 : 3
console.error(
  `[ghidra] 开始分析 ${path.basename(target)}（预计 ${estimateMin} 分钟内；` +
    `输出到 ${opts.out ?? 'stdout'}）。这一趟是**完整反编译**，重复跑不会更快——等它结束。`,
)

const outFile = path.resolve(opts.out ?? path.join(projectDir, 'probe.txt'))
const scriptPath = path.join(HERE)

const launcher = launcherFor(ghidraDir)
const args = [
  projectDir,
  projectName,
  '-import', target,
  '-scriptPath', scriptPath,
  '-postScript', SCRIPT_NAME, outFile,
  ...(opts.decompile > 0 ? ['--decompile', String(opts.decompile)] : []),
  '-deleteProject',
]

// `bash` 工具的单次调用有超时；**直接同步跑完**即可（默认 3–5 分钟），
// 不要 nohup + sleep 轮询——那样大概率会再起一遍，白烧一整轮分析。
const res = spawnSync(launcher, args, {
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
  // .bat 必须经 shell 起；其它平台直接 exec
  shell: process.platform === 'win32',
})

const log = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
if (!fs.existsSync(outFile)) {
  // 失败时把最有信息量的几行捞出来——analyzeHeadless 的完整输出是几十行 classpath
  const lines = log.split(/\r?\n/).filter((l) => /ERROR|Invalid script|not found|Usage:/i.test(l))
  fail(4, `Ghidra 分析失败（未产出结果文件）。\n${lines.slice(-8).join('\n') || log.slice(-800)}`)
}

const text = fs.readFileSync(outFile, 'utf8')
process.stdout.write(text)
if (!text.includes('FORMAT=')) fail(4, 'Ghidra 跑完了但输出不含 FORMAT=，脚本可能没真正执行。')
