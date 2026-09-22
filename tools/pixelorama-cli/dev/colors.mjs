// 颜色直方图 —— 看一张图的颜色分布，判断"残留的是背景还是角色边缘"。
import { createRequire } from 'node:module'
const sharp = createRequire('C:/myself/projects/my/open-source/lumii/package.json')('sharp')

const [file, topN] = process.argv.slice(2)
const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const { width: W, height: H, channels: C } = info

const hist = new Map()
let opaque = 0
let semi = 0
for (let i = 0; i < W * H; i++) {
  const o = i * C
  const a = data[o + 3]
  if (a === 0) continue
  opaque++
  if (a < 250) semi++
  const key = (data[o] << 16) | (data[o + 1] << 8) | data[o + 2]
  hist.set(key, (hist.get(key) ?? 0) + 1)
}

const total = W * H
console.log(`${file}  ${W}×${H}`)
console.log(`不透明 ${opaque} (${((opaque / total) * 100).toFixed(2)}%)  其中半透明(a<250) ${semi} (${((semi / total) * 100).toFixed(2)}%)`)
console.log(`唯一色 ${hist.size}`)
const sorted = [...hist.entries()].sort((a, b) => b[1] - a[1]).slice(0, Number(topN ?? 12))
console.log('出现最多的颜色：')
for (const [k, n] of sorted) {
  const hex = k.toString(16).padStart(6, '0')
  console.log(`  #${hex}  ${String(n).padStart(7)}  ${((n / opaque) * 100).toFixed(2)}%`)
}
