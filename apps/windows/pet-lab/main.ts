/**
 * 口型 / 表情 / 动作 可视化 Lab —— 入口脚本
 *
 * 直接复用生产代码：Live2dPetRenderer + PetOrchestrator + PetEmotionMapper + PetFakeLipSync。
 * 不启动 electron/gateway/agent，用「模拟流式文本」驱动伪口型与表情/动作，
 * 把 renderer.setMouthOpen 包一层实时画成曲线，肉眼验证口型与文字/动作/表情是否协调。
 */
import { Live2dPetRenderer } from '../src/renderer/pet/renderer/live2d/Live2dPetRenderer'
import { PetOrchestrator } from '../src/renderer/pet/orchestrator/PetOrchestrator'
import { PetEmotionMapper } from '../src/renderer/pet/orchestrator/PetEmotionMapper'
import { PET_MOTION_GROUP_UNNAMED } from '../src/renderer/pet/config/pet-model-types'
import type { PetModelConfig } from '../src/renderer/pet/config/pet-model-types'
import type { PetAvatarStatus } from '../src/renderer/pet/orchestrator/PetOrchestrator'
import type { PetMotionPlayedInfo } from '../src/renderer/pet/renderer/types'
import {
  basename,
  fetchModel3Catalog,
  formatMotionGroupLabel,
  type Model3Catalog,
} from './model-catalog'

const $ = (id: string) => document.getElementById(id)!
const logEl = $('log')
const statusEl = $('status')
const readingEl = $('readingText')
const motionFeedbackEl = $('motionFeedback')

function log(msg: string): void {
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  logEl.textContent = `[${t}] ${msg}\n` + logEl.textContent
  if (logEl.textContent.length > 4000) logEl.textContent = logEl.textContent.slice(0, 4000)
}

// ---- 口型曲线 ----
const curve = $('mouthCurve') as HTMLCanvasElement
const cctx = curve.getContext('2d')!
const mouthHistory: number[] = []
const MAX_POINTS = 240
let lastMouth = 0

function pushMouth(v: number): void {
  lastMouth = v
  mouthHistory.push(v)
  if (mouthHistory.length > MAX_POINTS) mouthHistory.shift()
}

// ---- 全链路口型诊断录制：每帧记录整条链的状态，定位"口型不动"断在哪一环 ----
interface DiagSample {
  t: number
  /** renderer.setMouthOpen 写入值（fakeLipSync 输出） */
  mouth: number
  /** 从模型 coreModel 回读的 ParamA（写入是否被动作/物理覆盖） */
  paramA: number | null
  /** ticker 口型接管标志（false=嘴交还动作驱动，写入不生效） */
  lipActive: boolean | null
  /** fakeLipSync 循环是否在跑 */
  fRun: boolean
  /** fakeLipSync 能量 0~1 */
  fEng: number
  /** 活跃保活剩余 ms（>0 应连续张合） */
  fRemain: number
  /** 上游是否已 finish */
  fEnd: boolean
  /** 累计注入字符数 */
  fInj: number
  /** notifyTextDelta 是否被真口型门挡掉 */
  gate: boolean
  /** 本轮是否在文字回复态 */
  txt: boolean
}
const diagSamples: DiagSample[] = []
const DIAG_MAX = 2000
let diagStartTs = 0
/** 喂字事件时间线：记录每次 streamText 喂字的时间戳 + 内容，供比对喂字节奏 vs 口型 */
interface FeedEvent {
  t: number
  chars: number
  text: string
}
const feedEvents: FeedEvent[] = []

