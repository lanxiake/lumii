import { createRequire } from 'node:module'
const sharp = createRequire('C:/myself/projects/my/open-source/lumii/package.json')('sharp')

const D = 60

/**
 * 一格的统计。
 *
 * **背景色逐格自测**，不假定它是 `#00ffff`——实测三只历史产物里只有一只真是那个色，
 * 另外两只一张偏青绿、一张整张紫底。按声明的色去判，会把整张图都算成"内容"。
 *
 * 而"自测"要**取最外一圈的中位数**，不能取四角：
 * AI 画的底色带噪点，四个角能取到四个互不相同的值（实测 `refwalk-n` 的格 1 四角是
 * `(40,238,239) (4,252,253) (68,224,223) (38,240,239)`），而"多数派"在四值各一票时
 * 退化成"第一个"，于是拿到 `(40,238,239)`——它与真背景差 64，越过 60 的阈值，
 * **整格被算成内容**（报出 95.4%、包围盒 512×512，看着像"AI 把格子画糊了"）。
 * 判据错的时候，它给出的结论和真故障长得一模一样。
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
    // 背景色：该格最外 3px 一圈像素的逐通道中位数
    const rs = []
    const gs = []
    const bs = []
    for (let y = 0; y < chh; y++) {
      for (let x = 0; x < cw; x++) {
        if (x >= 3 && y >= 3 && x < cw - 3 && y < chh - 3) continue
        const [r, g, b] = at(x, y)
        rs.push(r); gs.push(g); bs.push(b)
      }
    }
    const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1] }
    const bg = [med(rs), med(gs), med(bs)]

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
    // 越界 = 内容碰到格子的**左/右/上**边界。**底边不算**——脚本来就该踩在底边上
    // （提示词要求"四格脚踩同一条水平线"）。第一版把四条边一起判，两组全部报警，
    // 连四格都规规矩矩的那组也没躲过。
    //
    // 这条判据是别的指标替不了的：越界时四格的包围盒都是整格，于是"盒宽极差"反而
    // 变成 0（看着最齐），内容占比也正常（猫只占 27%）。实测对照组四只猫撑破了格子、
    // 左右两格连成一片，三个数字全都正常，只有这一条报得出来。
    const edge = b ? (b.x0 <= 1 || b.y0 <= 1 || b.x1 >= c.w - 2 ? ' ⚠越界' : '') : ''
    console.log(
      ` 格${i}  内容 ${pct.padStart(5)}%  底 ${String(b ? b.y1 : '-').padStart(3)}  盒 ${b ? `${b.w}×${b.h}` : '空'}`.padEnd(42) +
        `  背景 rgb(${c.bg})  角色均色 rgb(${c.avg})${edge}`,
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
