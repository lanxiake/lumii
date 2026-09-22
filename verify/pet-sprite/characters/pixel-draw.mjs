#!/usr/bin/env node
/**
 * pixel-draw.mjs — 像素画的极简绘图 DSL（给「重绘基准帧」用）
 *
 * ## 为什么不用手写网格
 *
 * 64×64 是 4096 个格子。手写要一列一列数，改一个参数就得重数一遍，而且
 * 错一位看不出——ASCII 预览只有几十列，1 像素的错位在预览里正好被平均掉。
 * 这里改成**用坐标声明形状**，画完再摊成网格：调参只需改数字。
 *
 * ## 描边交给 outline()，不手画
 *
 * 像素画的描边一致性最容易崩：这里粗一像素那里断一格，缩略图上看不出来，
 * 放大就露馅。`outline()` 对整块不透明区域做一次形态学膨胀取外壳，
 * **数学上保证处处 1 像素**。这是手工描边做不到的。
 *
 * ## 上色顺序（重要）
 *
 * 先画**纯形状**（统一用一个占位字符），`outline()` 包边，再用 `flood()`
 * 往各个连通区里灌颜色。顺序反过来的话，描边会把区域切碎、灌色会漏出去。
 * `flood()` 是 4 连通的，遇到任何非占位字符就停——所以描边天然是边界。
 *
 * 用法：见文件末尾的 `designCat()`，或 import 后自己搭。
 */

export const PAL = {
  1: '2b2118', // 描边（深棕黑，比纯黑柔和）
  2: 'f5a623', // 橘 · 主色
  3: 'd97b06', // 橘 · 暗部
  4: 'fdfcfa', // 白 · 主色
  5: 'ded8ce', // 白 · 暗部
  6: 'f6a8a8', // 粉（耳内、鼻）
  7: 'ffffff', // 高光（眼睛反光）
}

export class Grid {
  constructor(W, H, fill = '.') {
    this.W = W
    this.H = H
    this.g = Array.from({ length: H }, () => Array(W).fill(fill))
  }
  at(x, y) {
    return x >= 0 && x < this.W && y >= 0 && y < this.H ? this.g[y][x] : null
  }
  set(x, y, ch) {
    if (x >= 0 && x < this.W && y >= 0 && y < this.H) this.g[y][x] = ch
    return this
  }
  /** 只在 `only` 指定的字符上落笔（默认只落在背景上），用来叠加而不摧毁已有内容 */
  ellipse(cx, cy, rx, ry, ch, only = '.') {
    for (let y = Math.floor(cy - ry); y <= Math.ceil(cy + ry); y++) {
      for (let x = Math.floor(cx - rx); x <= Math.ceil(cx + rx); x++) {
        const dx = (x - cx) / rx
        const dy = (y - cy) / ry
        if (dx * dx + dy * dy <= 1) {
          if (only === null || this.at(x, y) === only) this.set(x, y, ch)
        }
      }
    }
    return this
  }
  triangle(p1, p2, p3, ch, only = '.') {
    const minX = Math.min(p1.x, p2.x, p3.x)
    const maxX = Math.max(p1.x, p2.x, p3.x)
    const minY = Math.min(p1.y, p2.y, p3.y)
    const maxY = Math.max(p1.y, p2.y, p3.y)
    const sign = (a, b, c) => (a.x - c.x) * (b.y - c.y) - (b.x - c.x) * (a.y - c.y)
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        const p = { x, y }
        const d1 = sign(p, p1, p2)
        const d2 = sign(p, p2, p3)
        const d3 = sign(p, p3, p1)
        const neg = d1 < 0 || d2 < 0 || d3 < 0
        const pos = d1 > 0 || d2 > 0 || d3 > 0
        if (!(neg && pos) && (only === null || this.at(x, y) === only)) this.set(x, y, ch)
      }
    }
    return this
  }
  rect(x0, y0, x1, y1, ch, only = '.') {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        if (only === null || this.at(x, y) === only) this.set(x, y, ch)
      }
    }
    return this
  }
  /** 4 连通灌色：撞见任何不是 `from` 的字符就停 */
  flood(x, y, ch, from = null) {
    const start = this.at(x, y)
    if (start === null || start === ch) return this
    if (from !== null && start !== from) return this
    const stack = [[x, y]]
    const seen = new Set()
    while (stack.length) {
      const [cx, cy] = stack.pop()
      const key = cy * this.W + cx
      if (seen.has(key)) continue
      seen.add(key)
      if (this.at(cx, cy) !== start) continue
      this.set(cx, cy, ch)
      stack.push([cx + 1, cy], [cx - 1, cy], [cx, cy + 1], [cx, cy - 1])
    }
    return this
  }
  /**
   * 给所有不透明区域包 1 像素外壳。
   * 只往**外面**长（不改已有像素），所以画好的形状一根毛都不会动。
   *
   * ⚠ 判定"是不是实体"必须走 `solid()`：`at()` 越界返回 `null`，而
   * `null !== '.'` 是真——直接把 `this.at(x-1,y) !== '.'` 当条件的话，
   * **画布外的虚空会被当成实体**，于是整圈边缘像素都被判为"挨着内容"，
   * 给图片加了一像素的边框（实测行 0/63、列 0/63 全被涂黑）。
   */
  outline(ch) {
    const solid = (x, y) => {
      const c = this.at(x, y)
      return c !== null && c !== '.'
    }
    const add = []
    for (let y = 0; y < this.H; y++) {
      for (let x = 0; x < this.W; x++) {
        if (this.at(x, y) !== '.') continue
        const n = solid(x - 1, y) || solid(x + 1, y) || solid(x, y - 1) || solid(x, y + 1)
        if (n) add.push([x, y])
      }
    }
    for (const [x, y] of add) this.set(x, y, ch)
    return this
  }
  /** 擦掉一个矩形（放回背景），用来修剪画过头的地方 */
  erase(x0, y0, x1, y1) {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) this.set(x, y, '.')
    return this
  }
  toString() {
    return this.g.map((r) => r.join('')).join('\n')
  }
  /** 转成 pixel-grid 的文本格式（含 size/palette 头），可直接喂给 pixel-grid/pixel-anim */
  toGridText() {
    // ⚠ 索引 0 必须留个占位色：pixel-grid 按 `DIGITS.indexOf(c)` 取色，字符 '1' 落到
    // palette 的第 **1** 项。不垫这一格的话，整张图会串色一档——而串色后的图
    // 看上去仍然"是只猫"，只是配色怪，很容易当成"调色板没选好"查半天。
    const keys = Object.keys(PAL).sort()
    const palette = ['000000', ...keys.map((k) => PAL[k])]
    const head = [`size ${this.W} ${this.H}`, `palette ${palette.join(' ')}`]
    const rows = this.g.map((r) => r.join('').replace(/\.+$/, ''))
    return head.concat(rows).join('\n') + '\n'
  }
}
