/**
 * A2UI MathVisualizer 组件 — 使用 mafs 渲染数学函数图像
 */

import React, { useMemo } from 'react'
import { Mafs, Coordinates, Plot } from 'mafs'
import 'mafs/core.css'
import type { A2UIMathVisualizer } from './types'
import styles from './A2UIRenderer.module.css'

/**
 * 安全地将数学表达式字符串转为函数
 *
 * 支持格式：
 * - "y=x^2" / "x^2" → (x) => x**2
 * - "y=sin(x)" / "sin(x)" → (x) => Math.sin(x)
 * - "y=2*x+1" → (x) => 2*x+1
 */
function parseExpression(expr: string): ((x: number) => number) | null {
  try {
    // 去掉 "y=" 前缀
    let fn = expr.replace(/^y\s*=\s*/i, '').trim()

    // 替换常见数学函数为 Math.*
    fn = fn.replace(/\bsin\b/g, 'Math.sin')
    fn = fn.replace(/\bcos\b/g, 'Math.cos')
    fn = fn.replace(/\btan\b/g, 'Math.tan')
    fn = fn.replace(/\babs\b/g, 'Math.abs')
    fn = fn.replace(/\bsqrt\b/g, 'Math.sqrt')
    fn = fn.replace(/\blog\b/g, 'Math.log')
    fn = fn.replace(/\bexp\b/g, 'Math.exp')
    fn = fn.replace(/\bPI\b/gi, 'Math.PI')
    fn = fn.replace(/\bpi\b/g, 'Math.PI')
    fn = fn.replace(/\be\b/g, 'Math.E')

    // 替换 ^ 为 **（幂运算）
    fn = fn.replace(/\^/g, '**')

    // 补全隐式乘法：数字紧跟变量/函数，如 2x → 2*x, 2Math → 2*Math
    fn = fn.replace(/(\d)(x\b|Math\.)/g, '$1*$2')
    fn = fn.replace(/(\d)\(([^)]*)\)/g, '$1*($2)')

    // 使用 Function 构造函数创建数学函数
    // eslint-disable-next-line no-new-func
    const mathFn = new Function('x', `"use strict"; return (${fn});`) as (x: number) => number

    // 验证：调用一次确保不会抛出异常
    const testResult = mathFn(1)
    if (typeof testResult !== 'number' || !Number.isFinite(testResult)) {
      // 对于 tan(pi/2) 等特殊值允许 Infinity，但 NaN 不行
      if (Number.isNaN(testResult)) return null
    }

    return mathFn
  } catch {
    return null
  }
}

export const MathVisualizerComponent: React.FC<A2UIMathVisualizer> = ({ expression, range }) => {
  const fn = useMemo(() => parseExpression(expression), [expression])

  const xMin = range?.xMin ?? -5
  const xMax = range?.xMax ?? 5
  const yMin = range?.yMin ?? -5
  const yMax = range?.yMax ?? 5

  if (!fn) {
    return (
      <div className={styles['a2ui-fallback']}>
        无法解析数学表达式: {expression}
      </div>
    )
  }

  return (
    <div className={styles['a2ui-math']}>
      <div className={styles['a2ui-math-label']}>{expression}</div>
      <Mafs
        viewBox={{ x: [xMin, xMax], y: [yMin, yMax] }}
        preserveAspectRatio={false}
        height={250}
      >
        <Coordinates.Cartesian />
        <Plot.OfX y={fn} color="#6366f1" />
      </Mafs>
    </div>
  )
}
