/**
 * HTML 渲染后端：分镜 → 自包含 HTML → 逐帧截图 → ffmpeg 合成 MP4。
 *
 * 为什么不用 Manim：Manim 需要 Python + OpenGL 栈（moderngl/pyglet/pycairo），
 * 在 Windows 无 GPU 机器上是最经典的安装故障源，而本应用的嵌入式 Python 连 venv
 * 都没有（实测 `No module named venv`）。走 HTML 的好处是**零新增依赖**：
 * 渲染用已有的 playwright-core（浏览器截图同源），合成用已有的 ffmpeg 封装。
 *
 * 代价：没有 LaTeX 数学排版。需要公式时用 HTML/CSS 近似——这是有意识的取舍，
 * 不是能力缺失。真需要 Manim 级排版的用户走 `manim` 后端（插件设置里选）。
 */

import fs from 'node:fs'
import path from 'node:path'

import katex from 'katex'

import type { StoryboardSection, TeachingStoryboard } from './teaching-core'
import {
  checkSceneLayout,
  clampLectureLine,
  findOverlaps,
  type Box,
  type LayoutIssue,
  type Point,
  type SceneElement,
  type SceneStep,
} from './teaching-core'
import { DEFAULT_STYLE } from './styles/registry'
import type { StyleTheme, VisualStyle } from './styles/types'
import { checkFrame, type FrameIssue, type FrameStats } from './gates/frame-check'
import { cuesToSrt, type Cue } from './gates/narrate'
export type { VisualStyle, StyleTheme } from './styles/types'

/** 画面尺寸（固定，ffmpeg 要求同尺寸才能 concat） */
export const FRAME = { width: 1280, height: 720 } as const

/** 每步动画的默认时长（秒）；模型给的自描述里没有时长，按步数均分 */
const STEP_SECONDS = 3

/** 左侧讲义区宽度占画面的比例 */
const LECTURE_RATIO = 0.3

/**
 * 右侧动画区的像素尺寸。
 *
 * SVG 元素（数轴、箭头、曲线）必须按**像素**画，不能按百分比坐标画再用
 * `preserveAspectRatio="none"` 拉伸——后者 x/y 比例尺不同，会把文字压扁、
 * 让刻度压到轴线上。所以各处 SVG 都按这个尺寸换算。
 */
const STAGE_PX = {
  width: FRAME.width * (1 - LECTURE_RATIO),
  height: FRAME.height,
} as const

/**
 * 由**结构化画面描述**生成 HTML。
 *
 * ## 元素身份 = 动画
 *
 * 同一个 `id` 在多个步出现 = **同一个对象在动**。渲染时只创建一次 DOM 元素，
 * 每步通过 CSS transition 改 `left/top/width/height/color` —— 观众看到的是
 * 一个东西在移动、变大、变色，而不是「消失再出现」。
 *
 * 这是「动画」与「幻灯片」的分界线。没有 id 时每步只能重画，五个静态画面
 * 拼起来不叫讲解；有 id 时同一个三角形可以滑过去、翻过来、被拆开。
 *
 * 上一版只累积不消失，第 1 步的图形一直堆到第 4 步，和公式撞在一起
 * （实测 `pythagoras-three-proofs` 第 1 节整屏重叠）。
 */
