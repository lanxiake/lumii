/**
 * 配图与封面的交付判据（`content-to-assets` 的 verify-assets 步）。
 *
 * 放在流水线目录里而不是内联进 spec：内联要在 JSON 字符串里嵌一段带引号的 JS，
 * 可读性与可测性都归零（第一版就是这么写的，`node -e` 的引号转义把正则都搅坏了）。
 * 流水线目录是整目录播种的，附带文件会被一起复制到工作区。
 *
 * 两条判据都来自真机教训（2026-11-03）：
 * 1. **不用 `find -size +10k`**：Git Bash 下它按 1024 字节块向上取整算，
 *    9120 字节的文件被判成"小于 10k"，于是"图明明在"却报 IMAGES=0。直接比字节数。
 * 2. **不信 `COVER.txt`**：那是 agent 自己写的，它写什么就是什么。尺寸从 PNG 头读，
 *    非 PNG 就如实说核对不了，不猜。
 *
 * 用法：node check-assets.cjs <images 目录> [期望宽x高，缺省 768x1024]
 */
const fs = require('fs')
const path = require('path')

const dir = process.argv[2]
const wantDim = process.argv[3] || '768x1024'
const MIN_BYTES = 10 * 1024

if (!dir || !fs.existsSync(dir)) {
  console.error(`图片目录不存在: ${dir ?? '(未给参数)'}`)
  process.exit(1)
}

const files = fs.readdirSync(dir).filter((f) => /\.(png|jpe?g)$/i.test(f))
const big = files.filter((f) => fs.statSync(path.join(dir, f)).size > MIN_BYTES)

console.log(`IMAGES=${big.length} TOTAL=${files.length}`)
for (const f of files) console.log(`  ${f} ${fs.statSync(path.join(dir, f)).size}B`)

if (big.length < 2) {
  console.error(`可用配图不足 2 张（实际 ${big.length}）——内容是成片素材，缺图就没法发`)
  process.exit(1)
}

const cover = files.find((f) => /^cover\./i.test(f))
if (!cover) {
  console.error('没有 cover.* 封面文件')
  process.exit(1)
}

const buf = fs.readFileSync(path.join(dir, cover))
let dim = 'unknown'
if (buf.slice(1, 4).toString() === 'PNG') {
  dim = `${buf.readUInt32BE(16)}x${buf.readUInt32BE(20)}`
} else {
  console.error('封面不是 PNG，尺寸无法静态核对（JPEG 要解 SOF 段，这里不猜）')
}
console.log(`COVER=${cover} ${dim}`)

if (dim !== wantDim) {
  console.error(`封面实测 ${dim} ≠ ${wantDim}——发出去会被裁`)
  process.exit(1)
}
console.log('COVER_RATIO=ok')
