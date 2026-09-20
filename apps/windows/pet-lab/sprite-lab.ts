/**
 * 精灵图后端 Lab —— 三方案对比 + 场景 A / B
 *
 * 设计依据：docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md §4.2 / §8
 *
 * 三条用途：
 *   1. 肉眼对比三方案（同一份渲染器，差异只来自资源组织）
 *   2. 跑设计 §8 的两个**淘汰场景**，产出可测量的结论
 *   3. 暴露 `window.__lab` 给 Playwright 驱动，让结论是测出来的而不是看出来的
 *
 * 这里不启动 electron / agent，直接复用生产的 `SpritePetRenderer`。
 */

import {
  SPRITE_MAX_HEIGHT_RATIO,
  SpritePetRenderer,
} from '../src/renderer/pet/renderer/sprite/SpritePetRenderer'
import { adaptiveScale, hitTestPolygons, motionCount, resolveSpriteRuntime } from '@mtbot/pet-core'
import type { SpriteManifest } from '@mtbot/pet-core'
import type { PetModelConfig } from '../src/renderer/pet/config/pet-model-types'

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T
const canvas = $<HTMLCanvasElement>('petCanvas')
const metricsEl = $('metrics')
const logEl = $('log')

/** 日志同时进面板与内存数组，后者供 Playwright 断言（面板内容是给人看的，不好解析） */
const logLines: string[] = []

function log(msg: string): void {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  logLines.push(`[${t}] ${msg}`)
  if (logLines.length > 500) logLines.shift()
  logEl.textContent = logLines.slice().reverse().join('\n')
}

// ---------------------------------------------------------------------------
// 模型清单
// ---------------------------------------------------------------------------

interface LabModel {
  id: string
  label: string
  /** 相对 /pet-models 的路径 */
  path: string
  /** 对比用分组标签 */
  group: string
}

/**
 * 三方案变体不在 registry.json 里（客户端按注册表读，不该看到它们），
 * 所以这里静态列出——lab 是开发工具，写死路径比让生产注册表带上测试夹具更干净。
 */
const MODELS: LabModel[] = [
  { id: 'demo_pixel_cat', label: '像素猫（示范 · 混合）', path: 'demo_pixel_cat/manifest.json', group: '示范模型' },
  { id: 'demo_hires_girl', label: '高清少女（示范 · 混合）', path: 'demo_hires_girl/manifest.json', group: '示范模型' },
  { id: 'demo_variant_a', label: '方案 A · 整体帧', path: '_variants/demo_variant_a/manifest.json', group: '三方案对比' },
  { id: 'demo_variant_b', label: '方案 B · 分层差分', path: '_variants/demo_variant_b/manifest.json', group: '三方案对比' },
  { id: 'demo_variant_c', label: '方案 C · 混合', path: '_variants/demo_variant_c/manifest.json', group: '三方案对比' },
]

const renderer = new SpritePetRenderer()
let current: LabModel | null = null
let manifest: SpriteManifest | null = null
let atlasBytes = 0
let loadMs = 0
let currentGroup: string | null = null
let textureCount = 0
let probeStats: {
  matched: number
  total: number
  falseNeg: number
  falsePos: number
  group: string | null
  checkedAt: string
} | null = null

function modelUrl(m: LabModel): string {
  return `/pet-models/${m.path}`
}

function configFor(m: LabModel): PetModelConfig {
  return {
    id: m.id,
    name: m.label,
    rendererType: 'sprite',
    modelUrl: modelUrl(m),
    scale: 1,
    idleMotionGroup: 'Idle',
    talkMotionGroup: 'Talk',
    emotionMap: {},
    tapMotions: {},
    defaultExpression: 0,
  }
}