export function buildSceneHtml(
  section: StoryboardSection,
  scene: SceneStep[],
  theme: StyleTheme = DEFAULT_STYLE.theme,
): string {
  const lines = section.lectureLines.map((l) => clampLectureLine(l))
  const secs = sectionSeconds(section)
  // 有时间轴（配音给的）就按它算每步的起止，否则均分
  const stepStarts = stepStartMs(section, scene.length)

  // 编号样式：数字用 1/2/3，圆点用 ·——后者更接近「白板笔记」而不是「步骤清单」
  const lectureHtml = lines
    .map((line, i) => {
      const bullet = theme.bulletStyle === 'dot' ? '·' : String(i + 1)
      return `<li class="line" data-line="${i}"><span class="idx">${bullet}</span><span class="txt">${escapeHtml(line)}</span></li>`
    })
    .join('\n')

  // ---- 按 id 归拢：同一 id 的多次出现是同一个对象的状态序列 ----
  interface Keyframe {
    step: number
    el: SceneElement
  }
  const byId = new Map<string, Keyframe[]>()
  scene.forEach((step, si) => {
    step.elements.forEach((el, ei) => {
      const id = el.id ?? `s${si}e${ei}`
      const list = byId.get(id) ?? []
      // 同一步重复出现同 id：后一个覆盖前一个（模型偶尔这么写）
      const existing = list.findIndex((k) => k.step === si)
      if (existing >= 0) list[existing] = { step: si, el }
      else list.push({ step: si, el })
      byId.set(id, list)
    })
  })

  const elements: string[] = []
  // 关键帧数据单独放一个 JSON 块：HTML 属性里的引号会被解析器吃掉
  // （`data-kf="[{"at":0}]"` 到 DOM 里就剩 `[{"`），塞进 <script type="application/json"> 最稳
  const kfData: Record<string, Array<{ at: number; h: string; s: Record<string, string> }>> = {}
  for (const [id, frames] of byId) {
    frames.sort((a, b) => a.step - b.step)
    const first = frames[0]!
    const kfs = frames.map((f) => ({
      at: stepStarts[f.step] ?? 0,
      h: renderElement(f.el, `${id}_${f.step}`),
      s: {
        left: `${f.el.x ?? 30}%`,
        top: `${f.el.y ?? 40}%`,
        width: `${f.el.w ?? 24}%`,
        height: `${f.el.h ?? 14}%`,
        ...(f.el.color ? { '--c': f.el.color } : {}),
      },
    }))
    kfData[id] = kfs
    // 消失时刻：until 指的步结束后
    const lastFrame = frames[frames.length - 1]!
    const untilStep = lastFrame.el.until
    const hideAt =
      untilStep !== undefined
        ? (stepStarts[Math.min(untilStep + 1, scene.length)] ?? secs * 1000)
        : null
    const body = renderElement(first.el, `${id}_init`)
    const initStyle = Object.entries({
      left: `${first.el.x ?? 30}%`,
      top: `${first.el.y ?? 40}%`,
      width: `${first.el.w ?? 24}%`,
      height: `${first.el.h ?? 14}%`,
      ...(first.el.color ? { '--c': first.el.color } : {}),
    })
      .map(([k, v]) => `${k}:${v}`)
      .join(';')
    elements.push(
      `<div class="el el-${first.el.kind}${first.el.kind === 'highlight' && first.el.content ? ' has-label' : ''}" data-el="${escapeAttr(id)}"${
        hideAt !== null ? ` data-hide="${hideAt}"` : ''
      // 初始 opacity 交给 CSS 的 `.el{opacity:0}`，**不要写进内联 style**：
      // 内联样式的优先级高于类选择器，`.el.on{opacity:1}` 会被它压住，
      // 元素永远不显示（实测整屏只有左侧讲义，右侧全空）
      } style="${initStyle}">${body}</div>`,
    )
  }

  const timeline: string[] = []
  scene.forEach((step, si) => {
    timeline.push(`{ at: ${stepStarts[si] ?? 0}, step: ${si} }`)
  })

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(section.title)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${FRAME.width}px;height:${FRAME.height}px;overflow:hidden}
  body{background:${theme.bg};color:${theme.text};display:flex;
    font-family:${theme.fontFamily};
    background-image:${theme.texture || 'none'};
    background-size:${theme.texture.includes('linear-gradient') ? '24px 24px' : '7px 7px'}}
  #lecture{width:${LECTURE_RATIO * 100}%;padding:44px 22px 44px 36px;
    border-right:1px solid ${theme.divider};
    background:${theme.lectureBg}}
  #title{font-size:${theme.titleSize}px;font-weight:600;color:${theme.title};line-height:1.35;
    margin-bottom:18px;
    /* 标题同样单行：换行会把第一行讲义挤下去（实测「第三次握手：补齐客户端的确认」折了两行） */
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  ul{list-style:none;display:flex;flex-direction:column;gap:20px}
  .line{display:flex;gap:11px;font-size:${theme.lectureSize}px;line-height:1.5;color:${theme.muted};
    transition:color 420ms ease,text-shadow 420ms ease}
  /* 讲义**必须单行**：换行会挤掉下面几行、破坏左侧的阅读节奏（实测 TCP 那节
     「客户端回 ACK：收到服务器序号」换行后与第 3 行贴在一起）。字符数截断在
     中英混排下不可靠，交给 CSS 按实际宽度省略。 */
  .line .txt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .line .idx{flex:0 0 auto}

  .line.active{color:${theme.text};text-shadow:${theme.glow}}
  .line.active .txt{color:${theme.accent}}
  .idx{flex:0 0 26px;height:26px;border-radius:${theme.radius > 4 ? '50%' : '4px'};
    background:${theme.muted}33;color:${theme.muted};
    font-size:14px;display:flex;align-items:center;justify-content:center}
  .line.active .idx{background:${theme.accent};color:${theme.bg}}
  #stage{position:relative;flex:1}
  .el{position:absolute;opacity:0;transition:opacity 420ms ease,transform 420ms ease;
    transform:translateY(8px)}
  .el.on{opacity:1;transform:translateY(0)}
  .el-text,.el-formula{display:flex;align-items:center;justify-content:center;
    font-size:${theme.elementSize}px;color:var(--c,${theme.element});text-align:center;line-height:1.3}
  .el-formula{font-size:${Math.round(theme.elementSize * 1.23)}px;font-style:italic;letter-spacing:1px}
  .el-rect{background:transparent;border:${theme.strokeWidth}px solid var(--c,${theme.element});
    border-radius:${theme.radius}px}
  .el-circle{border:${theme.strokeWidth}px solid var(--c,${theme.element});border-radius:50%}
  .el-line{height:0 !important;border-top:${theme.strokeWidth}px solid var(--c,${theme.element})}
  .el-highlight{background:var(--c,${theme.accent});opacity:.14;border-radius:${theme.radius}px;
    filter:blur(2px);box-shadow:0 0 0 2px var(--c,${theme.accent}) inset}
  /* 带标签的高亮：文字要压在模糊层之上，所以单独一个伪元素做底色 */
  .el-highlight.has-label{display:flex;align-items:center;justify-content:center;
    background:transparent;filter:none;box-shadow:none}
  .el-highlight.has-label::before{content:'';position:absolute;inset:0;
    background:var(--c,${theme.accent});opacity:.14;border-radius:${theme.radius}px;
    filter:blur(2px);box-shadow:0 0 0 2px var(--c,${theme.accent}) inset}
  .el-highlight.has-label > .hl-label{position:relative;font-size:${theme.elementSize}px;
    color:var(--c,${theme.accent});font-weight:600;text-align:center;line-height:1.3}
  /* 数轴/曲线/箭头/括号都是内联 SVG，各自带像素宽高。
     **不能再写 width:100% / inset:0**：那会把 SVG 拉伸到盒子里，
     与 SVG 内部的像素坐标打架（实测刻度数字被压到轴线上）。 */
  .el-axis,.el-curve,.el-arrow,.el-brace{display:block;overflow:visible}
  .axis-svg,.curve-svg,.arrow-svg,.brace-svg{display:block;overflow:visible}
  .el-table{display:flex;align-items:center;justify-content:center}
  .tbl{border-collapse:collapse;font-size:${theme.elementSize - 7}px;color:${theme.text}}
  .tbl th{padding:6px 14px;color:${theme.accent};font-weight:600;
    border-bottom:2px solid ${theme.divider};white-space:nowrap}
  .tbl td{padding:5px 14px;text-align:center;white-space:nowrap;
    border-bottom:1px solid ${theme.divider}}
  .tbl tr.hl td{background:${theme.accent}22;color:${theme.accent}}
  .el-code{display:flex;flex-direction:column}
  .clang{font-size:13px;color:${theme.muted};letter-spacing:1px;margin-bottom:5px;
    text-transform:uppercase}
  .code{font-family:"Cascadia Mono",Consolas,monospace;font-size:${theme.elementSize - 9}px;
    line-height:1.55;color:${theme.text};white-space:pre;margin:0}
  .cl{padding:0 8px;border-left:3px solid transparent}
  .cl.hl{background:${theme.accent}22;border-left-color:${theme.accent};color:${theme.accent}}
  .el-tex{display:flex;align-items:center;justify-content:center}
  .el-tex math{font-size:${theme.texSize}px;color:var(--c,${theme.text})}
  .tex-fallback{font-family:Consolas,monospace;font-size:20px;color:#fca5a5}
</style></head><body>
<div id="lecture"><div id="title">${escapeHtml(section.title)}</div><ul>${lectureHtml}</ul></div>
<div id="stage">${elements.join('')}</div>
<script type="application/json" id="kf">${JSON.stringify(kfData).replace(/</g, '\\u003c')}</script>
<script>
var KF=JSON.parse(document.getElementById('kf').textContent);
var T=[${timeline.join(',')}];
window.__seek=function(ms){
  var a=-1;for(var i=0;i<T.length;i++)if(ms>=T[i].at)a=T[i].step;
  document.querySelectorAll('.el').forEach(function(e){
    var kf=KF[e.dataset.el];
    if(!kf||!kf.length)return;
    var hide=e.dataset.hide?Number(e.dataset.hide):Infinity;
    // 还没到首帧 或 已过消失时刻 → 隐藏
    if(ms<kf[0].at||ms>=hide){e.classList.remove('on');return;}
    // 找到当前所处的帧段
    var k=0;for(var i=0;i<kf.length;i++)if(ms>=kf[i].at)k=i;
    var cur=kf[k];
    // 套用这一帧的样式（CSS transition 负责补间，于是同一个对象"移动"而不是"跳变"）
    Object.keys(cur.s).forEach(function(p){
      if(p==='--c')e.style.setProperty('--c',cur.s[p]);
      else e.style[p]=cur.s[p];
    });
    // 内容随帧更新（同一个 id 的文字可能在后续步变了）
    if(cur.h!==undefined&&e.innerHTML!==cur.h){e.innerHTML=cur.h;}
    e.classList.add('on');
  });
  document.querySelectorAll('.line').forEach(function(e,i){
    e.classList.toggle('active', i===a);
    e.classList.toggle('done', i<a);
  });
  return a;
};
window.__totalMs=${Math.round(secs * 1000)};
window.__seek(0);
</script></body></html>`
}

/**
 * 把一个元素渲染成 HTML 片段。
 *
 * 复杂图形（数轴、表格、曲线、箭头）都在这里用内联 SVG 画：SVG 能表达
 * 绝对定位的线条与文字，且不依赖任何外部库，`capturePage` 照常能截。
 */
function renderElement(el: SceneElement, key: string): string {
  switch (el.kind) {
    case 'text':
      return escapeHtml(el.content ?? '')
    case 'formula':
      return `<span class="formula">${escapeHtml(el.content ?? '')}</span>`
    case 'tex':
      return renderTex(el.tex ?? '')
    case 'rect':
    case 'circle':
    case 'line':
      // 形状靠 CSS 的 .el-<kind> 类画（背景/边框），这里不需要内容
      return ''
    case 'axis':
      return renderAxis(el)
    case 'table':
      return renderTable(el)
    case 'curve':
      return renderCurve(el)
    case 'code':
      return renderCode(el)
    case 'arrow':
      return renderArrow(el)
    case 'brace':
      return renderBrace(el)
    case 'highlight':
      // 有 content 就渲染成「带标签的高亮」——一个纯色块观众不知道它指什么
      return el.content ? `<span class="hl-label">${escapeHtml(el.content)}</span>` : ''
    default:
      return ''
  }
}

/**
 * KaTeX → MathML。
 *
 * 为什么走 `output: 'mathml'`：HTML 输出需要 20 个 woff2 字体文件（296KB），
 * 而渲染是在隐藏 BrowserWindow 里跑 `data:` URL，没有可用的字体路径；
 * MathML 由 Chromium 原生排版，**零字体文件**，输出也只有几百字节。
 *
 * 失败时退回显示原始 LaTeX（带等宽字体），至少用户能看到「这里本该有个公式」，
 * 而不是一个空白元素。
 */
function renderTex(tex: string): string {
  try {
    return katex.renderToString(tex, { output: 'mathml', throwOnError: false, displayMode: false })
  } catch {
    return `<span class="tex-fallback">${escapeHtml(tex)}</span>`
  }
}

/**
 * 数轴：水平轴 + 刻度 + 标注。
 *
 * 这是「拿极扁 rect 当数轴」的正式替代——实测模型用 `w:80 h:8` 的 rect 画数轴，
 * 渲染出来是个空心长框。这里用 SVG 画一条真正带刻度与数值的轴。
 *
 * **必须用像素坐标 + `width/height`，不能用 `viewBox="0 0 100 100"` +
 * `preserveAspectRatio="none"`**：后者会把 SVG 非等比拉伸，文字跟着压扁，
 * 且 `y` 的比例尺与 `x` 不一致会让刻度数字压在轴线上（实测第一次出的片就是
 * 这样：13 个数字全被拉成横条贴在轴上）。
 */
function renderAxis(el: SceneElement): string {
  const spec = el.axis
  if (!spec) return ''
  const color = el.color ?? '#93c5fd'
  const marks = spec.marks ?? []
  const span = spec.to - spec.from || 1
  // 数轴所在盒子的实际像素尺寸（x/y/w/h 都是百分比，按右区实际大小换算）
  const W = Math.max(60, Math.round((el.w ?? 80) * 0.01 * STAGE_PX.width))
  const H = Math.max(40, Math.round((el.h ?? 14) * 0.01 * STAGE_PX.height))
  const yAxis = Math.round(H * 0.42)
  const toX = (v: number) => ((v - spec.from) / span) * W
  const tickHalf = 5
  const labelY = yAxis + tickHalf + 15

  const parts: string[] = [
    `<line x1="2" y1="${yAxis}" x2="${W - 2}" y2="${yAxis}" stroke="${color}" stroke-width="2"/>`,
    `<path d="M ${W - 10} ${yAxis - 5} L ${W - 2} ${yAxis} L ${W - 10} ${yAxis + 5}" fill="none" stroke="${color}" stroke-width="2"/>`,
    `<path d="M 10 ${yAxis - 5} L 2 ${yAxis} L 10 ${yAxis + 5}" fill="none" stroke="${color}" stroke-width="2"/>`,
  ]
  for (const m of marks) {
    if (m < spec.from || m > spec.to) continue
    const x = toX(m)
    // 刻度线 + 数字分开画：数字在轴线**下方**，不压在线上
    parts.push(
      `<line x1="${x}" y1="${yAxis - tickHalf}" x2="${x}" y2="${yAxis + tickHalf}" stroke="${color}" stroke-width="1.5"/>`,
      `<text x="${x}" y="${labelY}" text-anchor="middle" fill="${color}" font-size="15" font-family="Microsoft YaHei,system-ui,sans-serif">${m}</text>`,
    )
  }
  return `<svg class="axis-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">${parts.join('')}</svg>`
}

function renderTable(el: SceneElement): string {
  const spec = el.table
  if (!spec) return ''
  const head = spec.headers.map((h) => `<th>${escapeHtml(h)}</th>`).join('')
  const body = spec.rows
    .map((row, ri) => {
      const cls = ri === spec.highlightRow ? ' class="hl"' : ''
      return `<tr${cls}>${row.map((c) => `<td>${escapeHtml(c)}</td>`).join('')}</tr>`
    })
    .join('')
  return `<table class="tbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>`
}

