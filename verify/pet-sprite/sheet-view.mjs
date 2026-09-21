import { createRequire } from 'node:module'
const sharp = createRequire('C:/myself/projects/my/open-source/lumii/package.json')('sharp')

const [file, colsArg, crop] = process.argv.slice(2)
const CW = Number(colsArg ?? 100)

let img = sharp(file)
if (crop) {
  const [l, t, w, h] = crop.split(',').map(Number)
  img = img.extract({ left: l, top: t, width: w, height: h })
}
const meta = await sharp(file).metadata()
const { data, info } = await img.ensureAlpha().raw().toBuffer({ resolveWithObject: true })
const { width: W, height: H, channels: C } = info

// 背景色：整幅最外一圈的逐通道中位数（同 cells-quality 的取法）
const rs = [], gs = [], bs = []
for (let y = 0; y < H; y++) {
  for (let x = 0; x < W; x++) {
    if (x >= 3 && y >= 3 && x < W - 3 && y < H - 3) continue
    const o = (y * W + x) * C
    rs.push(data[o]); gs.push(data[o + 1]); bs.push(data[o + 2])
  }
}
const med = (a) => { a.sort((p, q) => p - q); return a[a.length >> 1] }
const bg = [med(rs), med(gs), med(bs)]

// 内容 = 与背景差得远**且比背景暗**（只画深色，浅噪点不算）
const isInk = (o) => {
  const d = Math.abs(data[o] - bg[0]) + Math.abs(data[o + 1] - bg[1]) + Math.abs(data[o + 2] - bg[2])
  return d > 90 && (data[o] + data[o + 1] + data[o + 2]) / 3 < (bg[0] + bg[1] + bg[2]) / 3 - 10
}

console.log(`${file}\n原图 ${meta.width}×${meta.height}${crop ? `  显示区 ${W}×${H}` : ''}  背景 rgb(${bg})`)
const CH = Math.max(1, Math.round((CW * (H / W)) * 0.5))
const ramp = ' .:-=+*#%@'
let out = ''
for (let gy = 0; gy < CH; gy++) {
  let line = ''
  for (let gx = 0; gx < CW; gx++) {
    const x0 = Math.floor((gx * W) / CW), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * W) / CW))
    const y0 = Math.floor((gy * H) / CH), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * H) / CH))
    let sum = 0, n = 0
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) { sum += isInk((y * W + x) * C) ? 1 : 0; n++ }
    }
    const v = n ? sum / n : 0
    line += v < 0.12 ? ' ' : ramp[Math.min(9, 1 + Math.floor(v * 9))]
  }
  out += line + '\n'
}
console.log(out)
