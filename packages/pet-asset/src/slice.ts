/**
 * slice — 网格切分（pet-asset）
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §3.2
 *
 * 用于把「直出图集」（模型一次生成的多姿态大图，如 2×2 四格）切成单帧。
 * **只做等分几何切分，不做内容识别**——模型怎么排的格子由调用方告诉我，
 * 猜格子的代码一旦猜错，错误会以「角色被切掉半张脸」的形式出现，比明说要难查得多。
 *
 * 除不尽时**余数全给最后一格**（而不是取整丢弃）：宁可最后一格宽几个像素，
 * 也不能把图右/下边缘的角色像素切没了。
 */

export interface SliceGridOptions {
  /** 列数 */
  cols?: number
  /** 行数 */
  rows?: number
  /** 或直接指定格宽（与 cols 二选一） */
  cellWidth?: number
  /** 或直接指定格高（与 rows 二选一） */
  cellHeight?: number
}

export interface SliceCell {
  /** 行优先的序号，从 0 起 */
  index: number
  row: number
  col: number
  x: number
  y: number
  w: number
  h: number
}

/**
 * 把矩形区域切成网格（纯函数）。
 *
 * @throws 参数不足或非法时抛错——静默返回空网格会让调用方以为"切出来是空的"
 */
export function planGrid(width: number, height: number, opts: SliceGridOptions): SliceCell[] {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error(`图尺寸非法：${width}×${height}`)
  }

  const cols = opts.cols ?? (opts.cellWidth ? Math.round(width / opts.cellWidth) : 0)
  const rows = opts.rows ?? (opts.cellHeight ? Math.round(height / opts.cellHeight) : 0)

  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols < 1 || rows < 1) {
    throw new Error(
      `切分参数非法：cols=${cols} rows=${rows}（需要正整数，或给出 cellWidth / cellHeight）`,
    )
  }
  if (cols > width || rows > height) {
    throw new Error(`切分参数过大：${cols}×${rows} 格切不出 ${width}×${height} 的图`)
  }

  // 除不尽时余数给最后一格：floor + 末格补差，保证覆盖整图不丢像素
  const baseW = Math.floor(width / cols)
  const baseH = Math.floor(height / rows)

  const cells: SliceCell[] = []
  let index = 0
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const x = col * baseW
      const y = row * baseH
      cells.push({
        index: index++,
        row,
        col,
        x,
        y,
        // 末列/末行吃掉余数
        w: col === cols - 1 ? width - x : baseW,
        h: row === rows - 1 ? height - y : baseH,
      })
    }
  }
  return cells
}
