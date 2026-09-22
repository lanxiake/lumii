#!/usr/bin/env node
/**
 * pixelorama — 精灵图处理流水线（可执行技能入口）
 *
 * ## 职责边界
 *
 * **本脚本不做判断**，只做确定性的像素操作：
 *   抠底 → 切片 → 归一化 → 量化 → 导出
 *
 * 「切几格、容差多少、要多少色」全部由 SKILL.md 编排的 Agent 决定，通过
 * `SKILL_PARAMS` 传进来。判断塞进脚本，它遇到没见过的情况就只能猜。
 *
 * ## 协议
 *
 * - 入参：`process.env.SKILL_PARAMS`（JSON）
 * - 出参：stdout 上打 `__SKILL_RESULT__:{json}`
 *
 * ## 为什么是"驱动一个跑在 Pixelorama 里的 GDScript"
 *
 * Pixelorama 上游的 CLI（`src/Main.gd` 的 `args_list`）是**纯导出导向**的：
 * 打开文件 → 导出 png/spritesheet。没有切片、没有抠底。要加就得改上游源码。
 *
 * 本技能改走 `godot --script <绝对路径>`——实测可以指到项目**外**的 .gd 文件，
 * 所以执行器（`gd/pixelorama_cli.gd`）整个活在 Pixelorama 仓库之外，升级不受影响。
 *
 * 换来的最大价值是**能复用它的 SmartSlicer**（`RegionUnpacker`）：
 * 按真实内容边界切图，而不是按固定网格。角色撑破格子时它会如实报
 * 「这是一个连通区域」，而不是假装切好了——这个诚实比"总能切出 4 张"有用得多。
 *
 * ## 实测踩过的坑（别改回去）
 *
 * 1. **必须用 `_console.exe`**。Godot 在 Windows 上把主 exe 编成 GUI 子系统，
 *    它写 stdout 但**不接到调用方的管道**——用主 exe 会拿到空输出且不报错。
 * 2. **不要加 `--quiet`**。实测它连 `print()` 一起吞掉：
 *    结果标记在 stdout 的出现次数，加与不加是 0 与 2。
 * 3. **Godot 冷启动约 3.7 秒**（首帧前要加载上百个资源），而命令本身执行 0ms。
 *    所以 `clean` 一次做完所有步骤，不要拆成多次调用。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const RESULT_PREFIX = '__SKILL_RESULT__:'
const OUT_BEGIN = '<<<PIXELORAMA_CLI_JSON>>>'
const OUT_END = '<<<PIXELORAMA_CLI_JSON_END>>>'
const HERE = path.dirname(fileURLToPath(import.meta.url))

// ---------------------------------------------------------------------------
// 环境发现
// ---------------------------------------------------------------------------

/**
 * 找 Godot 可执行文件。
 *
 * ⚠️ 只认 `_console.exe`：主 exe 拿不到 stdout（见文件头第 1 条）。
 * 万一只有主 exe，也返回它，但在结果里带一句警告——总比"什么都没找到"强。
 */
function findGodot() {
  const tried = []
  const candidates = []
  if (process.env.PIXELORAMA_GODOT) candidates.push(process.env.PIXELORAMA_GODOT)

  const dir = path.join(os.homedir(), '.lumii', 'tools', 'godot')
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir)
    for (const f of files.filter((f) => /^Godot_v.*_console\.exe$/.test(f)).sort().reverse()) {
      candidates.push(path.join(dir, f))
    }
    for (const f of files.filter((f) => /^Godot_v.*\.exe$/.test(f) && !/_console/.test(f))) {
      candidates.push(path.join(dir, f))
    }
  }
  for (const c of candidates) {
    tried.push(c)
    if (fs.existsSync(c)) return { path: c, isConsole: /_console\.exe$/.test(c), tried }
  }
  return { path: null, isConsole: false, tried }
}

/** 找 Pixelorama 源码目录（必须含 project.godot）。 */
function findPixelorama() {
  const tried = []
  const candidates = []
  if (process.env.PIXELORAMA_SRC) candidates.push(process.env.PIXELORAMA_SRC)
  const home = os.homedir()
  candidates.push(
    'C:/myself/projects/open-source/Pixelorama',
    path.join(home, 'Pixelorama'),
    path.join(home, 'projects', 'Pixelorama'),
    path.join(home, 'Documents', 'Pixelorama'),
  )
  for (const c of candidates) {
    tried.push(c)
    if (c && fs.existsSync(path.join(c, 'project.godot'))) {
      return { path: c.replace(/\\/g, '/'), tried }
    }
  }
  return { path: null, tried }
}