/**
 * 折线/曲线：模型 marching 给采样点，本地连成 SVG path。
 *
 * 采样点是 **0~100 的百分比**，这里换算成像素后按 `width/height` 画——
 * 不拉伸 viewBox，否则线宽会被非等比缩放扭曲。
 */
function renderCurve(el: SceneElement): string {
  const spec = el.curve
  if (!spec || spec.points.length < 2) return ''
  const color = el.color ?? '#fca5a5'
  const W = Math.max(40, Math.round((el.w ?? 40) * 0.01 * STAGE_PX.width))
  const H = Math.max(30, Math.round((el.h ?? 40) * 0.01 * STAGE_PX.height))
  const px = (p: Point) => ({ x: (p.x / 100) * W, y: (p.y / 100) * H })
  const pts = spec.points.map(px)
  const d = pts.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ')
  const close = spec.closed ? ' Z' : ''
  const fill = spec.closed ? ` fill="${color}" fill-opacity="0.18"` : ' fill="none"'
  return `<svg class="curve-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path d="${d}${close}"${fill} stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/></svg>`
}

function renderCode(el: SceneElement): string {
  const lines = (el.content ?? '').split('\n')
  const hl = new Set(el.code?.hl ?? [])
  const rows = lines
    .map((l, i) => `<div class="cl${hl.has(i) ? ' hl' : ''}">${escapeHtml(l) || '&nbsp;'}</div>`)
    .join('')
  const label = el.code?.language ? `<div class="clang">${escapeHtml(el.code.language)}</div>` : ''
  return `${label}<pre class="code">${rows}</pre>`
}

