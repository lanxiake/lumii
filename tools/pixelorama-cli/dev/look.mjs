// 把带 alpha 的图合成到白底再画 ASCII —— sheet-view.mjs 的判据是"比背景暗"，
// 直接喂透明图会因为它把透明像素当成"比背景暗"而画出一片实心。
// 这里先合成，让判据回到它适用的前提上。
import { createRequire } from 'node:module'
const sharp = createRequire('C:/myself/projects/my/open-source/lumii/package.json')('sharp')

const [file, colsArg] = process.argv.slice(2)
const CW = Number(colsArg ?? 72)

const { data, info } = await sharp(file)
  .flatten({ background: { r: 255, g: 255, b: 255 } })
  .greyscale()
  .raw()
  .toBuffer({ resolveWithObject: true })

const { width: W, height: H } = info
console.log(`${file}\n合成到白底后 ${W}×${H}`)
const CH = Math.max(1, Math.round(CW * (H / W) * 0.5))
const ramp = ' .:-=+*#%@'
let out = ''
for (let gy = 0; gy < CH; gy++) {
  let line = ''
  for (let gx = 0; gx < CW; gx++) {
    const x0 = Math.floor((gx * W) / CW), x1 = Math.max(x0 + 1, Math.floor(((gx + 1) * W) / CW))
    const y0 = Math.floor((gy * H) / CH), y1 = Math.max(y0 + 1, Math.floor(((gy + 1) * H) / CH))
    let sum = 0, n = 0
    for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { sum += data[y * W + x]; n++ }
    const v = n ? sum / n : 255
    line += ramp[Math.min(9, Math.max(0, Math.round((255 - v) / 25.6)))]
  }
  out += line + '\n'
}
console.log(out)
