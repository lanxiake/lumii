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

/**
 * 读图片尺寸。PNG 读 IHDR；JPEG 扫 SOF 段。
 *
 * **JPEG 必须支持**：`image_generate` 默认出 JPG（2026-11-03 实测）。第一版只认 PNG，
 * 于是"封面明明在"却被报成 `unknown`，用户拿不到任何可操作的信息。
 */
function readDim(b) {
  if (b.slice(1, 4).toString() === 'PNG') {
    return `${b.readUInt32BE(16)}x${b.readUInt32BE(20)}`
  }
  if (b[0] === 0xff && b[1] === 0xd8) {
    // JPEG：从 2 开始逐段走，SOF0/1/2（C0/C1/C2）里带宽高
    let i = 2
    while (i + 9 < b.length) {
      if (b[i] !== 0xff) {
        i++
        continue
      }
      const marker = b[i + 1]
      const len = b.readUInt16BE(i + 2)
      if (marker >= 0xc0 && marker <= 0xc2) {
        return `${b.readUInt16BE(i + 7)}x${b.readUInt16BE(i + 5)}`
      }
      i += 2 + len
    }
  }
  return 'unknown'
}

dim = readDim(buf)
console.log(`COVER=${cover} ${dim}`)

if (dim !== wantDim) {
  console.error(`封面实测 ${dim} ≠ ${wantDim}——发出去会被裁`)
  if (dim !== 'unknown') {
    console.error(
      `提示：image_generate 不支持指定宽高（传 width/height 会 400），只能出服务商默认比例。` +
        `要 3:4 就在发布前用任意图片工具裁一次——**这条判据不会为了放行而放宽**：` +
        `尺寸不对的封面发出去就是会被平台裁掉标题。`,
    )
  }
  process.exit(1)
}
console.log('COVER_RATIO=ok')