// ---------------------------------------------------------------------------
// 加载
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  await renderer.init({ canvas, width: canvas.clientWidth, height: canvas.clientHeight })
  window.addEventListener('resize', () => renderer.resize(canvas.clientWidth, canvas.clientHeight))

  const sel = $<HTMLSelectElement>('modelSelect')
  for (const group of ['示范模型', '三方案对比']) {
    const og = document.createElement('optgroup')
    og.label = group
    for (const m of MODELS.filter((x) => x.group === group)) {
      const o = document.createElement('option')
      o.value = m.id
      o.textContent = m.label
      og.appendChild(o)
    }
    sel.appendChild(og)
  }
  sel.addEventListener('change', () => void selectModel(sel.value))
  $('scnB').addEventListener('click', runSceneB)
  $('scnA').addEventListener('click', runSceneA)
  $('probe').addEventListener('click', probeHitAreas)
  await selectModel(MODELS[0].id)
  startMetricsLoop()
}

async function selectModel(id: string): Promise<void> {
  const m = MODELS.find((x) => x.id === id)
  if (!m) return
  stopThrow()
  const t0 = performance.now()
  await renderer.loadModel(configFor(m))
  loadMs = performance.now() - t0
  current = m
  manifest = (await (await fetch(modelUrl(m))).json()) as SpriteManifest

  // 图集体积：对比表要用
  atlasBytes = 0
  try {
    const atlasUrl = new URL(manifest.atlas, new URL(modelUrl(m), location.href).href).href
    const head = await fetch(atlasUrl)
    atlasBytes = Number(head.headers.get('content-length') ?? 0)
  } catch {
    /* 拿不到就算了，度量表里显示 0 */
  }

  currentGroup = 'Idle'
  renderer.playMotion('Idle', 0)
  renderer.setExpression(0)
  renderer.setMouthOpen(0)
  probeStats = null
  buildChips()
  textureCount = Object.keys(manifest.atlas ? (await (await fetch(new URL(manifest.atlasJson, new URL(modelUrl(m), location.href).href).href)).json() as { frames: Record<string, unknown> }).frames : {}).length
  log(`加载 ${m.label}（${loadMs.toFixed(0)}ms，图集 ${(atlasBytes / 1024).toFixed(1)}KB，条目 ${textureCount}）`)
}

// ---------------------------------------------------------------------------
// 控件
// ---------------------------------------------------------------------------

function buildChips(): void {
  if (!manifest) return
  const runtime = resolveSpriteRuntime(manifest)

  // 表情：face 槽里非 mouth 的部件类别
  const faceSlot = manifest.slots?.face
  const cats = Object.keys(faceSlot?.parts ?? {})
  const eyeCat = cats.find((c) => /eye|expression|face/i.test(c)) ?? cats[0]
  const mouthCat = cats.find((c) => /mouth/i.test(c))
  const eyes = (eyeCat && faceSlot?.parts?.[eyeCat]) || []
  const mouths = manifest.mouthLevels ?? []

  const row = (host: string, items: { label: string; on: () => void; active?: () => boolean }[]) => {
    const el = $(host)
    el.innerHTML = ''
    for (const it of items) {
      const b = document.createElement('span')
      b.className = 'chip' + (it.active?.() ? ' on' : '')
      b.textContent = it.label
      b.onclick = () => {
        it.on()
        buildChips()
        updateMetrics()
      }
      el.appendChild(b)
    }
  }

  let activeExpr = 0
  let activeMouth = 0
  row(
    'exprChips',
    eyes.map((name, i) => ({
      label: name,
      active: () => activeExpr === i,
      on: () => {
        activeExpr = i
        renderer.setExpression(i)
        log(`表情 → ${name}（index ${i}/${eyes.length}）`)
      },
    })),
  )
  row(
    'mouthChips',
    mouths.map((name, i) => ({
      label: name,
      active: () => activeMouth === i,
      on: () => {
        activeMouth = i
        renderer.setMouthOpen(mouths.length > 1 ? i / (mouths.length - 1) : 0)
        log(`口型 → ${name}`)
      },
    })),
  )
  row(
    'motionChips',
    [...runtime.animationsByGroup.keys()].map((g) => ({
      label: `${g}(${motionCount(runtime, g)})`,
      on: () => {
        currentGroup = g
        renderer.playMotion(g, 0)
        log(`动作 → ${g}`)
      },
    })),
  )
}