function drawCurve(): void {
  const w = (curve.width = curve.clientWidth)
  const h = (curve.height = curve.clientHeight)
  cctx.clearRect(0, 0, w, h)
  // 网格
  cctx.strokeStyle = '#2a2a30'
  cctx.lineWidth = 1
  for (let i = 0; i <= 4; i++) {
    const y = (h * i) / 4
    cctx.beginPath()
    cctx.moveTo(0, y)
    cctx.lineTo(w, y)
    cctx.stroke()
  }
  // 曲线
  cctx.strokeStyle = '#2f7'
  cctx.lineWidth = 2
  cctx.beginPath()
  mouthHistory.forEach((v, i) => {
    const x = (w * i) / MAX_POINTS
    const y = h - v * h
    i === 0 ? cctx.moveTo(x, y) : cctx.lineTo(x, y)
  })
  cctx.stroke()
  // 当前值
  cctx.fillStyle = '#fc8'
  cctx.font = '12px monospace'
  cctx.fillText(`mouth=${lastMouth.toFixed(2)}`, 6, 14)
  // 诊断：回读模型内 ParamA 实际值，判断"写入是否生效/是否被动作覆盖"
  const pa = readParamA()
  if (pa !== null) {
    cctx.fillStyle = pa > 0.15 ? '#2f7' : '#f56'
    cctx.fillText(`ParamA(读回)=${pa.toFixed(2)}`, 110, 14)
  }
  // 全链路快照：每帧记录整条链状态，供复制发出定位断点
  if (diagStartTs === 0) diagStartTs = performance.now()
  const diag = orchestrator?.getFakeLipSyncDiag?.()
  const lipActive = readLipActive()
  diagSamples.push({
    t: Math.round(performance.now() - diagStartTs),
    mouth: Number(lastMouth.toFixed(3)),
    paramA: pa === null ? null : Number(pa.toFixed(3)),
    lipActive,
    fRun: diag?.running ?? false,
    fEng: diag ? Number(diag.energy.toFixed(2)) : 0,
    fRemain: diag?.activeRemainMs ?? 0,
    fEnd: diag?.inputEnded ?? false,
    fInj: diag?.totalInjected ?? 0,
    gate: diag?.gateBlocked ?? false,
    txt: diag?.textReplyActive ?? false,
  })
  if (diagSamples.length > DIAG_MAX) diagSamples.shift()
  requestAnimationFrame(drawCurve)
}

/** 只读诊断：从模型 coreModel 回读 ParamA 当前值（判断口型写入是否被动作/物理覆盖） */
function readParamA(): number | null {
  const core = (
    renderer as unknown as {
      model?: { internalModel?: { coreModel?: { getParameterValueById?: (id: string) => number } } }
    }
  )?.model?.internalModel?.coreModel
  if (!core?.getParameterValueById) return null
  try {
    return core.getParameterValueById('ParamA')
  } catch {
    return null
  }
}

/** 只读诊断：读取渲染器 ticker 口型接管标志（false=写入不生效，嘴归动作驱动） */
function readLipActive(): boolean | null {
  const r = renderer as unknown as { isLipSyncActive?: () => boolean }
  return typeof r?.isLipSyncActive === 'function' ? r.isLipSyncActive() : null
}
requestAnimationFrame(drawCurve)

// ---- 加载注册表 + 模型 ----
let renderer: Live2dPetRenderer
let orchestrator: PetOrchestrator
let mapper: PetEmotionMapper
let modelConfig: PetModelConfig
let registry: RegistryFile
let modelCatalog: Model3Catalog | null = null
let switchingModel = false

interface RegistryFile {
  models: PetModelConfig[]
  defaultModelId: string
}

/** 将 registry 相对路径拼成中间件可达的绝对 URL */
function toModelUrl(relativeUrl: string): string {
  return `/pet-models/${relativeUrl}`
}

/** 从 registry 配置构建带绝对 modelUrl 的运行时配置 */
function buildRuntimeConfig(config: PetModelConfig): PetModelConfig {
  return { ...config, modelUrl: toModelUrl(config.modelUrl) }
}

/** 从 registry 读取 actionMotions 映射 */
function readActionMotions(
  config: PetModelConfig,
): Record<string, { group: string; index?: number }> {
  const rawActions =
    (config as unknown as { actionMotions?: Record<string, { group: string; index?: number }> })
      .actionMotions ?? {}
  const actionMotions: Record<string, { group: string; index?: number }> = {}
  for (const [tag, entry] of Object.entries(rawActions)) {
    actionMotions[tag] = { group: entry.group, index: entry.index }
  }
  return actionMotions
}

/** 重建 PetEmotionMapper（模型切换后 emotionMap / 回调需更新） */
function rebuildMapper(): void {
  mapper = new PetEmotionMapper(
    modelConfig.emotionMap,
    (index, name) => orchestrator.setExpression(index, name),
    600,
    (tag, atChar) => orchestrator.playActionMotion(tag, atChar),
  )
}

/** 将编排器与 registry 配置同步（动作映射、模型元数据） */
function syncOrchestratorConfig(): void {
  orchestrator.setModelConfig(modelConfig)
  orchestrator.setActionMotions(readActionMotions(modelConfig))
}