/**
 * 箭头：从 `from` 指向元素自身的 x/y 位置（都是 0~100 的百分比）。
 *
 * 按对应盒子的像素尺寸画，箭头头部按**像素**定大小——若按百分比缩放，
 * 细长的箭头会被拉成一条斜线、箭头头部变形。
 */
function renderArrow(el: SceneElement): string {
  const from = el.from
  if (!from) return ''
  const color = el.color ?? '#fca5a5'
  const to = { x: el.x ?? 30, y: el.y ?? 40 }
  // 箭头占据两端点围成的包围盒（百分比 → 右区像素），外加一圈留白给箭头头部
  const PAD = 12
  const minX = Math.min(from.x, to.x)
  const minY = Math.min(from.y, to.y)
  const W = Math.max(30, Math.round((Math.abs(to.x - from.x) / 100) * STAGE_PX.width) + PAD * 2)
  const H = Math.max(30, Math.round((Math.abs(to.y - from.y) / 100) * STAGE_PX.height) + PAD * 2)
  // 局部坐标：包围盒左上角 + PAD
  const local = (p: Point) => ({
    x: ((p.x - minX) / 100) * STAGE_PX.width + PAD,
    y: ((p.y - minY) / 100) * STAGE_PX.height + PAD,
  })
  const p1 = local(from)
  const p2 = local(to)
  const dx = p2.x - p1.x
  const dy = p2.y - p1.y
  const len = Math.hypot(dx, dy) || 1
  const ux = dx / len
  const uy = dy / len
  const head = Math.min(10, len * 0.4)
  const hx = p2.x - ux * head
  const hy = p2.y - uy * head
  const px = -uy * 4.5
  const py = ux * 4.5
  return `<svg class="arrow-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><line x1="${p1.x.toFixed(1)}" y1="${p1.y.toFixed(1)}" x2="${hx.toFixed(1)}" y2="${hy.toFixed(1)}" stroke="${color}" stroke-width="2.5" stroke-linecap="round"/><path d="M ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} L ${(hx + px).toFixed(1)} ${(hy + py).toFixed(1)} M ${p2.x.toFixed(1)} ${p2.y.toFixed(1)} L ${(hx - px).toFixed(1)} ${(hy - py).toFixed(1)}" stroke="${color}" stroke-width="2.5" fill="none" stroke-linecap="round"/></svg>`
}

