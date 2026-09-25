/**
 * detached-blobs.mjs — **抠底之后**的碎块拦截（用在精灵表产出之后、装包之前）
 *
 * ## 为什么必须放在抠底之后
 *
 * 碎块有两个来源，只有一个能在机位图阶段拦住：
 *
 * 1. **机位图自带的渣** —— 首帧上本来就有的小连通块。`stage-frame.mjs` 的
 *    `--drop-debris` 拦的是这类，实测有效（渣表首格 5 块 → 干净图首格 0 块）。
 * 2. **视频里长出来的渣** —— 角色移动时把身后的地方让出来，模型把那块**重新画**
 *    了一遍，画出来的底色跟精确底色对不上，色键抠不掉。这类**只长在中间格**
 *    （首末格等于机位图本身，所以那两格干净）。机位图再干净也挡不住它长出来。
 *
 * 判据因此必须作用在**抠完底的帧**上。机位图那道防线留着，这里补第二道。
 *
 * ## 三档分法（用户定的口径）
 *
 *   · **大块（≥ bigArea）＝ 本体级**：脚下的云、断开的水袖都是真东西，
 *     永不删除，也不参与"碎块"判定（它们自己就是参照物）。
 *   · **中块（smallArea ~ bigArea）**：保留，但**报出来**让人看一眼。
 *   · **小块（< smallArea）且离本体 > minGap 像素**：抹掉。
 *     "离本体"用**像素距离**，不能用包围盒间距——实测花瓣飘在她躯干正前方时
 *     包围盒间距是 0，按包围盒判等于漏掉绝大多数（walk 表 102 个非本体块里
 *     96 个 gap=0）。
 *   · 紧贴本体（≤ minGap 像素）的小块一律保留：它在轮廓上，删了会啃边。
 *
 * 连通判定 8 邻域 + alpha 阈值（默认 40：半透明边缘晕不算块）。
 */

/** 8 邻域连通块标注 */
export function labelComponents(alpha, w, h, alphaThreshold = 40) {
  const N = w * h
  const labels = new Int32Array(N).fill(-1)
  const areas = []
  const stack = new Int32Array(N)
  for (let start = 0; start < N; start++) {
    if (labels[start] !== -1 || alpha[start] <= alphaThreshold) continue
    const id = areas.length
    let sp = 0, n = 0
    stack[sp++] = start
    labels[start] = id
    while (sp > 0) {
      const p = stack[--sp]
      n++
      const x = p % w, y = (p - x) / w
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy
        if (yy < 0 || yy >= h) continue
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx
          if (xx < 0 || xx >= w) continue
          const q = yy * w + xx
          if (labels[q] === -1 && alpha[q] > alphaThreshold) { labels[q] = id; stack[sp++] = q }
        }
      }
    }
    areas.push(n)
  }
  return { labels, areas }
}

/** 每个连通块的包围盒 + 面积 */
export function componentBoxes(labels, areas, w, h) {
  const boxes = areas.map(() => ({ minX: Infinity, minY: Infinity, maxX: -1, maxY: -1, area: 0 }))
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const id = labels[y * w + x]
      if (id < 0) continue
      const b = boxes[id]
      if (x < b.minX) b.minX = x
      if (x > b.maxX) b.maxX = x
      if (y < b.minY) b.minY = y
      if (y > b.maxY) b.maxY = y
      b.area++
    }
  }
  return boxes.map((b) => ({
    ...b, w: b.maxX - b.minX + 1, h: b.maxY - b.minY + 1,
    cx: Math.round((b.minX + b.maxX) / 2), cy: Math.round((b.minY + b.maxY) / 2),
  }))
}

/**
 * 拦一道：小且离本体远的块抹成透明，其余保留（中块回报）。
 *
 * @param {Buffer} rgba sharp 的 RGBA 缓冲（**就地**改 alpha）
 * @param {object} o { smallArea=420, bigArea=1500, minGap=6, alphaThreshold=40 }
 * @returns {{ bodies: object[], dropped: object[], kept: object[] }}
 *   bodies=本体级大块；dropped=已抹掉；kept=保留的中块（**调用方要打印**）
 */
export function dropDetachedBlobs(
  rgba, w, h,
  { smallArea = 420, bigArea = 1500, minGap = 6, alphaThreshold = 40 } = {},
) {
  const N = w * h
  const alpha = Buffer.allocUnsafe(N)
  for (let i = 0; i < N; i++) alpha[i] = rgba[i * 4 + 3]
  const { labels, areas } = labelComponents(alpha, w, h, alphaThreshold)
  if (!areas.length) return { bodies: [], dropped: [], kept: [] }
  const boxes = componentBoxes(labels, areas, w, h)

  // 参照物 = 所有本体级大块（角色可能本身是好几块：身子 + 脚下的云 + 断开的水袖）
  let bodies = boxes.filter((b) => b.area >= bigArea)
  if (!bodies.length) bodies = [boxes.reduce((a, b) => (b.area > a.area ? b : a), boxes[0])]
  const bodyIds = new Set(bodies.map((b) => boxes.indexOf(b)))

  // 参照物膨胀 minGap 的掩膜：落进去的小块算"贴在她身上"，不删
  const near = new Uint8Array(N)
  const dq = []
  for (let p = 0; p < N; p++) if (labels[p] >= 0 && bodyIds.has(labels[p])) { near[p] = 1; dq.push(p) }
  for (let head = 0; head < dq.length; head++) {
    const p = dq[head]
    const d = near[p]
    if (d >= minGap) continue
    const x = p % w, y = (p - x) / w
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy
      if (yy < 0 || yy >= h) continue
      for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx
        if (xx < 0 || xx >= w) continue
        const q = yy * w + xx
        if (near[q] === 0) { near[q] = d + 1; dq.push(q) }
      }
    }
  }

  const dropped = [], kept = []
  for (let i = 0; i < boxes.length; i++) {
    if (bodyIds.has(i)) continue
    const b = boxes[i]
    // 该块是否有任何像素落在膨胀掩膜里（=贴着本体）
    let touches = false
    if (b.area < smallArea) {
      for (let y = b.minY; y <= b.maxY && !touches; y++) {
        for (let x = b.minX; x <= b.maxX; x++) {
          if (labels[y * w + x] === i && near[y * w + x] > 0) { touches = true; break }
        }
      }
    }
    if (b.area < smallArea && !touches) {
      const e = { ...b, nearBody: false }
      dropped.push(e)
      for (let p = 0; p < N; p++) if (labels[p] === i) rgba[p * 4 + 3] = 0
    } else {
      kept.push({ ...b, nearBody: touches })
    }
  }
  dropped.sort((a, b) => b.area - a.area)
  kept.sort((a, b) => b.area - a.area)
  return { bodies, dropped, kept }
}