/** 在模型信息区展示从 model3.json 自动读取的资源摘要 */
function renderModelInfo(catalog: Model3Catalog): void {
  const infoEl = $('modelInfo')
  const motionSummary = catalog.motions
    .reduce<Record<string, number>>((acc, m) => {
      acc[m.groupLabel] = (acc[m.groupLabel] ?? 0) + 1
      return acc
    }, {})
  const motionLines = Object.entries(motionSummary)
    .map(([g, n]) => `  ${g}: ${n}`)
    .join('\n')
  infoEl.textContent =
    `表情: ${catalog.expressions.length} 个\n` +
    `动作: ${catalog.motions.length} 个（${Object.keys(motionSummary).length} 组）\n` +
    (motionLines ? `${motionLines}\n` : '') +
    `口型参数: ${catalog.lipSyncParams.join(', ') || '(未声明)'}\n` +
    `点击区域: ${catalog.hitAreas.length ? catalog.hitAreas.map((h) => h.id).join(', ') : '(无)'}`
}

/** 填充模型下拉框 */
function populateModelSelect(): void {
  const select = $('modelSelect') as HTMLSelectElement
  select.innerHTML = ''
  for (const m of registry.models) {
    const opt = document.createElement('option')
    opt.value = m.id
    opt.textContent = `${m.name} (${m.id})`
    if (m.id === modelConfig.id) opt.selected = true
    select.appendChild(opt)
  }
}

/** 切换模型：重载 Live2D 资源并刷新手动测试 chips */
async function switchModel(modelId: string): Promise<void> {
  if (switchingModel) return
  const next = registry.models.find((m) => m.id === modelId)
  if (!next || next.id === modelConfig.id) return

  switchingModel = true
  const select = $('modelSelect') as HTMLSelectElement
  select.disabled = true
  try {
    stopStream()
    orchestrator.endTextReply(true)
    mapper.reset()
    resetReading()

    modelConfig = next
    const cfg = buildRuntimeConfig(modelConfig)
    log(`切换模型: ${cfg.id} …`)
    await renderer.loadModel(cfg)

    syncOrchestratorConfig()
    rebuildMapper()

    modelCatalog = await fetchModel3Catalog(cfg.modelUrl)
    renderModelInfo(modelCatalog)
    bindManualChips(modelCatalog)

    log(`模型已切换: ${cfg.id}（表情 ${modelCatalog.expressions.length} / 动作 ${modelCatalog.motions.length}）`)
  } catch (e) {
    log(`切换失败: ${e instanceof Error ? e.message : String(e)}`)
  } finally {
    select.disabled = false
    switchingModel = false
  }
}

async function boot(): Promise<void> {
  registry = await fetch('/pet-models/registry.json').then((r) => r.json())
  modelConfig = registry.models.find((m) => m.id === registry.defaultModelId) ?? registry.models[0]!
  const cfg = buildRuntimeConfig(modelConfig)

  const canvas = $('petCanvas') as HTMLCanvasElement
  renderer = new Live2dPetRenderer()
  await renderer.init({ canvas, width: canvas.clientWidth, height: canvas.clientHeight })

  // 关键：包裹 setMouthOpen / releaseLipSync，把口型开度实时画进曲线
  const origSetMouth = renderer.setMouthOpen.bind(renderer)
  renderer.setMouthOpen = (v: number) => {
    pushMouth(v)
    origSetMouth(v)
  }
  const origRelease = renderer.releaseLipSync.bind(renderer)
  renderer.releaseLipSync = () => {
    pushMouth(0)
    origRelease()
  }

  await renderer.loadModel(cfg)
  log(`模型已加载: ${cfg.id}`)

  orchestrator = new PetOrchestrator(renderer)
  syncOrchestratorConfig()
  orchestrator.setStatusListener(renderStatus)
  // 朗读进度 → 卡拉OK式高亮已读文字（与口型曲线时间对齐）
  orchestrator.setReadingProgressListener((charsRead) => renderReading(charsRead))
  // 动作实际播放（真正开始才触发）→ 手动触发反馈"是否成功"
  orchestrator.setDebugMotionListener((info) => onMotionPlayed(info))
  // Lab 默认关闭随机待机：播完保持静止，便于观察（可用复选框开启）
  orchestrator.setEnableIdleMotion(($('idleToggle') as HTMLInputElement).checked)

  rebuildMapper()

  modelCatalog = await fetchModel3Catalog(cfg.modelUrl)
  populateModelSelect()
  renderModelInfo(modelCatalog)
  bindManualChips(modelCatalog)

  const modelSelect = $('modelSelect') as HTMLSelectElement
  modelSelect.addEventListener('change', () => {
    void switchModel(modelSelect.value)
  })

  // 编排器需要 start() 订阅事件并进入待机；lab 无 PetBus 事件源，仅用它的待机/口型调度
  orchestrator.start()
  log('编排器已启动，进入待机')
}

