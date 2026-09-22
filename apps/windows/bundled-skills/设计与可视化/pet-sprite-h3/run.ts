#!/usr/bin/env node
/**
 * pet-sprite-h3 — 可执行技能入口
 *
 * ## 为什么需要这一层（不是多此一举）
 *
 * 底下的工具脚本要 `import sharp`，而 **ESM 的裸模块是从脚本自身位置向上找
 * `node_modules`**。技能被投放到 `~/.lumii/workspace/skills/` 之后，那条路径上
 * **没有 sharp**（实测 `require('sharp')` → MODULE_NOT_FOUND），脚本会直接起不来。
 *
 * 所以这里做一件事：**定位仓库根，从仓库里那份跑**（`apps/windows/bundled-skills/...`
 * 在仓库树内，一路向上能解析到根 node_modules）。
 *
 * 分工上这一层只做「找对位置 + 转发参数 + 回传结果」，**不做任何判断**——
 * 出几张图、什么动作、什么视角，全部由 Agent 按 SKILL.md 决定。
 *
 * ## 协议
 *
 * 参数来自 `process.env.SKILL_PARAMS`（JSON）；结果以 `__SKILL_RESULT__:{json}` 打到 stdout。
 *
 * ```jsonc
 * { "op": "sheet",  "char": "tuanzi", "action": "walk", "charName": "团子" }
 * { "op": "batch",  "jobs": "tuanzi:walk,tuanzi:climb" }
 * { "op": "pose",   "char": "tuanzi", "action": "side" }
 * { "op": "stage",  "src": "<帧.png>", "out": "<staged/角色.png>", "canvas": "576x672", "ratio": 0.70 }
 * { "op": "pick",   "dir": "<拼条.png>", "cols": 16, "pick": "desc" }
 * { "op": "sheetcanvas", "dir": "<动作表根目录>", "char": "tuanzi", "canvas": "448x448" }
 * { "op": "install","id": "demo_cartoon_cat", "dir": "<动作表根目录>", "canvas": "<量出来的宽>x448" }
 * { "op": "list" }   // 查 ComfyUI 队列
 * ```
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const RESULT_PREFIX = '__SKILL_RESULT__:'
const HERE = path.dirname(fileURLToPath(import.meta.url))

/**
 * 仓库根：向上找标记目录，不写死层数。
 *
 * 先看自己所在的树（技能在仓库里直接跑的情形）；找不到再退到「技能被投放进
 * 用户工作区」的情形——那时脚本自己那份跑不了（没有 sharp），得回到仓库那份。
 */
function findRepoRoot(start) {
  let d = start
  for (let i = 0; i < 12; i++) {
    if (fs.existsSync(path.join(d, 'apps/windows/bundled-skills'))) return d
    const up = path.dirname(d)
    if (up === d) break
    d = up
  }
  return null
}

function readParams() {
  const raw = process.env.SKILL_PARAMS
  if (!raw) throw new Error('缺少 SKILL_PARAMS')
  try {
    return JSON.parse(raw)
  } catch (err) {
    throw new Error(`SKILL_PARAMS 不是合法 JSON：${err.message}`)
  }
}

/** 技能在仓库里的固定位置。**跑的一定是这一份**，不是被投放的那份（见头注释） */
function toolsDir() {
  const repo = findRepoRoot(HERE)
  if (!repo) {
    throw new Error(
      `从 ${HERE} 向上找不到仓库根（标记：apps/windows/bundled-skills）。` +
        `本技能的工具脚本要 import sharp，必须在仓库树内运行；` +
        `脱离仓库使用时先 npm i sharp 再直接调 characters/*.mjs。`,
    )
  }
  return path.join(repo, 'apps/windows/bundled-skills/设计与可视化/pet-sprite-h3/characters')
}

/** 跑一个工具脚本，原样把 stdout/stderr 转出去，返回退出码 */
function run(script, args) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(toolsDir(), script), ...args], {
      stdio: ['ignore', 'inherit', 'inherit'],
    })
    child.on('close', (code) => resolve(code ?? 1))
    child.on('error', (err) => {
      console.error(`[pet-sprite-h3] 起不来 ${script}：${err.message}`)
      resolve(1)
    })
  })
}