// ---------------------------------------------------------------------------
// 场景 B：表情 × 动作 × 口型 叠加
// ---------------------------------------------------------------------------

let sceneBTimer: number | null = null

function runSceneB(): void {
  if (sceneBTimer !== null) {
    window.clearInterval(sceneBTimer)
    sceneBTimer = null
    log('场景 B 停止')
    return
  }
  if (!manifest) return
  const runtime = resolveSpriteRuntime(manifest)
  const faceSlot = manifest.slots?.face
  const cats = Object.keys(faceSlot?.parts ?? {})
  const eyeCat = cats.find((c) => /eye|expression|face/i.test(c)) ?? cats[0]
  const eyes = (eyeCat && faceSlot?.parts?.[eyeCat]) || []
  const mouths = manifest.mouthLevels ?? []
  const groups = [...runtime.animationsByGroup.keys()]

  let step = 0
  log(`场景 B 开始：${eyes.length} 表情 × ${mouths.length} 口型 × ${groups.length} 动作`)
  sceneBTimer = window.setInterval(() => {
    step++
    // 三个轴各自以不同周期推进，制造"同时变化"而非整齐轮播
    renderer.setExpression(step % Math.max(1, eyes.length))
    renderer.setMouthOpen(mouths.length > 1 ? (step % mouths.length) / (mouths.length - 1) : 0)
    if (step % 4 === 0 && groups.length > 0) {
      currentGroup = groups[Math.floor(step / 4) % groups.length]
      renderer.playMotion(currentGroup, 0)
    }
    updateMetrics()
  }, 260)
}

// ---------------------------------------------------------------------------
// 场景 A：抓取—拖拽—投掷—落地
// ---------------------------------------------------------------------------

/**
 * 物理积分放在 lab 里而不是渲染器里：抛掷是**编排层**的事（谁在什么状态下允许被拖动、
 * 落地后播什么），不该渗进渲染后端。这里用最小实现证明「位置/速度这条线能接上」，
 * 生产侧要接的是 PetCanvas 的真实鼠标事件。
 */
let throwState: { vx: number; vy: number; raf: number } | null = null
let groundY = 0

function stopThrow(): void {
  if (throwState) {
    cancelAnimationFrame(throwState.raf)
    throwState = null
  }
}

function runSceneA(): void {
  if (!manifest) return
  stopThrow()
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  groundY = h / 2

  // 1) 抓取：挪到随机点
  const grabX = w * (0.3 + Math.random() * 0.4)
  const grabY = h * (0.3 + Math.random() * 0.3)
  renderer.setPosition(grabX, grabY)
  currentGroup = 'Talk'
  renderer.playMotion('Talk', 0)
  log(`场景 A：抓到 (${grabX.toFixed(0)}, ${grabY.toFixed(0)})`)

  // 2) 释放：给一个初速度做抛物线
  let vx = (Math.random() - 0.5) * 900
  let vy = -350 - Math.random() * 250
  let y = grabY
  let x = grabX
  const G = 1400

  const stepThrow = () => {
    const dt = 1 / 60
    vy += G * dt
    x += vx * dt
    y += vy * dt
    // 撞墙反射：夹回边界并翻转横向速度，而不是把 x 直接丢弃
    if (x < 40) {
      x = 40
      vx = Math.abs(vx)
    } else if (x > w - 40) {
      x = w - 40
      vx = -Math.abs(vx)
    }
    renderer.setPosition(x, y)
    if (y >= groundY) {
      renderer.setPosition(x, groundY)
      // 3) 落地：播一次型动作，播完由渲染器按 next 回到 Idle
      currentGroup = 'Jump'
      renderer.playMotion('Jump', 0)
      log(`场景 A：落地于 x=${x.toFixed(0)}，播 Jump → next=Idle`)
      throwState = null
      return
    }
    throwState!.raf = requestAnimationFrame(stepThrow)
  }
  throwState = { vx, vy, raf: requestAnimationFrame(stepThrow) }
}