// ---- 朗读文字（卡拉OK式高亮）：清洁全文 + 已读字符数对齐口型曲线 ----
let cleanFullText = ''

function resetReading(): void {
  cleanFullText = ''
  readingEl.innerHTML = '（朗读中…）'
}

function appendCleanText(clean: string): void {
  cleanFullText += clean
}

/** 朗读进度回调：按已读字符数把"已读"部分高亮，未读部分灰显，末尾闪烁光标 */
function renderReading(charsRead: number): void {
  if (!cleanFullText) return
  const n = Math.max(0, Math.min(cleanFullText.length, Math.floor(charsRead)))
  const read = cleanFullText.slice(0, n)
  const rest = cleanFullText.slice(n)
  readingEl.innerHTML =
    `<span class="read">${escapeHtml(read)}</span>` +
    `<span class="cursor">|</span>` +
    `<span>${escapeHtml(rest)}</span>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;'))
}

// ---- 动作播放反馈：手动/流式触发后，动作真正播放才回调，显示 ✓；一定时间无回调判为 ✗ ----
let pendingMotionTag: string | null = null
let motionTimeout: ReturnType<typeof setTimeout> | null = null

function expectMotion(tag: string): void {
  pendingMotionTag = tag
  if (motionTimeout !== null) clearTimeout(motionTimeout)
  motionFeedbackEl.innerHTML = `动作反馈：<span class="metric">${tag}</span> 触发中…`
  // 800ms 内无实际播放回调 → 判为被拦截/无此动作
  motionTimeout = setTimeout(() => {
    if (pendingMotionTag === tag) {
      motionFeedbackEl.innerHTML = `动作反馈：<span class="fail">✗ ${tag} 未播放（被优先级拦截或无此动作组）</span>`
      pendingMotionTag = null
    }
  }, 800)
}

function onMotionPlayed(info: PetMotionPlayedInfo): void {
  const file = info.fileName ?? '(unknown)'
  if (motionTimeout !== null) clearTimeout(motionTimeout)
  pendingMotionTag = null
  motionFeedbackEl.innerHTML = `动作反馈：<span class="ok">✓ 已播放</span> group=<span class="metric">${info.group}</span> idx=${info.index} file=<span class="metric">${file}</span>`
  log(`动作已播放: group=${info.group} idx=${info.index} file=${file}`)
}

function renderStatus(s: PetAvatarStatus): void {
  statusEl.innerHTML =
    `phase:      <span class="metric">${s.phase}</span>\n` +
    `motionKind: <span class="metric">${s.motionKind ?? '-'}</span>\n` +
    `motionGrp:  <span class="metric">${s.motionGroup ?? '-'}</span>\n` +
    `motionFile: <span class="metric">${s.motionDetail ?? '-'}</span>\n` +
    `expression: <span class="metric">${s.expressionKey ?? '-'} (idx ${s.expressionIndex ?? '-'})</span>\n` +
    `idleRandom: <span class="metric">${s.idleMotionEnabled}</span>  cooldown: <span class="metric">${s.postDialogueCooldown ?? false}</span>`
}

// ---- 模拟流式喂字：把整段文本按小块切开，定时喂给 mapper + orchestrator ----
let feedTimer: ReturnType<typeof setInterval> | null = null
/** 当前文字输出速度（ms/块），由滑块调节 */
let feedIntervalMs = 120

function startTextReply(): void {
  mapper.reset()
  resetReading()
  // useRealVoice=false：纯伪口型（lab 无 TTS 音频）
  orchestrator.startTextReply(false)
}

function streamText(fullText: string, chunkSize = 2, intervalMs = feedIntervalMs): void {
  stopStream()
  startTextReply()
  // 重置诊断缓冲：新一轮从头记录，避免混入上一轮
  diagSamples.length = 0
  feedEvents.length = 0
  diagStartTs = performance.now()
  let i = 0
  log(`开始流式喂字: "${fullText}" @ ${intervalMs}ms/块`)
  feedTimer = setInterval(() => {
    if (i >= fullText.length) {
      stopStream()
      orchestrator.endTextReply(false) // 自然结束：伪口型读完 backlog 后自停
      log('文本喂完，endTextReply(自然收尾)')
      return
    }
    const delta = fullText.slice(i, i + chunkSize)
    i += chunkSize
    const clean = mapper.feed(delta) // 解析表情/动作标签，返回清洁文本
    if (clean) {
      appendCleanText(clean) // 累积清洁全文，供卡拉OK高亮
      orchestrator.notifyTextDelta(clean) // 清洁文本长度驱动伪口型 backlog
      // 记录喂字事件时间戳，供比对"喂字节奏 vs 口型活跃"
      feedEvents.push({
        t: Math.round(performance.now() - diagStartTs),
        chars: clean.length,
        text: clean,
      })
    }
  }, intervalMs)
}

function stopStream(): void {
  if (feedTimer !== null) {
    clearInterval(feedTimer)
    feedTimer = null
  }
}

// ---- 4 个固定场景（intervalMs 省略 → 用滑块当前速度）----
const SCENES: Record<string, () => void> = {
  'idle-talk': () => {
    // 静止 + 说话：纯文本无标签，只驱动口型，不触发动作/表情
    streamText('大家好呀我是猫猫今天想和你聊聊天说说话你听我说哦', 2)
  },
  'motion-talk': () => {
    // 动作 + 说话：文本内嵌动作标签，读到位置触发动作，口型持续
    streamText('你好呀[motion:挥手]很高兴见到你我们来玩个游戏吧[motion:开心跳]好不好呀', 2)
  },
  'expr-talk': () => {
    // 表情 + 说话：文本内嵌表情标签，切换表情，口型持续
    streamText('[joy]哇太棒啦我好开心呀[shy]不过人家还是有点害羞呢[smile]嘿嘿', 2)
  },
  'motion-expr-talk': () => {
    // 动作 + 表情 + 说话：三者叠加
    streamText('[joy]今天真开心[motion:开心跳]我们一起庆祝吧[shy][motion:卖萌]人家最喜欢你啦', 2)
  },
  stop: () => {
    stopStream()
    orchestrator.endTextReply(true) // 硬停
    mapper.reset()
    resetReading()
    log('已停止并归位')
  },
}

// ---- 绑定 UI ----
document.querySelectorAll<HTMLButtonElement>('.scenario-btn[data-scene]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const scene = btn.dataset.scene!
    SCENES[scene]?.()
  })
})

$('feedCustom').addEventListener('click', () => {
  const text = ($('customText') as HTMLInputElement).value.trim()
  if (text) streamText(text, 2)
})

// 文字输出速度滑块（ms/块，越小越快）
const speedInput = $('feedSpeed') as HTMLInputElement
const speedLabel = $('speedLabel')
speedInput.addEventListener('input', () => {
  feedIntervalMs = Number(speedInput.value)
  speedLabel.textContent = `${feedIntervalMs}ms/块`
})

// 随机待机动作开关（默认关闭 = 播完保持静止）
const idleToggle = $('idleToggle') as HTMLInputElement
idleToggle.addEventListener('change', () => {
  orchestrator.setEnableIdleMotion(idleToggle.checked)
  log(`随机待机动作: ${idleToggle.checked ? '开启' : '关闭（播完保持静止）'}`)
})

// 复制全链路口型诊断数据，粘贴给分析
$('copyDiag').addEventListener('click', async () => {
  // 降采样：每 3 帧取 1 条，减小体积但保留趋势（约覆盖最近 ~2400 帧）
  const stride = 3
  const sampled = diagSamples.filter((_, i) => i % stride === 0)
  const payload = {
    note: '全链路口型诊断。断点判读：喂字后若 fRun=false→循环没跑；fRemain>0 却 mouth≈0→算了没输出；mouth>0 但 paramA≈0→写入被动作覆盖；lipActive=false→ticker 没接管；gate=true→喂字被真口型门挡掉丢弃。',
    fieldLegend: {
      t: '相对喂字开始的毫秒',
      mouth: 'setMouthOpen 写入值(fakeLipSync 输出)',
      paramA: '模型回读 ParamA(写入是否被覆盖)',
      lipActive: 'ticker 口型接管标志',
      fRun: 'fakeLipSync 循环在跑',
      fEng: 'fakeLipSync 能量',
      fRemain: '活跃保活剩余ms(>0应连续动)',
      fEnd: '上游已finish',
      fInj: '累计注入字符数',
      gate: 'notifyTextDelta 被真口型门挡掉',
      txt: '文字回复态',
    },
    feedIntervalMs,
    feedEvents, // [{ t, chars, text }] 喂字时间线
    sampleStride: stride,
    sampleCount: sampled.length,
    samples: sampled,
  }
  const text = JSON.stringify(payload, null, 2)
  try {
    await navigator.clipboard.writeText(text)
    log(`已复制 ${sampled.length} 条全链路样本 + ${feedEvents.length} 条喂字事件到剪贴板`)
  } catch {
    // 剪贴板 API 不可用时回退到日志区，用户手动选择复制
    logEl.textContent = text
    log('剪贴板不可用，诊断数据已输出到日志区，请手动全选复制')
  }
})

/** 清空容器并创建可点击 chip */
function clearAndCreateChip(
  container: HTMLElement,
  label: string,
  className: string,
  onClick: () => void,
  title?: string,
): void {
  const chip = document.createElement('span')
  chip.className = `chip ${className}`
  chip.textContent = label
  if (title) chip.title = title
  chip.onclick = onClick
  container.appendChild(chip)
}

/** 绑定手动测试 chips：模型资源（model3.json）+ 注册表标签（emotionMap / actionMotions） */
function bindManualChips(catalog: Model3Catalog): void {
  const modelExprRow = $('modelExprChips')
  const modelMotionRow = $('modelMotionChips')
  const registryExprRow = $('registryExprChips')
  const registryMotionRow = $('registryMotionChips')
  modelExprRow.innerHTML = ''
  modelMotionRow.innerHTML = ''
  registryExprRow.innerHTML = ''
  registryMotionRow.innerHTML = ''

  // 模型表情：直接按 model3.json 索引播放
  for (const expr of catalog.expressions) {
    const fileLabel = basename(expr.file)
    clearAndCreateChip(
      modelExprRow,
      `${expr.name} [${expr.index}]`,
      'model',
      () => {
        orchestrator.setExpression(expr.index, expr.name)
        log(`模型表情: ${expr.name} → index=${expr.index}`)
      },
      fileLabel,
    )
  }

  // 模型动作：按组名 + 索引播放（空串组用 $unnamed 占位符）
  for (const motion of catalog.motions) {
    const fileLabel = basename(motion.file)
    const playGroup = motion.group === '' ? PET_MOTION_GROUP_UNNAMED : motion.group
    clearAndCreateChip(
      modelMotionRow,
      `${motion.groupLabel}[${motion.index}] ${fileLabel.replace('.motion3.json', '')}`,
      'model',
      () => {
        expectMotion(`${motion.groupLabel}[${motion.index}]`)
        renderer.playMotion(playGroup, motion.index)
        log(`模型动作: ${formatMotionGroupLabel(motion.group)}[${motion.index}] file=${fileLabel}`)
      },
      `${motion.groupLabel} index=${motion.index}\n${motion.file}`,
    )
  }

  // 注册表表情标签：emotionMap 英文主键去重
  const seenExpr = new Set<number>()
  for (const [name, idx] of Object.entries(modelConfig.emotionMap)) {
    if (seenExpr.has(idx) || !/^[a-z]/i.test(name)) continue
    seenExpr.add(idx)
    const aliases = Object.entries(modelConfig.emotionMap)
      .filter(([, i]) => i === idx)
      .map(([k]) => k)
      .slice(0, 6)
      .join(', ')
    clearAndCreateChip(
      registryExprRow,
      `${name}(${idx})`,
      'registry',
      () => {
        orchestrator.setExpression(idx, name)
        log(`注册表表情: [${name}] → ${idx}`)
      },
      `别名: ${aliases}`,
    )
  }

  // 注册表动作标签：actionMotions 全部展示
  const actionMotions = readActionMotions(modelConfig)
  const actionDescs =
    (modelConfig as unknown as { actionMotions?: Record<string, { description?: string }> })
      .actionMotions ?? {}
  for (const [tag, entry] of Object.entries(actionMotions)) {
    const desc = actionDescs[tag]?.description ?? ''
    clearAndCreateChip(
      registryMotionRow,
      tag,
      'registry',
      () => {
        expectMotion(tag)
        orchestrator.playActionMotion(tag)
        log(`注册表动作: [motion:${tag}]`)
      },
      desc ? `${entry.group} idx=${entry.index ?? '随机'}\n${desc}` : `${entry.group} idx=${entry.index ?? '随机'}`,
    )
  }
}

boot().catch((e) => {
  log(`启动失败: ${e instanceof Error ? e.message : String(e)}`)
  statusEl.textContent = `启动失败: ${e instanceof Error ? e.stack : String(e)}`
})