/** 环境缺什么就给对应的安装指引——别只说"找不到"。 */
function missingEnvError() {
  const g = findGodot()
  const p = findPixelorama()
  if (!g.path) {
    return (
      '找不到 Godot。需要 **Godot 4.7.x**（Pixelorama v1.2.3 要求 4.7.2，旧版打不开）。\n' +
      '下载：https://godotengine.org/download/archive/4.7.2-stable/ → 解压出 `_console.exe`\n' +
      `放到 ${path.join(os.homedir(), '.lumii', 'tools', 'godot')}/ ，` +
      '或用环境变量 `PIXELORAMA_GODOT` 指到它。\n' +
      `找过：${g.tried.join(' | ')}`
    )
  }
  if (!p.path) {
    return (
      '找不到 Pixelorama 源码目录（要含 project.godot 的**源码**，不是安装好的应用）。\n' +
      'git clone https://github.com/Orama-Interactive/Pixelorama\n' +
      '克隆后**必须先导入一次资源**，否则运行时报一堆资源加载失败：\n' +
      '  godot --headless --path <Pixelorama 目录> --import\n' +
      '或用环境变量 `PIXELORAMA_SRC` 指过去。\n' +
      `找过：${p.tried.join(' | ')}`
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// 驱动 Godot
// ---------------------------------------------------------------------------

/**
 * 把一批命令交给 GDScript 执行器，取回结果。
 *
 * 一次进程吃一整批：冷启动 3.7 秒，逐条起进程会让 Agent 调十次等半分钟。
 */
function runGodot(commands, timeoutMs = 300000) {
  const g = findGodot()
  const p = findPixelorama()
  const gdScript = path.join(HERE, 'gd', 'pixelorama_cli.gd').replace(/\\/g, '/')
  if (!fs.existsSync(gdScript)) {
    return Promise.resolve({ ok: false, error: `执行器缺失：${gdScript}` })
  }

  const taskFile = path.join(os.tmpdir(), `pixelorama-cli-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(taskFile, JSON.stringify({ id: String(Date.now()), commands }), 'utf8')

  const args = ['--headless', '--path', p.path, '--script', gdScript, '--', taskFile]

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(g.path, args, { windowsHide: true })
    let out = ''
    let err = ''
    let settled = false
    const warn = g.isConsole ? undefined : ['用的是主 exe，stdout 可能不全——应该用 _console.exe']

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      resolve({ ok: false, total_ms: Date.now() - startedAt, error: `Godot 超时（${timeoutMs}ms）`, warnings })
    }, timeoutMs)

    child.stdout.on('data', (d) => (out += d.toString('utf8')))
    child.stderr.on('data', (d) => (err += d.toString('utf8')))
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, total_ms: Date.now() - startedAt, error: `起不了 Godot 进程：${e.message}`, warnings: warn })
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        fs.unlinkSync(taskFile)
      } catch {}

      const total_ms = Date.now() - startedAt
      const i = out.indexOf(OUT_BEGIN)
      const j = out.indexOf(OUT_END)
      if (i === -1 || j === -1) {
        // 没标记 = 执行器根本没跑起来。把 Godot 自己的报错带回去，别只说"解析失败"——
        // 最常见的原因是执行器引用了带 autoload 依赖的类（见 pixelorama_cli.gd 的说明）。
        const tail = (out + err)
          .split('\n')
          .filter((l) => /ERROR|SCRIPT|Parse/.test(l))
          .slice(-6)
        resolve({
          ok: false,
          total_ms,
          error: 'Godot 没有返回结果标记（执行器没跑起来？）',
          godot_output_tail: tail,
          warnings: warn,
        })
        return
      }
      try {
        resolve({ ...JSON.parse(out.slice(i + OUT_BEGIN.length, j).trim()), total_ms, warnings: warn })
      } catch (e) {
        resolve({ ok: false, total_ms, error: `结果不是合法 JSON：${e.message}`, warnings: warn })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// 动作
// ---------------------------------------------------------------------------

/** 把常用参数规范化，顺带校验——错了就在调 Godot 之前报出来，省 3.7 秒。 */
function imageCmd(p) {
  const cmd = { file: p.file }
  if (typeof p.tol === 'number') cmd.tol = p.tol
  if (Array.isArray(p.bg) && p.bg.length >= 3) cmd.bg = p.bg
  return cmd
}

function sliceCmd(p) {
  const mode = p.mode ?? 'auto'
  if (!['auto', 'grid'].includes(mode)) throw new Error(`mode 只能是 auto 或 grid，收到「${mode}」`)
  const cmd = { mode }
  if (mode === 'grid') {
    if (!p.cols || !p.rows) throw new Error('grid 模式需要 cols 与 rows')
    cmd.cols = p.cols
    cmd.rows = p.rows
  }
  if (typeof p.threshold === 'number') cmd.threshold = p.threshold
  if (typeof p.mergeDist === 'number') cmd.merge_dist = p.mergeDist
  return cmd
}

const ACTIONS = {
  /** 环境自检。Agent 第一步就该跑它。 */
  async probe() {
    const missing = missingEnvError()
    if (missing) return { ok: false, error: missing }
    return runGodot([{ op: 'probe' }], 60000)
  },

  /** 看清一张图的实际状况：尺寸、背景色、内容包围盒、颜色数。 */
  async analyze(p) {
    if (!p.file) throw new Error('analyze 需要 file')
    return runGodot([{ op: 'analyze', ...imageCmd(p) }])
  },

  /** 只报告切出哪些区域，不落盘。 */
  async slice(p) {
    if (!p.file) throw new Error('slice 需要 file')
    return runGodot([{ op: 'slice', ...imageCmd(p), ...sliceCmd(p) }])
  },

  /** 只抠底。 */
  async cutout(p) {
    if (!p.file) throw new Error('cutout 需要 file')
    return runGodot([{ op: 'cutout', ...imageCmd(p), out: p.out ?? '' }])
  },

  /** 只量化。 */
  async quantize(p) {
    if (!p.file) throw new Error('quantize 需要 file')
    return runGodot([{ op: 'quantize', ...imageCmd(p), colors: p.colors ?? 32, out: p.out ?? '' }])
  },

  /** 一步到位：抠底 → 切片 → 归一化 →（可选）量化 → 导出独立帧。 */
  async clean(p) {
    if (!p.file) throw new Error('clean 需要 file')
    if (!p.outDir) throw new Error('clean 需要 outDir')
    const cmd = {
      op: 'clean',
      ...imageCmd(p),
      ...sliceCmd(p),
      out_dir: String(p.outDir).replace(/\\/g, '/'),
      prefix: p.prefix ?? 'frame',
    }
    if (p.colors) cmd.colors = p.colors
    if (p.canvas?.w && p.canvas?.h) cmd.canvas = { w: p.canvas.w, h: p.canvas.h }
    return runGodot([cmd])
  },
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

function emit(payload) {
  process.stdout.write(RESULT_PREFIX + JSON.stringify(payload) + '\n')
}

async function main() {
  const raw = process.env.SKILL_PARAMS
  if (!raw) {
    emit({
      ok: false,
      error:
        '缺少 SKILL_PARAMS。这个入口是给客户端做可执行技能用的，参数要放在环境变量 SKILL_PARAMS 里传。',
    })
    return
  }
  let params
  try {
    params = JSON.parse(raw)
  } catch (e) {
    emit({ ok: false, error: `SKILL_PARAMS 不是合法 JSON：${e.message}` })
    return
  }

  const action = params.action
  const fn = ACTIONS[action]
  if (!fn) {
    emit({
      ok: false,
      error: `未知 action「${action}」。可用：${Object.keys(ACTIONS).join(' / ')}`,
    })
    return
  }

  const r = await fn(params)
  // 单命令的动作把内层结果**提到顶层**：Agent 读 `result.count`，
  // 而不是 `result.results[0].count` —— 少一层就少一次读错的机会。
  const inner = Array.isArray(r.results) && r.results.length === 1 ? r.results[0] : null
  const out = {}
  for (const [k, v] of Object.entries(r)) {
    if (k === 'results' && inner) continue
    out[k] = v
  }
  emit({ action, ...out, ...(inner ?? {}) })
}

main().catch((e) => {
  emit({ ok: false, error: e instanceof Error ? e.message : String(e) })
})
