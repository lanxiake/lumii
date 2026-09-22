#!/usr/bin/env node
/**
 * pixelorama — 用 Pixelorama 处理像素精灵图的 CLI
 *
 * 面向 AI Agent：每个子命令都支持 `--json`，一次调用返回结构化结果。
 * 底层是 Godot headless + 一段 GDScript（`gd/pixelorama_cli.gd`），
 * 复用 Pixelorama 自己的算法（切片走它的 SmartSlicer）。
 *
 * 典型用途：把 AI 出的精灵图（背景脏、格子不齐、没有 alpha）
 * 变成一组干净、同尺寸、脚底对齐的帧。
 */

import fs from 'node:fs'
import path from 'node:path'
import { runTask, findGodot, findPixelorama } from '../src/godot.mjs'

// ---------------------------------------------------------------- 参数解析

const argv = process.argv.slice(2)
const jsonMode = argv.includes('--json')
const rest = argv.filter((a) => a !== '--json')

/** 取 `--name value`。没给就返回 fallback。 */
function opt(name, fallback = undefined) {
  const i = rest.indexOf(`--${name}`)
  if (i === -1) return fallback
  const v = rest[i + 1]
  if (v === undefined || v.startsWith('--')) return fallback
  return v
}
const has = (name) => rest.includes(`--${name}`)

/** 位置参数（去掉选项与它们的值）。 */
function positional() {
  const out = []
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]
    if (a.startsWith('--')) {
      // 只有"带值"的选项才吃掉下一个 token
      const takesValue = ['--mode', '--cols', '--rows', '--tol', '--bg', '--out', '--out-dir', '--prefix', '--canvas', '--threshold', '--merge-dist']
      if (takesValue.includes(a)) i++
      continue
    }
    out.push(a)
  }
  return out
}

function parseCanvas(s) {
  if (!s) return undefined
  const m = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(s.trim())
  return m ? { w: Number(m[1]), h: Number(m[2]) } : undefined
}

// ---------------------------------------------------------------- 输出

function emit(payload, humanFn) {
  if (jsonMode) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  } else if (humanFn) {
    humanFn(payload)
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n')
  }
  process.exit(payload.ok === false ? 1 : 0)
}

function usage() {
  process.stdout.write(
    `pixelorama — 用 Pixelorama 处理像素精灵图

用法: pixelorama <命令> [参数] [--json]

命令:
  probe                              环境自检（Godot / Pixelorama 是否就位）
  analyze <file>                     分析一张图：尺寸、背景色、内容包围盒、颜色数
  slice   <file>                     切片
          --mode auto|grid            auto=Pixelorama 的 SmartSlicer（默认），grid=固定行列
          --cols N --rows N           grid 模式下的行列数
  cutout  <file>                     抠背景（从四边泛洪，保留角色内部的相近色）
          --out <path>                输出路径（不给就只报告、不写文件）
          --tol N                     容差 0-765，默认 60
          --bg R,G,B                  指定背景色，默认自动估计
  clean   <file> --out-dir <dir>     一步到位：抠底 → 切片 → 归一化 → 导出独立帧
          --mode auto|grid            默认 auto
          --cols N --rows N           grid 模式用
          --canvas WxH                指定输出画布，默认按最大帧自适应
          --prefix NAME               输出文件名前缀，默认 frame
          --tol N / --bg R,G,B        同 cutout

环境变量:
  PIXELORAMA_GODOT   Godot 可执行文件路径（默认找 ~/.lumii/tools/godot/）
  PIXELORAMA_SRC     Pixelorama 源码目录（含 project.godot）

示例:
  pixelorama probe --json
  pixelorama clean sheet.png --out-dir ./frames --json
  pixelorama analyze sheet.png
`,
  )
  process.exit(0)
}

// ---------------------------------------------------------------- 命令

const cmd = rest[0]
const args = positional().slice(1)

if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') usage()

function needFile() {
  const f = args[0]
  if (!f) {
    emit({ ok: false, error: '这个命令需要一个图片路径' })
  }
  const abs = path.resolve(f)
  if (!fs.existsSync(abs)) {
    emit({ ok: false, error: `文件不存在：${abs}` })
  }
  return abs.replace(/\\/g, '/')
}

/** tol / bg 是所有图像命令共用的两个参数，抽出来免得各写一遍。 */
function commonParams() {
  const p = {}
  const tol = opt('tol')
  if (tol !== undefined) p.tol = Number(tol)
  const bg = opt('bg')
  if (bg) {
    const parts = bg.split(',').map((s) => Number(s.trim()))
    if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) {
      emit({ ok: false, error: `--bg 要写成 R,G,B，收到的是「${bg}」` })
    }
    p.bg = parts
  }
  return p
}

/** slice 与 clean 共用的切片参数。 */
function sliceParams() {
  const p = {}
  const mode = opt('mode', 'auto')
  if (!['auto', 'grid'].includes(mode)) {
    emit({ ok: false, error: `--mode 只能是 auto 或 grid，收到「${mode}」` })
  }
  p.mode = mode
  if (mode === 'grid') {
    const cols = Number(opt('cols', 0))
    const rows = Number(opt('rows', 0))
    if (!cols || !rows) emit({ ok: false, error: 'grid 模式需要 --cols 与 --rows' })
    p.cols = cols
    p.rows = rows
  }
  const th = opt('threshold')
  if (th !== undefined) p.threshold = Number(th)
  const md = opt('merge_dist')
  if (md !== undefined) p.merge_dist = Number(md)
  return p
}

