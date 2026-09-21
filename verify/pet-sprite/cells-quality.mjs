import { createRequire } from 'node:module'
const sharp = createRequire('C:/myself/projects/my/open-source/lumii/package.json')('sharp')

const D = 60

/**
 * 一格的统计。
 *
 * **背景色逐格自测**，不假定它是 `#00ffff`——实测三只历史产物里只有一只真是那个色，
 * 另外两只一张偏青绿、一张整张紫底。按声明的色去判，会把整张图都算成"内容"
 * （实测 `mecha-wave` 报出内容 100.0%、四格两两差异 0.0%，看着像"AI 出了四张一样的图"，
 * 其实是我的判据错了）。自测之后，四格差异与脚底散布才可比。
 */
async function analyze(file) {
  const meta = await sharp(file).metadata()
  const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H, channels: C } = info
  const cw = W / 2
  const chh = H / 2

  const cells = []
  for (let i = 0; i < 4; i++) {
    const ox = (i % 2) * cw
    const oy = Math.floor(i / 2) * chh
    const at = (x, y) => {
      const o = ((oy + y) * W + ox + x) * C
      return [data[o], data[o + 1], data[o + 2]]
    }
    // 背景色：取该格四角像素的多数派（四角通常是背景）
    const corners = [at(2, 2), at(cw - 3, 2), at(2, chh - 3), at(cw - 3, chh - 3)]
    const key = (c) => c.join(',')
    const tally = new Map()
    for (const c of corners) tally.set(key(c), (tally.get(key(c)) ?? 0) + 1)
    const bg = [...tally.entries()].sort((a, b) => b[1] - a[1])[0][0].split(',').map(Number)

    let n = 0
    let x0 = 1e9, x1 = -1, y0 = 1e9, y1 = -1
    const mask = new Uint8Array(cw * chh)
    const rgb = [0, 0, 0]
    for (let y = 0; y < chh; y++) {
      for (let x = 0; x < cw; x++) {
        const o = ((oy + y) * W + ox + x) * C
        const d = Math.abs(data[o] - bg[0]) + Math.abs(data[o + 1] - bg[1]) + Math.abs(data[o + 2] - bg[2])
        if (d > D) {
          mask[y * cw + x] = 1
          n++
          rgb[0] += data[o]; rgb[1] += data[o + 1]; rgb[2] += data[o + 2]
          if (x < x0) x0 = x
          if (x > x1) x1 = x
          if (y < y0) y0 = y
          if (y > y1) y1 = y
        }
      }
    }
    cells.push({
      n, mask, w: cw, h: chh, bg,
      box: n ? { x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 } : null,
      avg: n ? rgb.map((v) => Math.round(v / n)) : null,
    })
  }
  return { meta, cells }
}

const diff = (a, b) => {
  let d = 0
  for (let i = 0; i < a.mask.length; i++) if (a.mask[i] !== b.mask[i]) d++
  return (d / a.mask.length) * 100
}

for (const file of process.argv.slice(2)) {
  const r = await analyze(file)
  console.log(`\n=== ${file.split(/[\\/]/).pop()}  ${r.meta.width}×${r.meta.height} ===`)
  r.cells.forEach((c, i) => {
    const pct = ((c.n / (c.w * c.h)) * 100).toFixed(1)
    const b = c.box
    console.log(
      ` 格${i}  内容 ${pct.padStart(5)}%  底 ${String(b ? b.y1 : '-').padStart(3)}  盒 ${b ? `${b.w}×${b.h}` : '空'}`.padEnd(42) +
        `  背景 rgb(${c.bg})  角色均色 rgb(${c.avg})`,
    )
  })
  const bottoms = r.cells.filter((c) => c.box).map((c) => c.box.y1)
  const widths = r.cells.filter((c) => c.box).map((c) => c.box.w)
  const pairs = []
  for (let i = 0; i < 4; i++) for (let j = i + 1; j < 4; j++) pairs.push(`${diff(r.cells[i], r.cells[j]).toFixed(1)}`)
  console.log(
    ` 底边散布 ${bottoms.length > 1 ? Math.max(...bottoms) - Math.min(...bottoms) : '-'}px` +
      ` · 盒宽极差 ${widths.length > 1 ? Math.max(...widths) - Math.min(...widths) : '-'}px` +
      ` · 两两差异 [${pairs.join(' ')}]%`,
  )
}
