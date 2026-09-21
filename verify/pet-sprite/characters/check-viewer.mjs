#!/usr/bin/env node
/**
 * check-viewer.mjs — 验 `make-viewer.mjs` 产出的预览页
 *
 * ## 为什么需要它
 *
 * 预览页里的东西**在浏览器打开之前全是看不见的**：脚本语法错、图层引用了图集里
 * 不存在的条目、once 动作的两端没钉住——这几种都只有肉眼看到白屏或怪图才会发现。
 * 写这个页面时连续踩了两次「注释里带了反引号，把模板字符串截断」，
 * 而 `node make-viewer.mjs` 只是抛一个语法错，产物根本没更新。
 *
 * ## ⚠ 它读的是**文件**，所以必须紧跟着生成跑
 *
 * 这句是踩出来的：生成失败时产物不会更新，而校验脚本照样把**上一次的旧页面**
 * 验通过。所以调用要串起来，不能分号：
 *
 *   node make-viewer.mjs && node check-viewer.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import vm from 'node:vm'

const file = path.join(os.homedir(), '.lumii/workspace/outputs/pet-review/index.html')
if (!fs.existsSync(file)) throw new Error(`预览页不存在：${file}——先跑 make-viewer.mjs`)
const html = fs.readFileSync(file, 'utf-8')

const m = html.match(/<script>([\s\S]*?)<\/script>/)
if (!m) throw new Error('页面里没有 <script>')

// 1. 内联脚本能不能解析
try {
  new vm.Script(m[1], { filename: 'inline.js' })
  console.log('✓ 内联脚本语法通过')
} catch (e) {
  throw new Error(`内联脚本语法错误：${e.message}`)
}

// 2. 图层引用：每一帧声明的每个部件都得在图集里
const packsJson = m[1].match(/const PACKS = (\[[\s\S]*?\]);\n/)
if (!packsJson) throw new Error('页面里找不到 PACKS')
const PACKS = JSON.parse(packsJson[1])

let bad = 0
for (const p of PACKS) {
  const names = new Set(Object.keys(p.frames))
  const missing = new Set()
  for (const a of p.animations) {
    for (const f of a.frames) {
      if (f.base && !names.has(f.base)) missing.add(`${a.group}: base=${f.base}`)
      for (const [slot, cats] of Object.entries(f.slots)) {
        for (const [cat, part] of Object.entries(cats)) {
          if (!names.has(part)) missing.add(`${a.group}: ${slot}.${cat}=${part}`)
        }
      }
    }
  }
  console.log(
    `  ${p.id}：${p.animations.length} 组 · 图集 ${names.size} 帧 · ` +
      `槽位 [${Object.keys(p.slots).join(',') || '无'}] · ` +
      (missing.size === 0 ? '图层引用全部命中 ✓' : `✗ 悬空引用 ${[...missing].join(' ')}`),
  )
  if (missing.size) bad++
}
if (bad) process.exit(1)

// 3. Idle Pin：once 动作的两端必须与 Idle 首帧是**同一个图集条目**
console.log('\nIdle Pin 检查（once 动作的两端 vs 待机首帧）：')
for (const p of PACKS) {
  const idle = p.animations.find((a) => a.group === 'Idle')
  const once = p.animations.find((a) => a.kind === 'once')
  if (!idle || !once) {
    console.log(`  ${p.id}：没有 once 动作，跳过`)
    continue
  }
  const want = idle.frames[0].base
  const head = once.frames[0].base
  const tail = once.frames[once.frames.length - 1].base
  console.log(
    `  ${p.id}  ${once.group} ${once.frames.length} 帧  首=${head} 末=${tail}  待机首帧=${want}  ` +
      (head === want && tail === want ? '✓ 钉住' : '✗ 没钉住'),
  )
}
