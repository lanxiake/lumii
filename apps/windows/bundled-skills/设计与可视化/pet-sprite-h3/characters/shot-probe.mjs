#!/usr/bin/env node
/**
 * shot-probe —— 从 PetWindow 的截屏里找出「宠物在哪、多大、什么朝向」
 *
 * ## 为什么需要它
 *
 * 宠物窗口是全透明 + WebGL 的，`lumii-ui screenshot` 抓到全黑；`scripts/lumii-cdp.mjs shot`
 * 也得先垫上合成器底色（见那里的注释）。垫完底色之后，**从截图里找出宠物**这件事
 * 又成了一个独立问题：屏幕上还有 UI 浮层（实测左上角常驻一块 ~85×105 的提示条），
 * 而宠物在爬墙时只有 ~70×110、混在整幅 2560×1400 里。
 *
 * 所以这里按**二维连通块**找，并且按"形状像不像宠物"排序：
 * 爬墙时是**竖长**（高 > 宽），爬天花板时是**横扁**，走路时介于两者之间。
 * 单看像素数会把 UI 提示条排在前面。
 *
 * 用法：
 *   node shot-probe.mjs <png...> [--min 200]    每张图报一行
 */
import sharp from 'sharp'

const argv = process.argv.slice(2)
const opt = (n, d) => {
  const i = argv.indexOf(`--${n}`)
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d
}
const MIN_PX = Number(opt('min', 200))
const files = []
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === '--min') i++ // 它的值不是文件名
  else if (!argv[i].startsWith('--')) files.push(argv[i])
}

for (const f of files) {
  const { data, info } = await sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true })
  const { width: W, height: H, channels: ch } = info
  // 注入的合成器底色是 #f2f2f7；与它够远的像素才算"有东西"
  const ink = new Uint8Array(W * H)
  for (let i = 0; i < W * H; i++) {
    const r = data[i * ch]
    const g = data[i * ch + 1]
    const b = data[i * ch + 2]
    if (Math.abs(r - 242) + Math.abs(g - 242) + Math.abs(b - 247) > 24) ink[i] = 1
  }

  // 二维连通块（4 邻域，显式栈，避免 2560×1400 递归爆栈）
  const seen = new Uint8Array(W * H)
  const comps = []
  const stack = new Int32Array(W * H)
  for (let i = 0; i < W * H; i++) {
    if (!ink[i] || seen[i]) continue
    let sp = 0
    stack[sp++] = i
    seen[i] = 1
    let n = 0
    let x0 = W
    let x1 = -1
    let y0 = H
    let y1 = -1
    while (sp) {
      const p = stack[--sp]
      const x = p % W
      const y = (p - x) / W
      n++
      if (x < x0) x0 = x
      if (x > x1) x1 = x
      if (y < y0) y0 = y
      if (y > y1) y1 = y
      if (x > 0 && ink[p - 1] && !seen[p - 1]) (seen[p - 1] = 1), (stack[sp++] = p - 1)
      if (x < W - 1 && ink[p + 1] && !seen[p + 1]) (seen[p + 1] = 1), (stack[sp++] = p + 1)
      if (y > 0 && ink[p - W] && !seen[p - W]) (seen[p - W] = 1), (stack[sp++] = p - W)
      if (y < H - 1 && ink[p + W] && !seen[p + W]) (seen[p + W] = 1), (stack[sp++] = p + W)
    }
    if (n >= MIN_PX) comps.push({ n, x0, x1, y0, y1, w: x1 - x0 + 1, h: y1 - y0 + 1 })
  }
  // 「像宠物」= 高度在合理区间、且不是那块常驻浮层（浮层贴左上角、宽高比固定）
  const looksPet = (c) => c.h >= 40 && c.w >= 25 && c.w <= 260 && c.h <= 300
  comps.sort(
    (a, b) =>
      (looksPet(b) ? 1 : 0) - (looksPet(a) ? 1 : 0) || b.h * b.w - a.h * a.w,
  )
  const head = `${f.split(/[\\/]/).pop()}  ${W}x${H}  块=${comps.length}`
  if (!comps.length) {
    console.log(`${head}  （空）`)
    continue
  }
  console.log(
    `${head}\n` +
      comps
        .slice(0, 3)
        .map(
          (c) =>
            `    ${looksPet(c) ? '宠物?' : '其他 '} x[${c.x0},${c.x1}] y[${c.y0},${c.y1}]  ${c.w}x${c.h}  px=${c.n}`,
        )
        .join('\n'),
  )
}