const str = (v, name) => {
  if (typeof v !== 'string' || !v) throw new Error(`缺少参数 ${name}`)
  return v
}
/** 数值参数可选；给了才加进 argv（工具的默认值是有依据的，别用 0/'' 覆盖掉） */
const optFlag = (args, flag, v) => {
  if (v !== undefined && v !== null && v !== '') args.push(`--${flag}`, String(v))
}

async function main() {
  const p = readParams()
  const op = str(p.op, 'op')
  const args = []

  switch (op) {
    case 'sheet':
      args.push('sheet', '--char', str(p.char, 'char'), '--action', str(p.action, 'action'))
      optFlag(args, 'frames', p.frames)
      optFlag(args, 'picks', p.picks)
      optFlag(args, 'cell', p.cell)
      break
    case 'batch':
      args.push('batch', '--jobs', str(p.jobs, 'jobs'), '--sheet')
      optFlag(args, 'frames', p.frames)
      optFlag(args, 'picks', p.picks)
      break
    case 'pose':
      args.push('pose', '--char', str(p.char, 'char'), '--action', str(p.action, 'action'))
      optFlag(args, 'picks', p.picks)
      break
    case 'stage':
      args.push(str(p.src, 'src'), str(p.out, 'out'))
      optFlag(args, 'canvas', p.canvas)
      optFlag(args, 'ratio', p.ratio)
      optFlag(args, 'baseline', p.baseline)
      optFlag(args, 'bg', p.bg)
      optFlag(args, 'meta', p.meta)
      if (p.keepScale) args.push('--keep-scale')
      break
    case 'install':
      args.push('--id', str(p.id, 'id'), '--dir', str(p.dir, 'dir'))
      optFlag(args, 'char', p.char)
      optFlag(args, 'canvas', p.canvas)
      optFlag(args, 'bg', p.bg)
      optFlag(args, 'cols', p.cols)
      optFlag(args, 'rows', p.rows)
      break
    case 'list':
      args.push('list')
      break
    case 'sheetcanvas':
      args.push('--dir', str(p.dir, 'dir'))
      optFlag(args, 'char', p.char)
      optFlag(args, 'canvas', p.canvas)
      optFlag(args, 'canvas-h', p.canvasH)
      optFlag(args, 'cols', p.cols)
      break
    case 'pick':
      // 位置参数（拼条路径）与四个可选参数在 switch 之后统一拼——`pose-pick.mjs`
      // 的用法是 `<拼条.png> [--cols N]`，路径在前，和别的子命令不一样。
      // ⚠ 这个 case 一度是**漏的**：底下的 `script` 选择写了 `op === 'pick'`，
      // 但 switch 先一步把它丢进 default 报「未知 op」，两处不一致而**只有一处生效**。
      break
    default:
      throw new Error(`未知 op "${op}"，见本文件头部的协议说明`)
  }

  // stage / pick / sheetcanvas 分别属于不同脚本
  const script =
    op === 'stage'
      ? 'stage-frame.mjs'
      : op === 'install'
        ? 'install-pet.mjs'
        : op === 'pick'
          ? 'pose-pick.mjs'
          : op === 'sheetcanvas'
            ? 'sheet-canvas.mjs'
            : 'h3-motion.mjs'
  if (op === 'pick') {
    args.unshift(str(p.dir, 'dir'))
    optFlag(args, 'cols', p.cols)
    optFlag(args, 'pick', p.pick)
    optFlag(args, 'emit', p.emit)
    optFlag(args, 'window', p.window)
  }

  console.log(`[pet-sprite-h3] ${op} → ${script} ${args.join(' ')}`)
  const code = await run(script, args)
  console.log(`${RESULT_PREFIX}${JSON.stringify({ ok: code === 0, op, exitCode: code })}`)
  process.exitCode = code
}

main().catch((err) => {
  console.error(`[pet-sprite-h3] ${err.message}`)
  console.log(`${RESULT_PREFIX}${JSON.stringify({ ok: false, error: err.message })}`)
  process.exitCode = 1
})