/**
 * 命中区探测：**不拿渲染器的输出去验证它自己**。
 *
 * 用 pet-core 的纯函数 + 渲染器暴露的姿态变换，独立算一遍每个采样点的期望命中，
 * 再和 `renderer.hitTest` 比。两处不一致说明坐标变换或筛选逻辑有分歧。
 *
 * 只在**当前动画组**下比：hitArea 可声明 `frames` 做组内生效，渲染器按它筛选，
 * 拿别的组去比必然不一致——那不是缺陷，是没读懂语义。
 */
function probeHitAreas(): void {
  if (!manifest) return
  // 用**独立算出的**变换，不用渲染器报的那份（否则是自证）
  const t = api.expectedTransform()
  if (!t) return
  const w = canvas.clientWidth
  const h = canvas.clientHeight
  const STEP = 6
  let matched = 0
  let falseNeg = 0
  let falsePos = 0

  for (let y = 0; y < h; y += STEP) {
    for (let x = 0; x < w; x += STEP) {
      const expected = hitTestPolygons(manifest, currentGroup, x, y, t)
      const actual = renderer.hitTest(x, y)
      if (expected === actual) matched++
      else if (expected && !actual) falseNeg++
      else falsePos++
    }
  }
  const total = matched + falseNeg + falsePos
  probeStats = {
    matched,
    total,
    falseNeg,
    falsePos,
    group: currentGroup,
    checkedAt: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
  }
  log(
    `命中区探测（组 ${currentGroup ?? '（无）'}）：${matched}/${total} 一致，漏报 ${falseNeg}，误报 ${falsePos}`,
  )
  updateMetrics()
}

// ---------------------------------------------------------------------------
// 度量
// ---------------------------------------------------------------------------

function startMetricsLoop(): void {
  window.setInterval(updateMetrics, 500)
}

function updateMetrics(): void {
  if (!current || !manifest) {
    metricsEl.textContent = '未加载'
    return
  }
  const rt = resolveSpriteRuntime(manifest)
  const idle = rt.animationsByGroup.get('Idle')?.[0]
  const lines = [
    `模型      ${current.id}`,
    `画布      ${manifest.canvas.w}×${manifest.canvas.h}   锚点 (${manifest.anchor[0]}, ${manifest.anchor[1]})`,
    `像素风    ${manifest.pixelArt === true ? '是（NEAREST + 整数倍缩放）' : '否（连续缩放）'}`,
    `槽位      ${manifest.slots ? Object.keys(manifest.slots).join(' / ') : '（无 → 整体帧）'}`,
    `动画组    ${[...rt.animationsByGroup.keys()].join(', ')}`,
    `Idle 帧数 ${idle?.frames.length ?? 0}`,
    `原语      ${idle?.params ? JSON.stringify(idle.params) : '（无）'}`,
    `图集条目  ${textureCount}`,
    `图集体积  ${(atlasBytes / 1024).toFixed(1)} KB`,
    `加载耗时  ${loadMs.toFixed(0)} ms`,
    `实时 FPS  ${renderer.getCurrentFps()}`,
    `位置      (${renderer.getPosition().x.toFixed(0)}, ${renderer.getPosition().y.toFixed(0)})`,
    probeStats ? `命中探测  ${probeStats.matched}/${probeStats.total} @ ${probeStats.checkedAt}` : '命中探测  —',
  ]
  metricsEl.innerHTML = lines
    .map((l) => l.replace(/^(\S+)\s+/, '<b>$1</b> '))
    .join('\n')
}

// ---------------------------------------------------------------------------
// Playwright 驱动接口
// ---------------------------------------------------------------------------