/**
 * 花括号：把 `from` 到 `to` 之间的纵向范围括起来，尖端朝左。
 *
 * 用两段二次贝塞尔拼，避开手写路径的分段误差。
 */
function renderBrace(el: SceneElement): string {
  const from = el.from
  const to = el.to
  if (!from || !to) return ''
  const color = el.color ?? '#fde68a'
  const topPct = Math.min(from.y, to.y)
  const bottomPct = Math.max(from.y, to.y)
  const H = Math.max(20, Math.round(((bottomPct - topPct) / 100) * STAGE_PX.height))
  const W = 24
  const mid = H / 2
  const r = Math.min(6, H / 4)
  const d = `M ${W} 0 Q ${W - r * 2} 0 ${W - r * 2} ${r} L ${W - r * 2} ${mid - r} Q ${W - r * 2} ${mid} 0 ${mid} Q ${W - r * 2} ${mid} ${W - r * 2} ${mid + r} L ${W - r * 2} ${H - r} Q ${W - r * 2} ${H} ${W} ${H}`
  return `<svg class="brace-svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><path d="${d}" fill="none" stroke="${color}" stroke-width="2"/></svg>`
}

/**
 * 生成一节的完整 HTML（模板版）。
 *
 * 页面自己做**时间轴驱动**：所有元素初始隐藏，按 `steps` 顺序逐个显示并高亮
 * 对应讲义行。这样截图侧只需要「seek 到第 N 毫秒 + 拍一张」，
 * 不需要在截图时去操作 DOM（那会让每一帧的时机不可复现）。
 *
 * 关键设计：动画用 **CSS transition + 预先算好的绝对定位**，不用 requestAnimationFrame
 * 累计时间——后者在无头浏览器里会被节流，帧与帧之间跳变。
 */