switch (cmd) {
  case 'probe': {
    const g = findGodot()
    const p = findPixelorama()
    if (!g.path || !p.path) {
      emit(
        {
          ok: false,
          godot: g.path,
          godot_is_console: g.isConsole,
          pixelorama: p.path,
          error: !g.path
            ? `找不到 Godot。找过：${g.tried.join(' | ')}`
            : `找不到 Pixelorama（要含 project.godot）。找过：${p.tried.join(' | ')}`,
        },
        (r) => {
          process.stdout.write(`Godot:      ${r.godot ?? '✗ 没找到'}\n`)
          process.stdout.write(`Pixelorama: ${r.pixelorama ?? '✗ 没找到'}\n`)
          if (r.error) process.stdout.write(`\n${r.error}\n`)
        },
      )
      break
    }
    const r = await runTask([{ op: 'probe' }], { godot: g.path, project: p.path })
    emit(
      {
        ...r,
        godot_path: g.path,
        godot_is_console: g.isConsole,
        pixelorama_path: p.path,
      },
      (res) => {
        const d = res.results?.[0] ?? {}
        process.stdout.write(`Godot:      ${res.godot_path}\n`)
        process.stdout.write(`Pixelorama: ${res.pixelorama_path}  (${d.pixelorama_name} ${d.pixelorama_project})\n`)
        process.stdout.write(`引擎版本:   ${d.godot}\n`)
        process.stdout.write(`显示后端:   ${d.display_server}\n`)
        process.stdout.write(`可用算法类: ${Object.entries(d.classes ?? {}).map(([k, v]) => `${k}=${v ? '✓' : '✗'}`).join(' ')}\n`)
        process.stdout.write(`耗时:       执行 ${res.elapsed_ms}ms · 含启动 ${res.total_ms}ms\n`)
      },
    )
    break
  }

  case 'analyze': {
    const file = needFile()
    const r = await runTask([{ op: 'analyze', file, ...commonParams() }])
    emit(r, (res) => {
      const d = res.results?.[0] ?? {}
      if (!d.ok) return process.stdout.write(`✗ ${d.error}\n`)
      process.stdout.write(`${d.file}\n`)
      process.stdout.write(`  尺寸      ${d.size[0]}×${d.size[1]}\n`)
      process.stdout.write(`  背景色    ${d.bg}  rgb(${d.bg_rgb})\n`)
      process.stdout.write(`  已有alpha ${d.has_alpha ? '是' : '否（必须先抠底才能切片）'}\n`)
      process.stdout.write(`  内容      ${d.content_px} px (${d.content_pct}%)\n`)
      if (d.box) process.stdout.write(`  包围盒    ${d.box.w}×${d.box.h} @ (${d.box.x0},${d.box.y0})\n`)
      process.stdout.write(`  颜色数    ${d.distinct_colors}\n`)
    })
    break
  }

  case 'slice': {
    const file = needFile()
    const r = await runTask([{ op: 'slice', file, ...sliceParams() }])
    emit(r, (res) => {
      const d = res.results?.[0] ?? {}
      if (!d.ok) return process.stdout.write(`✗ ${d.error}\n`)
      process.stdout.write(`${d.file}  mode=${d.mode}  切出 ${d.count} 个区域\n`)
      for (const [i, q] of (d.rects ?? []).entries()) {
        process.stdout.write(`  [${String(i).padStart(2)}] ${q.w}×${q.h} @ (${q.x},${q.y})\n`)
      }
    })
    break
  }

  case 'cutout': {
    const file = needFile()
    const out = opt('out')
    const r = await runTask([{ op: 'cutout', file, out: out ? path.resolve(out).replace(/\\/g, '/') : '', ...commonParams() }])
    emit(r, (res) => {
      const d = res.results?.[0] ?? {}
      if (!d.ok) return process.stdout.write(`✗ ${d.error}\n`)
      process.stdout.write(`抠掉 ${d.removed_px} px (${d.removed_pct}%)  背景 rgb(${d.bg_rgb})  容差 ${d.tol}\n`)
      if (d.box) process.stdout.write(`剩余内容 ${d.box.w}×${d.box.h} @ (${d.box.x0},${d.box.y0})\n`)
      if (d.out) process.stdout.write(`→ ${d.out}\n`)
    })
    break
  }

  case 'clean': {
    const file = needFile()
    const outDir = opt('out-dir')
    if (!outDir) emit({ ok: false, error: 'clean 需要 --out-dir' })
    const canvas = parseCanvas(opt('canvas'))
    const r = await runTask([
      {
        op: 'clean',
        file,
        out_dir: path.resolve(outDir).replace(/\\/g, '/'),
        prefix: opt('prefix', 'frame'),
        ...sliceParams(),
        ...commonParams(),
        ...(canvas ? { canvas } : {}),
      },
    ])
    emit(r, (res) => {
      const d = res.results?.[0] ?? {}
      if (!d.ok) return process.stdout.write(`✗ ${d.error}\n`)
      process.stdout.write(`抠掉 ${d.removed_px} px (${d.removed_pct}%)  背景 rgb(${d.bg_rgb})\n`)
      process.stdout.write(`切出 ${d.count} 帧  →  ${d.canvas[0]}×${d.canvas[1]} 画布\n`)
      for (const [i, f] of (d.frames ?? []).entries()) {
        const src = d.source_rects?.[i]
        process.stdout.write(`  ${path.basename(f.file)}   ${f.w}×${f.h}` + (src ? `   (源 ${src[2]}×${src[3]} @ ${src[0]},${src[1]})\n` : '\n'))
      }
    })
    break
  }

  default:
    emit({ ok: false, error: `未知命令「${cmd}」。跑 pixelorama --help 看用法。` })
}
