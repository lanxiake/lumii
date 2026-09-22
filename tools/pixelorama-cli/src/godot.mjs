/**
 * godot.mjs — 找到 Godot 与 Pixelorama，把任务喂进去，把 JSON 结果取回来。
 *
 * 这一层只干"进程 + 路径 + 解析"，不含任何像素逻辑（那些在 gd/pixelorama_cli.gd）。
 */

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const OUT_BEGIN = '<<<PIXELORAMA_CLI_JSON>>>'
const OUT_END = '<<<PIXELORAMA_CLI_JSON_END>>>'

/**
 * 找 Godot 可执行文件。
 *
 * ⚠️ **必须用 `_console.exe`**。Godot 在 Windows 上把主 exe 编成 GUI 子系统，
 * 它写 stdout 但**不接到调用方的管道上**——用主 exe 会拿到空输出，
 * 现象是"命令跑完了但什么都没返回"，极难查。`_console.exe` 是配套的控制台包装器。
 */
export function findGodot() {
  const tried = []
  const candidates = []

  if (process.env.PIXELORAMA_GODOT) candidates.push(process.env.PIXELORAMA_GODOT)

  // 本仓库的安装位：~/.lumii/tools/godot/ 下取版本号最大的那个
  const dir = path.join(os.homedir(), '.lumii', 'tools', 'godot')
  if (fs.existsSync(dir)) {
    const exes = fs
      .readdirSync(dir)
      .filter((f) => /^Godot_v.*_console\.exe$/.test(f))
      .sort()
      .reverse()
    for (const f of exes) candidates.push(path.join(dir, f))
    // 退一步：没有 console 版就用主 exe（会丢 stdout，但至少能判出"装在哪"）
    const plain = fs.readdirSync(dir).filter((f) => /^Godot_v.*\.exe$/.test(f) && !/_console/.test(f))
    for (const f of plain) candidates.push(path.join(dir, f))
  }

  for (const c of candidates) {
    tried.push(c)
    if (fs.existsSync(c)) {
      return { path: c, tried, isConsole: /_console\.exe$/.test(c) }
    }
  }
  return { path: null, tried, isConsole: false }
}

/** 找 Pixelorama 项目目录（含 project.godot）。 */
export function findPixelorama() {
  const tried = []
  const candidates = []

  if (process.env.PIXELORAMA_SRC) candidates.push(process.env.PIXELORAMA_SRC)

  const home = os.homedir()
  // 本机实际位置 + 几个常见布局
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

/** 本 harness 自带的 GDScript 执行器。 */
export function scriptPath() {
  return path.join(import.meta.dirname, '..', 'gd', 'pixelorama_cli.gd').replace(/\\/g, '/')
}

/**
 * 跑一批命令。
 *
 * 一次进程吃一整批：Godot 冷启动本项目实测 2–5 秒（首帧前要加载上百个资源），
 * 逐条起进程会让 Agent 调十次等半分钟。
 */
export function runTask(commands, { timeoutMs = 300000, godot, project } = {}) {
  const g = godot ? { path: godot, isConsole: true } : findGodot()
  const p = project ? { path: project } : findPixelorama()

  if (!g.path) {
    return Promise.resolve({
      ok: false,
      error:
        '找不到 Godot。装一个 4.7.x，或把路径写进环境变量 PIXELORAMA_GODOT。' +
        `找过这些位置：${g.tried.join(' | ')}`,
    })
  }
  if (!p.path) {
    return Promise.resolve({
      ok: false,
      error:
        '找不到 Pixelorama 源码目录（要含 project.godot）。' +
        '设环境变量 PIXELORAMA_SRC 指过去。' +
        `找过这些位置：${p.tried.join(' | ')}`,
    })
  }

  const taskFile = path.join(os.tmpdir(), `pixelorama-cli-${process.pid}-${Date.now()}.json`)
  fs.writeFileSync(taskFile, JSON.stringify({ id: String(Date.now()), commands }), 'utf8')

  const args = [
    '--headless',
    '--path',
    p.path,
    '--script',
    scriptPath(),
    '--',
    taskFile,
  ]
  // ⚠️ 不要加 `--quiet`。实测它会连 `print()` 一起吞掉——
  // 加与不加，结果标记在 stdout 里的出现次数是 0 与 2。
  // 日志多没关系，接收侧本来就靠标记取结果，不靠"第几行"。

  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(g.path, args, { windowsHide: true })
    let out = ''
    let err = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill()
      } catch {}
      resolve({ ok: false, error: `Godot 超时（${timeoutMs}ms）。任务：${JSON.stringify(commands).slice(0, 200)}` })
    }, timeoutMs)

    child.stdout.on('data', (d) => (out += d.toString('utf8')))
    child.stderr.on('data', (d) => (err += d.toString('utf8')))
    child.on('error', (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ ok: false, error: `起不了 Godot 进程：${e.message}` })
    })
    child.on('close', () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      // 两个耗时都要报，别混为一谈：
      //   `elapsed_ms`（GDScript 打的）只算命令执行，不含 Godot 启动；
      //   `total_ms` 是墙钟总时间，含冷启动。
      // Godot 冷启动本项目实测 2–5 秒——Agent 决定"要不要把几条命令并成一批"时
      // 看的是后者，只看前者会以为很便宜。
      const total_ms = Date.now() - startedAt
      try {
        fs.unlinkSync(taskFile)
      } catch {}

      const i = out.indexOf(OUT_BEGIN)
      const j = out.indexOf(OUT_END)
      if (i === -1 || j === -1) {
        // 没有标记 = 执行器根本没跑起来。把 Godot 自己的报错带回去，别只说"解析失败"。
        const tail = (out + err).split('\n').filter((l) => /ERROR|SCRIPT|Parse/.test(l)).slice(-6)
        resolve({
          ok: false,
          total_ms,
          error: 'Godot 没有返回结果标记（执行器没跑起来？）',
          godot_output_tail: tail,
        })
        return
      }
      const raw = out.slice(i + OUT_BEGIN.length, j).trim()
      try {
        resolve({ ...JSON.parse(raw), total_ms, warnings: g.isConsole ? undefined : ['用的是主 exe，stdout 可能不全'] })
      } catch (e) {
        resolve({ ok: false, total_ms, error: `结果不是合法 JSON：${e.message}`, raw: raw.slice(0, 400) })
      }
    })
  })
}