export function buildSectionHtml(
  section: StoryboardSection,
  totalSeconds?: number,
  theme: StyleTheme = DEFAULT_STYLE.theme,
): string {
  const lines = section.lectureLines.map((l) => clampLectureLine(l))
  const steps = section.animations.slice(0, lines.length)
  const secs = totalSeconds ?? Math.max(6, steps.length * STEP_SECONDS)
  const perStep = secs / Math.max(1, steps.length)

  const lectureHtml = lines
    .map(
      (line, i) =>
        `<li class="line" data-line="${i}"><span class="idx">${i + 1}</span><span class="txt">${escapeHtml(line)}</span></li>`,
    )
    .join('\n')

  // 右侧动画区：每个步骤一个面板，按 6×6 网格的**思想**分区（这里用 3×3 区块，
  // 因为 HTML 没有 Manim 的坐标系统；区块足够避免元素互相压住）
  const panels = steps
    .map((desc, i) => {
      const cell = gridCell(i)
      return `<div class="panel" data-step="${i}" style="left:${cell.x}%;top:${cell.y}%;width:${cell.w}%;height:${cell.h}%">
        <div class="panel-title">${escapeHtml(desc.slice(0, 80))}</div>
        <div class="panel-body">${escapeHtml(shorten(desc, 160))}</div>
      </div>`
    })
    .join('\n')

  const timeline = steps
    .map((_, i) => `{ at: ${Math.round(i * perStep * 1000)}, step: ${i} }`)
    .join(',\n    ')

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<title>${escapeHtml(section.title)}</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: ${FRAME.width}px; height: ${FRAME.height}px; overflow: hidden; }
  body {
    background: #000; color: #fff;
    font-family: "PingFang SC", "Microsoft YaHei", system-ui, sans-serif;
    display: flex;
  }
  #lecture {
    width: ${LECTURE_RATIO * 100}%; height: 100%;
    padding: 48px 24px 48px 40px;
    border-right: 1px solid #1f2937;
    display: flex; flex-direction: column; gap: 20px;
  }
  #title { font-size: 24px; font-weight: 600; color: #93c5fd; line-height: 1.35; margin-bottom: 12px;
    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  ul { list-style: none; display: flex; flex-direction: column; gap: 22px; }
  .line {
    display: flex; gap: 12px; align-items: center;
    font-size: 24px; line-height: 1.5; color: #4b5563;
    transition: color 420ms ease, text-shadow 420ms ease;
  }
  /* 同主模板：讲义强制单行，换行会挤乱左侧节奏 */
  .line .txt { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .line.active { color: #ffffff; text-shadow: 0 0 18px rgba(96,165,250,0.55); }
  .line.done { color: #9ca3af; }
  .idx {
    flex: 0 0 28px; height: 28px; border-radius: 50%;
    background: #1f2937; color: #6b7280;
    font-size: 15px; display: flex; align-items: center; justify-content: center;
    transition: background 420ms ease, color 420ms ease;
  }
  .line.active .idx { background: #2563eb; color: #fff; }
  #stage { position: relative; flex: 1; height: 100%; }
  .panel {
    position: absolute; padding: 18px;
    border: 1px solid #374151; border-radius: 12px;
    background: rgba(17,24,39,0.72);
    opacity: 0; transform: translateY(14px) scale(0.97);
    transition: opacity 520ms ease, transform 520ms ease, border-color 520ms ease;
  }
  .panel.on { opacity: 1; transform: translateY(0) scale(1); border-color: #3b82f6; }
  .panel-title { font-size: 19px; color: #93c5fd; margin-bottom: 10px; font-weight: 600; line-height: 1.4; }
  .panel-body { font-size: 17px; color: #d1d5db; line-height: 1.6; }
</style>
</head>
<body>
  <div id="lecture">
    <div id="title">${escapeHtml(section.title)}</div>
    <ul>
${lectureHtml}
    </ul>
  </div>
  <div id="stage">
${panels}
  </div>
<script>
  var TIMELINE = [
    ${timeline}
  ];
  function applyAt(ms) {
    var active = -1;
    for (var i = 0; i < TIMELINE.length; i++) {
      if (ms >= TIMELINE[i].at) active = TIMELINE[i].step;
    }
    var panels = document.querySelectorAll('.panel');
    var lines = document.querySelectorAll('.line');
    for (var p = 0; p < panels.length; p++) {
      panels[p].classList.toggle('on', p <= active);
    }
    for (var l = 0; l < lines.length; l++) {
      lines[l].classList.toggle('active', l === active);
      lines[l].classList.toggle('done', l < active);
    }
    return active;
  }
  // 截图侧通过 window.__seek(ms) 定位（不依赖真实播放时钟，保证可复现）
  window.__seek = function (ms) { return applyAt(ms); };
  window.__totalMs = ${Math.round(secs * 1000)};
  applyAt(0);
</script>
</body>
</html>`
}

/**
 * 3×3 区块分配：第 i 步落在第 i 个区块。
 *
 * 与 Manim 版的 6×6 网格同一个出发点——**先给每个元素一个互不相交的格子**，
 * 就不会出现元素叠在一起。超过 9 步时循环复用（内容本来也放不下）。
 */
function gridCell(index: number): { x: number; y: number; w: number; h: number } {
  const cols = 3
  const rows = 3
  const cell = index % (cols * rows)
  const col = cell % cols
  const row = Math.floor(cell / cols)
  const gapPct = 2
  const wPct = 100 / cols - gapPct
  const hPct = 100 / rows - gapPct
  return {
    x: (col * 100) / cols + gapPct / 2,
    y: (row * 100) / rows + gapPct / 2,
    w: wPct,
    h: hPct,
  }
}

/** 面板的包围盒（用于重叠检测；与 `gridCell` 同源，改一处必须改两处的话就在注释里说清） */
export function panelBoxes(section: StoryboardSection): Array<{ id: string; box: Box }> {
  const n = Math.min(section.animations.length, section.lectureLines.length)
  const stageW = FRAME.width * (1 - LECTURE_RATIO)
  const out: Array<{ id: string; box: Box }> = []
  for (let i = 0; i < n; i++) {
    const c = gridCell(i)
    out.push({
      id: `step_${i + 1}`,
      box: {
        x: (c.x / 100) * stageW,
        y: (c.y / 100) * FRAME.height,
        w: (c.w / 100) * stageW,
        h: (c.h / 100) * FRAME.height,
      },
    })
  }
  return out
}

/**
 * 这一节的实际布局问题。
 *
 * **有结构化画面时检查真实元素，没有时才检查文字模板的面板。**
 * 老实现无条件调 `panelBoxes`，而面板只在 `buildSectionHtml`（`section.scene`
 * 为空）里存在——默认的 LLM 画面模式下这些面板根本不存在，等于一直在检查
 * 一堆不存在的框，真实的元素重叠反而一次都没被报出来过。
 */
export function checkSectionLayout(section: StoryboardSection): LayoutIssue[] {
  if (section.scene?.length) return checkSceneLayout(section.scene)
  return findOverlaps(panelBoxes(section)).map((o) => ({
    step: Number(o.a.replace(/\D/g, '')) - 1,
    kind: 'overlap' as const,
    detail: `${o.a} × ${o.b} 重叠 ${Math.round(o.ratio * 100)}%`,
    indexes: [],
  }))
}

/**
 * 一节的实际时长（秒）。
 *
 * 优先用服务算好的 `targetSeconds`（按用户给的期望总时长均分）；
 * 没有时按「每步 3 秒、至少 6 秒」自算——**下限 6 秒是有意的**：
 * 再短的话单步动画刚出现就切走，看不清。
 */
export function sectionSeconds(section: StoryboardSection): number {
  // 有配音时间轴时，这一节的长度就是每步之和
  if (section.stepSeconds?.length) {
    return section.stepSeconds.reduce((a, b) => a + b, 0)
  }
  if (typeof section.targetSeconds === 'number' && section.targetSeconds > 0) {
    return section.targetSeconds
  }
  return Math.max(6, Math.min(section.animations.length, section.lectureLines.length) * STEP_SECONDS)
}

/**
 * 每一步的起始时刻（毫秒）。
 *
 * 有 `stepSeconds`（配音给的）就用它累加；没有就均分。
 * 这是「动画跟着声音走」的落点：`__seek(t)` 按这些时刻切步。
 */
export function stepStartMs(section: StoryboardSection, stepCount: number): number[] {
  const n = Math.max(1, stepCount)
  if (section.stepSeconds?.length) {
    const out: number[] = []
    let cursor = 0
    for (let i = 0; i < n; i++) {
      out.push(Math.round(cursor * 1000))
      cursor += section.stepSeconds[i] ?? section.stepSeconds[section.stepSeconds.length - 1] ?? 2
    }
    return out
  }
  const secs = sectionSeconds(section)
  const per = (secs * 1000) / n
  return Array.from({ length: n }, (_, i) => Math.round(i * per))
}

export function totalSeconds(storyboard: TeachingStoryboard): number {
  return storyboard.sections.reduce(
    (sum, s) => sum + sectionSeconds(s),
    0,
  )
}

// ---------------------------------------------------------------
// 渲染编排
// ---------------------------------------------------------------

export interface RenderDeps {
  /** 用 playwright-core 打开一个 Chromium 实例（页面渲染与截图） */
  launchBrowser: () => Promise<BrowserLike>
  ffmpeg: {
    resolve: () => Promise<string | null>
    run: (args: readonly string[], opts?: { timeoutMs?: number }) => Promise<{ ok: boolean; stderr: string }>
  }
  /** 输出目录（每节一个 .mp4） */
  outDir: string
  log: (msg: string) => void
  /**
   * 只渲染这些小节（1 起）；其余节复用目录里已有的 mp4。
   *
   * 对应原版「改几行坐标后只重渲那一小段」：`revise` 阶段不重跑整条，
   * 避免为了一节的改动把另外几节也重渲一遍（每节 10~20 秒）。
   */
  onlySections?: ReadonlySet<number>
  /** 视觉风格；缺省用默认（3B1B） */
  style?: VisualStyle
  /**
   * 每节的讲解字幕（按节 id 索引）。给了就在渲染后把音频叠上去、字幕烧进去。
   *
   * 之所以放在渲染循环里做，而不是全部渲染完再统一做：每节渲染要 30~60 秒，
   * 而配音+字幕只是一次 ffmpeg 编码；分开做能早发现音频问题，也能让
   * `revise` 只重做点名的那节时顺带重配音。
   */
  narration?: ReadonlyMap<string, readonly Cue[]>
  /** SRT 输出目录（整片字幕） */
  srtOutPath?: string
}

/** 只取 drizzle 需要的最小面，便于单测造假对象 */
export interface BrowserLike {
  renderSection: (html: string, outMp4: string, totalMs: number, fps: number) => Promise<void>
  close: () => Promise<void>
  /**
   * 上一次 `renderSection` 里抽检的帧统计（可选）。
   *
   * 抽帧自检需要看**像素**，而截图本来就在渲染循环里发生——顺手多算一次
   * 统计比渲染完再重新解码 PNG 便宜得多。实现方没提供时门禁跳过这一层。
   */
  lastFrameSamples?: () => FrameStats[]
}

export interface RenderResult {
  ok: boolean
  videoPath?: string
  sectionVideos: string[]
  /** 抽帧自检发现的画面问题（不阻断交付，但要如实回告） */
  frameIssues?: Array<{ section: string; issues: FrameIssue[] }>
  error?: string
}

/**
 * 渲染整条分镜：逐节出 HTML → 录成 mp4 → 用 ffmpeg concat 合成。
 *
 * 逐节可失败：某一节渲染失败不阻断其余节（与原版一致——它们的
 * `render_section` 失败也只是跳过该节），但**全部失败**才整体报错。
 */
export async function renderStoryboard(
  storyboard: TeachingStoryboard,
  deps: RenderDeps,
): Promise<RenderResult> {
  fs.mkdirSync(deps.outDir, { recursive: true })
  const browser = await deps.launchBrowser()
  const sectionVideos: string[] = []
  const frameIssues: Array<{ section: string; issues: FrameIssue[] }> = []
  try {
    for (let i = 0; i < storyboard.sections.length; i++) {
      const section = storyboard.sections[i]!
      const outMp4 = path.join(deps.outDir, `section_${i + 1}.mp4`)

      // revise：没点名且已有成片的节直接复用，不重新渲染
      if (deps.onlySections && !deps.onlySections.has(i + 1) && fs.existsSync(outMp4)) {
        sectionVideos.push(outMp4)
        deps.log(`[render] 第 ${i + 1} 节未指定重做，复用已有 mp4`)
        continue
      }

      // 优先用模型给的结构化画面；没有才退回纯文字模板
      const theme = deps.style?.theme ?? DEFAULT_STYLE.theme
      const html = section.scene?.length
        ? buildSceneHtml(section, section.scene, theme)
        : buildSectionHtml(section, undefined, theme)
      const htmlPath = path.join(deps.outDir, `section_${i + 1}.html`)
      fs.writeFileSync(htmlPath, html, 'utf8')

      // 元素互相压住时先记日志再照常渲染：重叠是**质量缺陷**不是致命错误，
      // 因为面板当前是文本块，轻微重叠仍可读。真正的判据在工具结果里如实回传。
      const overlaps = checkSectionLayout(section)
      if (overlaps.length > 0) {
        deps.log(
          `[render] 第 ${i + 1} 节布局问题: ${overlaps.map((o) => `[${o.kind}] ${o.detail}`).join('; ')}`,
        )
      }

      const secs = sectionSeconds(section)
      try {
        await browser.renderSection(html, outMp4, secs * 1000, 12)
        deps.log(`[render] 第 ${i + 1}/${storyboard.sections.length} 节完成`)

        // 有配音就给这一节叠音频 + 烧字幕。
        // 失败了保留无声版本继续——一条无声视频仍可用，缺一节视频就废了。
        const cues = deps.narration?.get(section.id)
        if (cues?.length) {
          const srtPath = path.join(deps.outDir, `section_${i + 1}.srt`)
          fs.writeFileSync(srtPath, cuesToSrt(cues), 'utf8')
          const narrated = outMp4.replace(/\.mp4$/, '.narrated.mp4')
          const r = await addNarration(
            { videoPath: outMp4, outputPath: narrated, cues, srtPath },
            deps.ffmpeg,
          )
          if (r.ok) {
            sectionVideos.push(narrated)
            deps.log(`[render] 第 ${i + 1} 节配音与字幕已合成`)
          } else {
            sectionVideos.push(outMp4)
            deps.log(`[render] 第 ${i + 1} 节配音合成失败，保留无声版：${r.error ?? ''}`)
          }
        } else {
          sectionVideos.push(outMp4)
        }

        // 抽帧自检：像素是唯一证据。这一步不阻断交付，但问题必须回传——
        // 前几层门禁看的是数据，查不出「画了但小到看不见」。
        const samples = browser.lastFrameSamples?.()
        if (samples?.length) {
          const issues = samples.flatMap((s, fi) => checkFrame(s, fi))
          if (issues.length > 0) {
            frameIssues.push({ section: section.title, issues })
            deps.log(
              `[render] 第 ${i + 1} 节画面自检: ${issues.map((x) => `[${x.kind}] ${x.detail}`).join('; ')}`,
            )
          }
        }
      } catch (err) {
        deps.log(`[render] 第 ${i + 1} 节失败: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  } finally {
    await browser.close().catch(() => {})
  }

  if (sectionVideos.length === 0) {
    return { ok: false, sectionVideos, error: '所有小节都渲染失败' }
  }

  const finalPath = path.join(deps.outDir, 'teaching-video.mp4')
  const merged = await concatVideos(sectionVideos, finalPath, deps.ffmpeg)
  if (!merged.ok) {
    return { ok: false, sectionVideos, error: `合成失败：${merged.error}` }
  }
  return { ok: true, videoPath: finalPath, sectionVideos, frameIssues }
}

/** ffmpeg concat 合成（同尺寸同编码，用 -c copy 直拼） */
export async function concatVideos(
  inputs: readonly string[],
  output: string,
  ffmpeg: RenderDeps['ffmpeg'],
): Promise<{ ok: boolean; error?: string }> {
  const bin = await ffmpeg.resolve()
  if (!bin) return { ok: false, error: 'ffmpeg 不可用' }
  const listPath = path.join(path.dirname(output), 'concat.txt')
  fs.writeFileSync(
    listPath,
    inputs.map((p) => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'),
    'utf8',
  )
  const r = await ffmpeg.run(
    ['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', output],
    { timeoutMs: 120_000 },
  )
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.slice(-400) }
}

/**
 * 给一节视频配上旁白并烧字幕。
 *
 * 顺序：把每句音频按 startMs 延时后用 `amix` 叠成一条音轨 → 同时把 SRT 烧进画面。
 * 之所以不是「先拼音频再做视频」：视频已经渲染好了，重渲一遍要多等十几分钟；
 * 这里只做一次编码。
 *
 * `ffmpeg` 的 `subtitles` 滤镜对路径转义很挑：Windows 盘符里的 `:` 要写成 `\\:`，
 * 反斜杠要写成 `/`。这段转义是照 screen-record 那份踩过坑的实现来的。
 */
export async function addNarration(
  opts: {
    videoPath: string
    outputPath: string
    cues: readonly Cue[]
    srtPath: string
  },
  ffmpeg: RenderDeps['ffmpeg'],
): Promise<{ ok: boolean; error?: string }> {
  const bin = await ffmpeg.resolve()
  if (!bin) return { ok: false, error: 'ffmpeg 不可用' }
  const withAudio = opts.cues.filter((c) => c.audioPath)
  const args: string[] = ['-y', '-i', opts.videoPath]

  // 每句音频各自一个输入
  for (const c of withAudio) args.push('-i', c.audioPath!)

  // 字幕滤镜。**必须并进 -filter_complex**：ffmpeg 不允许 -vf 与 -filter_complex
  // 同时出现（-vf 会自己建一个 filtergraph，两者冲突 → 整个命令报错）。
  // 实测就是这里导致 5 节全部「配音合成失败，保留无声版」。
  const srtArg = opts.srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")
  const filters: string[] = [`[0:v]subtitles='${srtArg}'[vout]`]

  if (withAudio.length > 0) {
    // 每句按开始时间延迟，再全部混成一条
    withAudio.forEach((c, i) => {
      // 输入 0 是视频，音频从 1 开始
      filters.push(`[${i + 1}:a]adelay=${Math.round(c.startMs)}|${Math.round(c.startMs)}[a${i}]`)
    })
    const mixInputs = withAudio.map((_, i) => `[a${i}]`).join('')
    // 不用 `normalize=0`：包里那份 ffmpeg 是 2018 年的 N-92722，`amix` 还没有这个选项
    // （实测 `Option 'normalize' not found` → 整条命令失败 → 全部退回无声版）。
    // 句与句本来就不重叠（各自延时到不同时间点），归一化本来也不该生效。
    filters.push(`${mixInputs}amix=inputs=${withAudio.length}:duration=longest[aout]`)
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]', '-map', '[aout]')
    args.push('-c:a', 'aac', '-b:a', '128k')
  } else {
    args.push('-filter_complex', filters.join(';'), '-map', '[vout]')
  }

  args.push('-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-preset', 'veryfast', '-crf', '23')
  args.push('-shortest', opts.outputPath)

  const r = await ffmpeg.run(args, { timeoutMs: 300_000 })
  return r.ok ? { ok: true } : { ok: false, error: r.stderr.slice(-500) }
}

// ---------------------------------------------------------------
// 工具函数
// ---------------------------------------------------------------

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 属性值转义：data-* 里的 JSON 含引号与尖括号，不能直接拼进去 */
function escapeAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function shorten(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}
