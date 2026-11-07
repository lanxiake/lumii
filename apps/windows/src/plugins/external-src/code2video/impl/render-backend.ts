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

import type { StoryboardSection, TeachingStoryboard } from './teaching-core'
import {
  checkSceneLayout,
  clampLectureLine,
  findOverlaps,
  type Box,
  type LayoutIssue,
  type SceneElement,
  type SceneStep,
} from './teaching-core'

/** 画面尺寸（固定，ffmpeg 要求同尺寸才能 concat） */
export const FRAME = { width: 1280, height: 720 } as const

/** 每步动画的默认时长（秒）；模型给的自描述里没有时长，按步数均分 */
const STEP_SECONDS = 3

/** 左侧讲义区宽度占画面的比例 */
const LECTURE_RATIO = 0.3

/**
 * 由**结构化画面描述**生成 HTML（模型只出 JSON，HTML 由这里拼）。
 *
 * 为什么不直接让模型吐 HTML：单轮调用输出一整页 HTML 时，实测 10/10 次在
 * 80~120 秒后返回空；同一批次里只出 JSON 的调用 4~19 秒正常。这里把
 * 「描述画面」和「生成页面」分开，模型的输出量降一个数量级，页面由本地拼装。
 */
export function buildSceneHtml(section: StoryboardSection, scene: SceneStep[]): string {
  const lines = section.lectureLines.map((l) => clampLectureLine(l))
  const secs = sectionSeconds(section)
  const perStep = secs / Math.max(1, scene.length)

  const lectureHtml = lines
    .map(
      (line, i) =>
        `<li class="line" data-line="${i}"><span class="idx">${i + 1}</span><span class="txt">${escapeHtml(line)}</span></li>`,
    )
    .join('\n')

  // 每个元素带自己的出现时间（所在步的起点），渲染时按时间逐个亮起
  const elements: string[] = []
  const timeline: string[] = []
  scene.forEach((step, si) => {
    timeline.push(`{ at: ${Math.round(si * perStep * 1000)}, step: ${si} }`)
    step.elements.forEach((el, ei) => {
      const style = [
        `left:${el.x ?? 30}%`,
        `top:${el.y ?? 40}%`,
        `width:${el.w ?? 24}%`,
        `height:${el.h ?? 14}%`,
        el.color ? `--c:${el.color}` : '',
      ]
        .filter(Boolean)
        .join(';')
      const body = renderElement(el, `s${si}e${ei}`)
      elements.push(`<div class="el el-${el.kind}" style="${style}" data-step="${si}">${body}</div>`)
    })
  })

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8"><title>${escapeHtml(section.title)}</title>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  html,body{width:${FRAME.width}px;height:${FRAME.height}px;overflow:hidden}
  body{background:#000;color:#fff;display:flex;font-family:"Microsoft YaHei",system-ui,sans-serif}
  #lecture{width:${LECTURE_RATIO * 100}%;padding:44px 22px 44px 36px;border-right:1px solid #1f2937}
  #title{font-size:25px;font-weight:600;color:#93c5fd;line-height:1.35;margin-bottom:18px;
    /* 标题同样单行：换行会把第一行讲义挤下去（实测「第三次握手：补齐客户端的确认」折了两行） */
    white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  ul{list-style:none;display:flex;flex-direction:column;gap:20px}
  .line{display:flex;gap:11px;font-size:23px;line-height:1.5;color:#4b5563;
    transition:color 420ms ease,text-shadow 420ms ease}
  /* 讲义**必须单行**：换行会挤掉下面几行、破坏左侧的阅读节奏（实测 TCP 那节
     「客户端回 ACK：收到服务器序号」换行后与第 3 行贴在一起）。字符数截断在
     中英混排下不可靠，交给 CSS 按实际宽度省略。 */
  .line .txt{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .line .idx{flex:0 0 auto}

  .line.active{color:#fff;text-shadow:0 0 18px rgba(96,165,250,.55)}
  .idx{flex:0 0 26px;height:26px;border-radius:50%;background:#1f2937;color:#6b7280;
    font-size:14px;display:flex;align-items:center;justify-content:center}
  .line.active .idx{background:#2563eb;color:#fff}
  #stage{position:relative;flex:1}
  .el{position:absolute;opacity:0;transition:opacity 420ms ease,transform 420ms ease;
    transform:translateY(8px)}
  .el.on{opacity:1;transform:translateY(0)}
  .el-text,.el-formula{display:flex;align-items:center;justify-content:center;
    font-size:26px;color:var(--c,#93c5fd);text-align:center;line-height:1.3}
  .el-formula{font-size:32px;font-style:italic;letter-spacing:1px}
  .el-rect{background:transparent;border:2px solid var(--c,#3b82f6);border-radius:6px}
  .el-circle{border:2px solid var(--c,#86efac);border-radius:50%}
  .el-line{height:0 !important;border-top:3px solid var(--c,#fca5a5)}
</style></head><body>
<div id="lecture"><div id="title">${escapeHtml(section.title)}</div><ul>${lectureHtml}</ul></div>
<div id="stage">${elements.join('')}</div>
<script>
var T=[${timeline.join(',')}];
window.__seek=function(ms){
  var a=-1;for(var i=0;i<T.length;i++)if(ms>=T[i].at)a=T[i].step;
  document.querySelectorAll('.el').forEach(function(e){
    e.classList.toggle('on', Number(e.dataset.step)<=a);
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

function renderElement(el: SceneElement, key: string): string {
  if (el.kind === 'text' || el.kind === 'formula') return escapeHtml(el.content ?? '')
  if (el.kind === 'rect') return ''
  if (el.kind === 'circle') return ''
  if (el.kind === 'line') return ''
  return ''
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
export function buildSectionHtml(section: StoryboardSection, totalSeconds?: number): string {
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
  if (typeof section.targetSeconds === 'number' && section.targetSeconds > 0) {
    return section.targetSeconds
  }
  return Math.max(6, Math.min(section.animations.length, section.lectureLines.length) * STEP_SECONDS)
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
}

/** 只取 drizzle 需要的最小面，便于单测造假对象 */
export interface BrowserLike {
  renderSection: (html: string, outMp4: string, totalMs: number, fps: number) => Promise<void>
  close: () => Promise<void>
}

export interface RenderResult {
  ok: boolean
  videoPath?: string
  sectionVideos: string[]
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
      const html = section.scene?.length
        ? buildSceneHtml(section, section.scene)
        : buildSectionHtml(section)
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
        sectionVideos.push(outMp4)
        deps.log(`[render] 第 ${i + 1}/${storyboard.sections.length} 节完成`)
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
  return { ok: true, videoPath: finalPath, sectionVideos }
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

function shorten(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}