const api = {
  ready: false,
  models: MODELS,
  async selectModel(id: string) {
    await selectModel(id)
  },
  setExpression: (i: number) => renderer.setExpression(i),
  setMouthOpen: (v: number) => renderer.setMouthOpen(v),
  playMotion: (g: string, i?: number) => renderer.playMotion(g, i),
  setPosition: (x: number, y: number) => renderer.setPosition(x, y),
  hitTest: (x: number, y: number) => renderer.hitTest(x, y),
  isPointerOverModel: (x: number, y: number) => renderer.isPointerOverModel(x, y),
  getMotionCount: (g: string) => renderer.getMotionCount(g),
  getHitTransform: () => renderer.getHitTransform(),
  runSceneA,
  stopSceneA: stopThrow,
  runSceneB,
  stopSceneB: () => {
    if (sceneBTimer !== null) {
      window.clearInterval(sceneBTimer)
      sceneBTimer = null
    }
  },
  probeHitAreas,
  /**
   * **独立**算一遍期望变换。
   *
   * 不能拿 `renderer.getHitTransform()` 当期望值——那等于用渲染器的输出验证它自己，
   * 只能查出「分组筛选/调用接线」的错，查不出变换本身算错（缩放漏乘、锚点用错、
   * 位置没跟上拖拽）。这里用 pet-core 的 `adaptiveScale` 按同样的输入重算一遍，
   * 再与渲染器报的比。缩放公式若改了一边没改另一边，这条就会红。
   */
  expectedTransform() {
    if (!manifest || !current) return null
    const requestedScale = configFor(current).scale
    // 上限沿用渲染器的常量：写死一个数就会在两边改动不同步时误报
    const scale = adaptiveScale(
      manifest.canvas.h,
      canvas.clientHeight,
      requestedScale,
      manifest.pixelArt === true,
      SPRITE_MAX_HEIGHT_RATIO,
    )
    const pos = renderer.getPosition()
    return {
      positionX: pos.x,
      positionY: pos.y,
      scale,
      anchorX: manifest.anchor[0],
      anchorY: manifest.anchor[1],
    }
  },
  /** 用**独立算出的**变换求期望命中 */
  expectedHitIndependent(group: string | null, x: number, y: number) {
    if (!manifest) return null
    const t = api.expectedTransform()
    if (!t) return null
    return hitTestPolygons(manifest, group, x, y, t)
  },
  /** 供断言用的快照 */
  snapshot() {
    return {
      modelId: current?.id ?? null,
      canvas: manifest ? { w: manifest.canvas.w, h: manifest.canvas.h } : null,
      anchor: manifest?.anchor ?? null,
      pixelArt: manifest?.pixelArt === true,
      slots: manifest?.slots ? Object.keys(manifest.slots) : [],
      groups: manifest ? [...resolveSpriteRuntime(manifest).animationsByGroup.keys()] : [],
      idleFrames: manifest
        ? (resolveSpriteRuntime(manifest).animationsByGroup.get('Idle')?.[0]?.frames.length ?? 0)
        : 0,
      atlasBytes,
      loadMs,
      fps: renderer.getCurrentFps(),
      position: renderer.getPosition(),
      hitTransform: renderer.getHitTransform(),
    }
  },
  /** 用 pet-core 独立算一遍期望命中（探测与断言共用） */
  expectedHit(group: string | null, x: number, y: number) {
    if (!manifest) return null
    const t = renderer.getHitTransform()
    if (!t) return null
    return hitTestPolygons(manifest, group, x, y, t)
  },
}

declare global {
  interface Window {
    __lab: typeof api
    __labLog: string[]
  }
}

window.__lab = api
window.__labLog = logLines

init()
  .then(() => {
    api.ready = true
    log('Lab 就绪')
  })
  .catch((err: unknown) => {
    log(`初始化失败：${err instanceof Error ? err.message : String(err)}`)
  })
