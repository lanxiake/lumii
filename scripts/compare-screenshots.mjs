/**
 * 像素级截图对比：逐像素比对两次采集的同名截图，报告差异统计。
 *
 * 整图平均色会掩盖局部差异，逐像素不会；但**截图本身有非确定性**，所以：
 *   - 默认裁掉四周 N 像素（窗口边缘抗锯齿），只比内容区
 *   - 判定用「平均通道差」而非「差异像素数」——后者主体是全局抖动
 *
 * ⚠️ 已知局限（2026-09-20 实测基线）：同版本连跑两次，含动画/计时/图表的页面
 * （对话页、概览页）差异像素就有 12–14%、单通道最大差 200+，平均差 3–15。
 * 因此本工具**只能发现大幅视觉变化**；用它证明"逐像素零变更"是不成立的，
 * 那种命题要靠 CSS 层等价性论证。无动画的静态页（智能体/设置/工具）噪声较小
 * （差异像素 <1%、平均差 ~1.6）。
 *
 * 用法：node scripts/compare-screenshots.mjs <dirA> <dirB> [--inset N]
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const args = process.argv.slice(2)
const insetIdx = args.indexOf('--inset')
const INSET = insetIdx === -1 ? 48 : Number(args[insetIdx + 1])
// 只在 --inset 真的存在时剔除它和它的值。若写成无条件的
// `i !== insetIdx && i !== insetIdx + 1`，缺省时 insetIdx 为 -1，
// `insetIdx + 1` 变成 0，会把第一个位置参数也一并滤掉。
const positional =
  insetIdx === -1 ? args : args.filter((arg, i) => i !== insetIdx && i !== insetIdx + 1)
const [dirA, dirB] = positional

if (!dirA || !dirB) {
  console.error('用法: node scripts/.pixel-diff.mjs <dirA> <dirB> [--inset N]')
  process.exit(1)
}

// sharp 装在 apps/windows 下；路径相对脚本位置而非 cwd，免得换目录跑就解析失败
const require = createRequire(path.join(import.meta.dirname, '..', 'apps/windows/package.json'))
const sharp = require('sharp')

/** 裁掉四周 INSET 像素，返回 raw RGBA */
async function loadInset(file, inset) {
  const img = sharp(file)
  const meta = await img.metadata()
  const region = {
    left: inset,
    top: inset,
    width: meta.width - inset * 2,
    height: meta.height - inset * 2,
  }
  const { data, info } = await img.extract(region).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  return { data, info }
}

const names = fs.readdirSync(dirA).filter((f) => /\.(png|jpg)$/.test(f))
let worstAvg = 0
let worstName = ''

for (const name of names.sort()) {
  const pa = path.join(dirA, name)
  const pb = path.join(dirB, name)
  if (!fs.existsSync(pb)) {
    console.log(`${name}: 对比组缺失`)
    continue
  }
  const a = await loadInset(pa, INSET)
  const b = await loadInset(pb, INSET)
  if (a.info.width !== b.info.width || a.info.height !== b.info.height) {
    console.log(`${name}: 尺寸不同`)
    continue
  }
  const n = a.info.width * a.info.height
  let diffPx = 0
  let maxDelta = 0
  let sumDelta = 0
  let bigPx = 0 // 单通道差 > 8 的像素（肉眼可辨阈值附近）
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
    )
    if (d > 0) {
      diffPx++
      sumDelta += d
      if (d > maxDelta) maxDelta = d
      if (d > 8) bigPx++
    }
  }
  const avg = diffPx ? sumDelta / diffPx : 0
  if (avg > worstAvg) {
    worstAvg = avg
    worstName = name
  }
  console.log(
    `${name.padEnd(22)} 差异像素 ${((diffPx / n) * 100).toFixed(2)}%  平均差 ${avg.toFixed(2)}  最大差 ${maxDelta}  >8 的像素 ${bigPx}`,
  )
}

console.log(`\n最差平均差：${worstAvg.toFixed(2)}（${worstName}）`)
console.log(worstAvg < 1 ? '✓ 平均差 < 1，可判为等价' : '✗ 存在可见差异，需人工确认')
process.exit(worstAvg < 1 ? 0 : 1)

