/**
 * PetCanvas - 宠物渲染画布组件
 *
 * 设计依据：00-修订版设计 §2.3（穿透 hitTest）/ §4（WebGL 检测）
 *
 * 职责：
 *  - 全屏透明 canvas，挂载 Live2dPetRenderer
 *  - WebGL 检测 → 不支持回调降级
 *  - Cubism Core 加载 → 缺失回调降级
 *  - 模型加载（从注册表）
 *  - mousemove → hitTest → reportHover（穿透控制）
 *  - 点击命中区域 → 触发 tapMotion
 *  - 拖拽移动模型位置
 *
 * 通过 ref 暴露 renderer 给上层（PetLipSync/PetOrchestrator 在 Phase 2 使用）。
 */

import React, { useEffect, useRef, useImperativeHandle, forwardRef, useState } from 'react'
import { Live2dPetRenderer, CubismCoreMissingError } from '../renderer/live2d/Live2dPetRenderer'
import { SpritePetRenderer } from '../renderer/sprite/SpritePetRenderer'
import type { PetRendererProvider } from '../renderer/types'
import { checkWebGLSupport } from '../utils/webgl-check'
import { ensureCubismCore } from '../utils/cubism-core-loader'
import { getPetModelConfig } from '../config/pet-model-registry'
import type { PetModelConfig } from '../config/pet-model-types'
import { PET_MOTION_GROUP_UNNAMED } from '../config/pet-model-types'
import { estimateVelocity, isThrowable, stepThrow, dragBoundsOf, shouldRefuse, type AmbientTuningInput, type DragSample, type ThrowBody, type PetPose, type TraitValues } from '@mtbot/pet-core'
import { PetWanderDriver } from '../behavior/PetWanderDriver'
import { petMetrics } from '../telemetry/pet-metrics'
import type { PetHoverUpdate } from '../../../shared/pet-mode'
import { spawnClickFireworks, disposePetParticles } from './pet-particles'

const log = {
  info: (...args: unknown[]) => console.log('[PetCanvas]', ...args),
  warn: (...args: unknown[]) => console.warn('[PetCanvas]', ...args),
  error: (...args: unknown[]) => console.error('[PetCanvas]', ...args),
}

/**
 * 点击回应期间让自主行为让位多久（毫秒）。
 *
 * 为什么是定时解除、而不是等"动作播完"信号：渲染器的 `setMotionPlayedListener`
 * 是**单播**且已被编排器占用（它要用它更新可观测状态），画布这边加不上第二个监听者。
 *
 * 2.5 秒的来历：Shimeji 的 GREET 是 8 帧、钉完 idle 端点后 10 帧 ≈ 1.1 秒，
 * 留一倍余量。多停的那点时间观感上是"它回应完了，愣一下再走"，不会显得卡住。
 */
const TAP_AMBIENT_HOLD_MS = 2500

/**
 * 按住多久才算「抓住」。
 *
 * **点击与抓取原本是同一个手势**（`mousedown` 即进入拖拽态），于是"想点它一下"
 * 必然先把它拖歪一点——短按和拖拽在体感上分不开。现在按住够久才算抓：
 * 短按是点击（宠物蹦一下），按满这个时长才跟手。
 *
 * 100ms。**这个值是照手感定的，不是照"多久才够区分"**：3 秒 → 1.5 秒 → 1 秒 →
 * 100ms 一路调下来，越长越像坏了——用户按一两秒就拖、发现没反应，以为是故障。
 * 100ms 已经足够把短按和按住分开（人手点一下约 100~200ms）。
 */
const GRAB_HOLD_MS = 100

/**
 * 摸头（长按）的时间参数（第二期 T2.4 / 设计 §8.3.1）。
 *
 * **长按与抓取是两个手势，靠"按住不动"区分**：抓取 100ms 就成立（用户马上就拖），
 * 摸头要按住**不动**才成立。判据里带位移容差，是因为手指/手腕按住时必然有几像素抖动。
 *
 * 起手 800ms：比点击窗口长得多（不会误触），又短到"按下去它就呼噜"来得及。
 * 「呼~」放在 3 秒：设计原文是"持续 3 秒后气泡"——**响应先给，话后到**，
 * 反过来（3 秒才有任何反应）用户会以为没生效而松手。
 */
const PET_START_MS = 800
const PET_BUBBLE_MS = 3000
/** 按住期间的位移容差：超过它说明用户其实在拖，退出摸头交给拖拽 */
const PET_MOVE_TOLERANCE_PX = 8
/**
 * 摸头**已经开始**之后，再移动这么多就转成拖拽。
 *
 * 没有它就是一个 UX 陷阱：用户按住了想等它呼噜、结果又想拖，会发现"拖不动"——
 * 因为摸头状态把跟手关掉了。容差比上面大，是为了不把"手腕晃了一下"判成拖拽。
 */
const PET_EXIT_DRAG_PX = 24

/**
 * 抛掷时的能量保留比例（撞左右边与屏幕上沿都走它）。
 *
 * `pet-core` 的默认是 0.55，这里按用户要求**加 50% 弹性**（"丢宠物还是保留，
 * 可以增加 50% 的弹性"）。只在**抛掷**这一条路上覆盖，不动默认值——
 * 自己从墙上松手掉下来（`PetWanderDriver.stepFall`）走的是同一个 `stepThrow`，
 * 那种"啪一下落地"不该突然变弹。
 *
 * ⚠ 不写 `0.55 * 1.5` 而是写死数值：默认值在 pet-core 里，改它的时候这里**不会**
 * 跟着变，写算式会让人以为会。两者的关系在注释里说清楚就够了。
 */
const THROW_RESTITUTION = 0.825

/**
 * 指针交互的让位来源名。
 *
 * **一次指针交互只用一个名字**：`mousedown` 记下它，各条 `mouseup` 分支
 * （点击 / 原地落下 / 抛掷落地）都解除它。用多个名字会泄漏——
 * 记的人与解除的人对不上，宠物就永久卡在让位状态（实测踩过，见 driver 的 `holds` 注释）。
 */
const AMBIENT_HOLD_POINTER = 'pointer'

/** 开关（`ambientEnabled`）的让位来源名，与指针交互分开记账 */
const AMBIENT_HOLD_DISABLED = 'ambient-disabled'

/**
 * 文字气泡的让位来源名。
 *
 * 气泡是一句话、要读，宠物一边走一边拖着它，用户根本读不了（2026-09-23 用户
 * 实测要求「文字气泡需要停止宠物当前动作」）。**头顶符号不占这个名字** —— 那是个
 * 状态灯，扫一眼就够，为它把宠物钉住是打扰。
 */
const AMBIENT_HOLD_BUBBLE = 'bubble'

/**
 * 编排器播**一次性动作**（打哈欠 / 伸懒腰 / 挠头 / 雀跃 / 蔫 / 张望）时的让位来源名。
 *
 * **必须与 `AMBIENT_HOLD_POINTER` 分开记账**：`PetWanderDriver` 的让位是**按 reason**
 * 记的，两个来源混用一个名字，先解除的那个会把另一个也解掉（这条纪律来自一次
 * 真实事故——计数式让位每点一下泄漏一个，把宠物永久钉死，详见
 * `PetWanderDriver.test.ts` 的文件头）。
 */
const AMBIENT_HOLD_ONE_SHOT = 'one-shot'

/** 降级状态：上层据此显示提示 */
export type PetCanvasDegradeReason =
  | { kind: 'webgl'; message: string }
  | { kind: 'core-missing'; message: string }
  | { kind: 'model-load-failed'; message: string }

export interface PetCanvasProps {
  /** 模型 ID（空取默认） */
  modelId?: string
  /** 降级回调（WebGL 不支持 / Core 缺失 / 模型加载失败） */
  onDegrade?: (reason: PetCanvasDegradeReason) => void
  /** 模型加载成功回调 */
  onModelLoaded?: (config: PetModelConfig) => void
  /**
   * 物理交互事件（场景 A 的抓取与落地）。
   *
   * 由上层转给编排器播「被拎起」/「落地」动作。**不接也照常工作**——
   * 抛物线与落地是画布自己的事，动作衔接才是编排的事，两者解耦。
   */
  onInteraction?: (event: PetInteractionEvent) => void
  /**
   * 自主活动变化（空闲游走，仅 sprite 后端）。
   *
   * **只报「该走/该坐/该站」，不报动作组名**：播哪个组是编排器的事
   * （它还要考虑对话优先级、闲置阶段、模型有没有那一组）。画布越权直接
   * `playMotion` 会和编排器抢同一个入口。
   */
  onAmbientActivity?: (pose: PetPose) => void
  /**
   * 宠物性格与情绪（第二期），喂给自主行为驱动的权重表。
   *
   * **不是驱动生命周期的依赖**：换性格不该把驱动停掉重来（那会把它从当前位置
   * 拽回地面线重新计时）。单独一个 effect 调 `setTuning` 就够了。
   */
  petTuning?: {
    /**
     * 五维原值。驱动只用 `openness` / `extraversion`，拒绝判定用 `agreeableness`——
     * 两者读同一份，不各自再取一次（多取一次就会有"权重变了但拒绝没变"的错位）。
     */
    traits: TraitValues | null
    /** 宠物自己的情绪；第二期恒为 `null`（第四期才有来源），拒绝判定按基线算 */
    mood: AmbientTuningInput | null
  }
  /**
   * 拒绝了这次互动（第二期 T2.3）。
   *
   * 由上层转给编排器播「躲开」。**画布不自己 `playMotion`**——动作入口只有一个写者，
   * 与 `onAmbientActivity` 同一条边界。
   */
  onRefusal?: () => void
  /**
   * 摸头（长按）阶段（第二期 T2.4）。
   *
   * 报**阶段**而不是文案：说什么话是 UI 的事，画布只负责"按住不动"这个手势的识别。
   * `start` / `end` 由编排器换成 `Purr` 循环组与还原，`bubble` 由外层冒一句「呼~」。
   */
  onPetting?: (phase: 'start' | 'bubble' | 'end') => void
  /**
   * 右键宠物（屏幕坐标，CSS 像素）。
   *
   * **点在空白处不触发**——宠物窗口是全屏的，不判就等于整个桌面右键都弹宠物菜单。
   * 右键也不参与抓取：`onMouseDown/Up` 只认左键。
   */
  onContextMenu?: (x: number, y: number) => void
  /**
   * 自主行为总开关（仅 sprite 后端，默认开）。
   *
   * 关掉后宠物不再自己走动，但**进行中的让位不受影响**（拖拽/抛掷照常）——
   * 它是"要不要自己动"，不是"要不要能动"。
   */
  ambientEnabled?: boolean
  /**
   * 文字气泡挂着时**原地定格**（仅 sprite 后端，默认不）。
   *
   * 与 `ambientEnabled` 是两回事：那个是"要不要自己动"的用户开关（关掉后宠物
   * 永远不动），这个是"这一刻先别动"的临时让位（气泡撤下就还回去）。
   *
   * 让位用 `keepPose`：宠物在墙上/天花板上时不能重置成站立，否则它会站着贴墙。
   */
  bubbleHold?: boolean
}

/** 物理交互事件 */
export type PetInteractionEvent =
  | { type: 'picked' }
  /** 松手且速度够快，接下来是抛物线飞行（`landed` 会在这之后到达） */
  | { type: 'thrown' }
  | { type: 'landed'; x: number; y: number }

/** 暴露给上层的句柄 */
export interface PetCanvasHandle {
  getRenderer(): PetRendererProvider | null
  /**
   * 一次性动作期间按住自主行为，`ms` 后自动交还（编排器经宿主调用）。
   *
   * 与 `holdAmbientForTap` 是**同一套让位**，但记账分开了（见 `AMBIENT_HOLD_ONE_SHOT`），
   * 而且这里**自己 suspend**——点击那条路的 suspend 是 `onMouseDown` 做的
   *（一次指针交互只该有一个让位来源）。
   *
   * 不按住的后果：宠物一边平移一边播打哈欠，脚不动、人在飘（见 `holdAmbientForTap`
   * 上方那段注释——它就是为同一个病加上的）。
   */
  holdAmbientForOneShot(ms: number): void
}

/**
 * 鼠标**刚进入**模型时要通知谁（设计 §8.3.1「鼠标靠近 → 转头看鼠标」）。
 *
 * 为什么挂在 `reportModelHover` 这个咽喉点上，而不是去改那十来个调用处：
 * hover 的布尔值是**到处算的**（mousedown、mouseup、拖拽、抛掷的每一帧都在报），
 * 在调用处加边沿判断等于把同一段逻辑抄十几遍，还一定会漏掉其中几个。
 * 这里做**唯一的边沿检测**，调用处一行都不用动。
 *
 * ⚠ 与 `cachedTapModelConfig` 同样是模块级的：`reportModelHover` 是**模块函数**
 * （不在组件闭包里），够不到 React 的 ref。
 */
let onModelApproach: (() => void) | null = null
let lastReportedHover = false

/** 注册"鼠标刚进入模型"的通知（宿主接到编排器上）。传 null 解绑。 */
export function setOnModelApproach(cb: (() => void) | null): void {
  onModelApproach = cb
}

function reportModelHover(isHovering: boolean): void {
  // 只认**上升沿**：鼠标在模型上移动时这个函数每帧都在调，不判边沿的话
  // 「靠近」会变成一个每帧触发的高频事件
  if (isHovering && !lastReportedHover) onModelApproach?.()
  lastReportedHover = isHovering
  window.electronAPI?.pet?.reportHover({
    componentId: 'live2d-model',
    isHovering,
  } satisfies PetHoverUpdate)
}

/** 将鼠标事件坐标转换为 canvas 局部坐标（CSS 像素，与 PIXI stage 一致） */
function toCanvasLocal(e: MouseEvent, canvas: HTMLCanvasElement): { x: number; y: number } {
  const rect = canvas.getBoundingClientRect()
  return {
    x: e.clientX - rect.left,
    y: e.clientY - rect.top,
  }
}

export const PetCanvas = forwardRef<PetCanvasHandle, PetCanvasProps>(
  ({ modelId, onDegrade, onModelLoaded, onInteraction, onAmbientActivity, petTuning, onRefusal, onPetting, onContextMenu, ambientEnabled = true, bubbleHold = false }, ref) => {
    /**
     * 宿主容器。**React 只管这个 div，里面的 canvas 由 setup effect 自己创建/替换。**
     *
     * 为什么不让 React 直接渲染 canvas：那样每次重建都得靠 `key` 换元素，而 key 换不换得掉
     * 取决于 reconciliation 的细节。实测靠不住——HMR 场景下元素没被换掉，`setState` 反被
     * 拖进 "Maximum update depth exceeded" 的循环，日志刷到 364 万行。自己
     * `replaceChildren` 是确定性的，不赌框架行为。
     */
    const canvasHostRef = useRef<HTMLDivElement>(null)
    const canvasRef = useRef<HTMLCanvasElement | null>(null)
    const rendererRef = useRef<PetRendererProvider | null>(null)
    /** 模型配置：**必须先于渲染器拿到**，因为后端类型由它决定 */
    const [config, setConfig] = useState<PetModelConfig | null>(null)
    const [ready, setReady] = useState(false)
    /**
     * 渲染器实例 + 它服务的后端（state 里放一份，供 effect 依赖）。
     *
     * **不能只留 ref + 一个 `rendererReady` 布尔**：两者会不一致，实测切后端
     * （live2d→sprite）时出现过 `rendererReady=true` 而 ref 仍为 null 的一帧，模型加载
     * effect 于是提前 return——而它依赖的这两个值此后都不再变化，**永不再试**，
     * 宠物永久空白（「切到精灵图是空白的」那个故障）。
     *
     * 带上 `backend` 是给下游 effect 判断"这个实例是不是当前配置该用的那个"：
     * 切后端时 state 比 ref 慢一拍，那一帧里读到的还是**刚被销毁**的旧实例
     * （症状：换后端时 `loadModel` 打在旧渲染器上，报「渲染器未初始化」并弹降级提示）。
     */
    const [renderer, setRenderer] = useState<{
      instance: PetRendererProvider
      backend: 'live2d' | 'sprite'
    } | null>(null)
    /**
     * 后端类型。**配置未到位前是 null，不能默认成 'live2d'**：
     * 初始化 effect 只依赖它，若默认成 'live2d'，那么「首个模型就是 live2d」时
     * 类型从头到尾没变过，effect 不会跑，渲染器永远不会被创建。
     */
    const rendererType = config?.rendererType ?? null

    /**
     * 回调放进 ref。初始化 effect **不能依赖父组件传来的回调**——父组件每次渲染都可能
     * 给出新的函数身份，effect 就会重跑：先 destroy 再在同一个 canvas 上重建 PIXI，
     * 而那个 canvas 的 WebGL context 刚随 destroy 失效，结果是 init 完立刻
     * 「WebGL context lost」。这正是本文件一直警告的那个坑，实测踩过一次。
     */
    const onDegradeRef = useRef(onDegrade)
    const onModelLoadedRef = useRef(onModelLoaded)
    onDegradeRef.current = onDegrade
    onModelLoadedRef.current = onModelLoaded
    /**
     * 交互回调同样放 ref：它被鼠标 effect 用，而那个 effect 的依赖是 `[ready]`。
     * 直接当依赖会让父组件每次渲染都重装一遍鼠标监听（中途松手/丢失拖拽状态）。
     */
    const onInteractionRef = useRef(onInteraction)
    onInteractionRef.current = onInteraction
    /** 同上：自主活动回调被驱动 effect 持有，不能进依赖数组 */
    const onAmbientActivityRef = useRef(onAmbientActivity)
    onAmbientActivityRef.current = onAmbientActivity

    const onContextMenuRef = useRef(onContextMenu)
    onContextMenuRef.current = onContextMenu
    /**
     * 性格/情绪同样走 ref：拒绝判定在 `mouseup` 处理器里读它，而那个处理器
     * 装在只跑一次的 effect 上——直接闭包捕获会永远读到挂载那一刻的值
     * （表现为"换了个脾气差的模型，点它还是照常回应"）。
     */
    const petTuningRef = useRef(petTuning)
    petTuningRef.current = petTuning
    /** 同上：拒绝回调也只在 mouseup 处理器里读，不能闭包捕获 */
    const onRefusalRef = useRef(onRefusal)
    onRefusalRef.current = onRefusal
    const onPettingRef = useRef(onPetting)
    onPettingRef.current = onPetting

    /**
     * 摸头状态（第二期 T2.4）。三个 ref 各管一件事，不合成一个对象：
     * 它们由不同的手势阶段读写，合起来会出现"清了一个忘了另一个"的半状态。
     */
    /** 起步计时器：按住不动 PET_START_MS 后进入摸头 */
    const petTimerRef = useRef<number | null>(null)
    /** 气泡计时器：进入摸头后再过 PET_BUBBLE_MS 冒「呼~」 */
    const petBubbleTimerRef = useRef<number | null>(null)
    /** 是否正处于摸头中（此时跟手被关掉，见 PET_EXIT_DRAG_PX） */
    const pettingRef = useRef(false)
    /** 按下的起点，用来量"动没动" */
    const petOriginRef = useRef<{ x: number; y: number } | null>(null)

    /** 退出摸头：清计时器 + 上报 end。重复调用是无害的（没在摸头就什么都不做） */
    const stopPetting = (): void => {
      if (petTimerRef.current !== null) {
        clearTimeout(petTimerRef.current)
        petTimerRef.current = null
      }
      if (petBubbleTimerRef.current !== null) {
        clearTimeout(petBubbleTimerRef.current)
        petBubbleTimerRef.current = null
      }
      petOriginRef.current = null
      if (!pettingRef.current) return
      pettingRef.current = false
      onPettingRef.current?.('end')
    }

    /** 开始摸头：只在"按住不动"成立时调用 */
    const startPetting = (): void => {
      if (pettingRef.current) return
      pettingRef.current = true
      log.info(`[petting] 按住不动 ${PET_START_MS}ms，进入摸头`)
      onPettingRef.current?.('start')
      petBubbleTimerRef.current = window.setTimeout(() => {
        petBubbleTimerRef.current = null
        if (!pettingRef.current) return
        log.info(`[petting] 持续 ${PET_BUBBLE_MS}ms，冒一句`)
        onPettingRef.current?.('bubble')
      }, PET_BUBBLE_MS - PET_START_MS)
    }
    /**
     * 拖拽状态。
     *
     * 这里**不记地面线**。它曾经是"拖拽开始时宠物所在的高度"，理由是"用屏幕底部当
     * 地面会让宠物落到一个从没待过的地方"。但那个前提本身是错的——地面线就该是
     * 屏幕（工作区）底边，宠物被举起来之后本来就该落回去。记当时的 y 会让每一次
     * 拖拽都把落点抬高一截，最终形成一条看不见的、越抬越高的地面线（详见
     * `PetWanderDriver.groundY()`）。落点现在固定取 `canvas.clientHeight`。
     *
     * `samples` 供释放时估速度；只看最后两个点会被鼠标事件间隔的不均匀坑到
     * （详见 pet-core 的 estimateVelocity）。
     */
    const dragRef = useRef<{
      /** 指针按在宠物身上（还没到抓取时长也算） */
      pressed: boolean
      /** **已经抓住了**——过了 `GRAB_HOLD_MS` 才开始跟手拖动 */
      active: boolean
      offsetX: number
      offsetY: number
      hit: boolean
      samples: DragSample[]
    }>({
      pressed: false,
      active: false,
      offsetX: 0,
      offsetY: 0,
      hit: false,
      samples: [],
    })
    /** 抛掷中的 rAF 句柄 */
    const throwRef = useRef<number | null>(null)
    /** 空闲游走驱动（仅 sprite 后端）。位置权威见下文的 suspend/resume 互斥 */
    const wanderRef = useRef<PetWanderDriver | null>(null)
    /** 点击回应期间"让位"的定时器（见 TAP_AMBIENT_HOLD_MS） */
    const tapHoldRef = useRef<number | null>(null)
    /** 一次性动作期间"让位"的定时器（见 `AMBIENT_HOLD_ONE_SHOT`） */
    const oneShotHoldRef = useRef<number | null>(null)
    /** "按住多久才算抓住"的定时器（见 GRAB_HOLD_MS） */
    const grabTimerRef = useRef<number | null>(null)
    /** 指针的最近位置。抓取定时器里没有事件对象，要用它重算拖拽偏移 */
    const pointRef = useRef({ x: 0, y: 0 })
    /**
     * "这次拖动已经抱怨过拿不到内容包围盒"。
     *
     * 每次**新的拖动**（mousedown）重置一次，于是每次拖动最多一条日志——
     * 不然指针每动一像素就是一条。
     */
    const warnedNoExtentsRef = useRef(false)

    useImperativeHandle(ref, () => ({
      getRenderer: () => rendererRef.current,
      holdAmbientForOneShot: (ms: number) => {
        const driver = wanderRef.current
        if (!driver) return
        // 自己的 reason 自己 suspend/resume。**不共用 `tapHoldRef`**：那个计时器
        // 由 `onMouseDown` 的 suspend 配套，共用会让两个来源互相解除对方的让位
        //（`PetWanderDriver` 是按 reason 记账的）
        driver.suspend(AMBIENT_HOLD_ONE_SHOT)
        if (oneShotHoldRef.current !== null) clearTimeout(oneShotHoldRef.current)
        oneShotHoldRef.current = window.setTimeout(() => {
          oneShotHoldRef.current = null
          driver.resume(AMBIENT_HOLD_ONE_SHOT)
        }, ms)
      },
    }))

    // 1) 先取配置。后端类型由 rendererType 决定，所以这一步必须排在初始化之前。
    //
    // **不要在这里 setConfig(null)**：那会让 rendererType 短暂变成 null，canvas 的 key
    // 跟着变，于是每次切模型都换一次 canvas 元素、销毁一次 WebGL context。
    // 保留旧配置直到新配置到达；只有后端类型**真的变了**才该换 canvas。
    useEffect(() => {
      let cancelled = false
      // 模型 ID 还没到位时**先不取配置**。挂载那一刻 `currentModelId` 是空串
      // （要靠 usePetMode 的补问走一次 IPC 才拿到），此时取配置的话主进程会回退到
      // **默认模型**——先加载出一只默认宠物，等补问结果到了再整个换掉，
      // 用户看到的是"闪一下变了只宠物"。等依赖里的 modelId 变了，effect 自然会再跑。
      //
      // 兜底：补问失败时主进程那边仍有 `default-pet` 这个默认值，
      // 用户也可以切一次模型把它顶回来，所以这里不会永久卡住。
      if (!modelId) {
        log.info('[config] 模型 ID 未就位，等补问结果')
        return
      }
      log.info(`[config] 开始取模型配置 modelId=${modelId}`)
      void (async () => {
        const cfg = await getPetModelConfig(modelId)
        if (cancelled) {
          log.info(`[config] 取到 ${cfg?.id ?? 'null'}，但已弃用（modelId 又变了）`)
          return
        }
        if (!cfg) {
          log.warn(`[config] 未找到模型配置 modelId=${modelId ?? 'null'}`)
          onDegradeRef.current?.({ kind: 'model-load-failed', message: '未找到模型配置（注册表为空？）' })
          return
        }
        log.info(`[config] 配置就位 ${cfg.id}（rendererType=${cfg.rendererType}）`)
        setConfig(cfg)
      })()
      return () => {
        cancelled = true
      }
    }, [modelId])

    // 2) 按 rendererType 初始化对应后端。
    //
    // 本 effect 每次都自建 canvas（见下面的长注释）。element 的 WebGL context 不可重建，
    // 所以"重新 init"这件事只有换元素这一条路，没有第二条。
    // 依赖只有 `rendererType`：同类型切换不重跑，只走下面"重载模型"的分支。
    useEffect(() => {
      if (!rendererType) return
      const backend = rendererType
      let disposed = false
      const host = canvasHostRef.current
      if (!host) return
      // **每次重新 init 都造一个全新的 canvas 元素。**
      //
      // 一个 canvas 的 WebGL context **不可重建**——规范规定 `getContext()` 永远返回
      // 同一个对象，即使它已经 lost。所以旧渲染器 destroy 之后，在同一个元素上
      // `new PIXI.Application({ view })` 必然拿到坏 context：
      //
      //   实测（2026-09-22，改任何会被 React Refresh 强制重挂载的文件都必现）
      //   [setup] 清理渲染器 → [setup] 开始初始化渲染器
      //   → [init] WebGL context lost
      //   → Uncaught: Invalid value of `0` passed to `checkMaxIfStatementsInShader
      //
      // 后果是宠物窗口白屏并**挡住整个桌面**，用户连退出程序都困难。
      //
      // 元素在这里造、不由 React 渲染，理由见 `canvasHostRef` 的注释。
      const canvas = document.createElement('canvas')
      canvas.style.cssText =
        'position:fixed;inset:0;width:100vw;height:100vh;pointer-events:none;background:transparent;'
      host.replaceChildren(canvas)
      canvasRef.current = canvas
      // 兜底：**真的**丢了 context（GPU 驱动重置、显存耗尽这类）时立刻退回桌面。
      //
      // 渲染器不会自己恢复——`SpritePetRenderer` 只 `preventDefault()` + 停渲染，
      // 没有 `webglcontextrestored` 处理，也就是说它把"我要自己恢复"这句话说了却没做。
      // 而宠物窗口是**全屏 + 置顶**的，留在宠物模式就是让用户对着一块白屏，
      // 连退出程序都困难（用户实测反馈）。宠物可以没有，桌面不能被挡住。
      canvas.addEventListener('webglcontextlost', () => {
        // **只认当前那个元素。** 旧 canvas 在被重建时销毁，同样会派发 contextlost——
        // 那是我们自己拆的，不是故障。不判的话每次 HMR 都会把用户踢回桌面
        //（实测：`[setup] 渲染器初始化完成` 紧跟一条 `context lost —— 退回桌面模式`）。
        if (canvasRef.current !== canvas) return
        log.error('[setup] WebGL context lost —— 退回桌面模式，避免白屏挡住桌面')
        void window.electronAPI?.pet?.switchMode('desktop')
      })
      log.info(`[setup] 开始初始化渲染器（${backend}）`)

      const setup = async () => {
        const webgl = checkWebGLSupport()
        if (!webgl.supported) {
          log.warn(`[setup] WebGL 不支持: ${webgl.reason}`)
          onDegradeRef.current?.({ kind: 'webgl', message: webgl.reason ?? 'WebGL 不可用' })
          return
        }

        // Cubism Core 只服务 Live2D 后端。sprite 后端用普通纹理，不该被专有 Core 的
        // 加载失败连带拖下水——那是两件不相干的事。
        if (rendererType === 'live2d') {
          try {
            await ensureCubismCore()
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err)
            log.warn(`[setup] Cubism Core 加载失败: ${message}`)
            onDegradeRef.current?.({ kind: 'core-missing', message })
            return
          }
          if (disposed) return
        }

        const instance =
          rendererType === 'sprite' ? new SpritePetRenderer() : new Live2dPetRenderer()
        await instance.init({
          canvas,
          width: window.innerWidth,
          height: window.innerHeight,
        })
        if (disposed) {
          log.warn(`[setup] 初始化完成时已被弃用，销毁丢弃（${backend}）`)
          instance.destroy()
          return
        }
        rendererRef.current = instance
        setRenderer({ instance, backend })
        log.info(`[setup] 渲染器初始化完成（${backend}）`)
      }

      void setup()

      return () => {
        disposed = true
        log.info(`[setup] 清理渲染器（${backend}）`)
        rendererRef.current?.destroy()
        rendererRef.current = null
        setRenderer(null)
        setReady(false)
        // canvas 是我们造的，也由我们拆；宿主 div 归 React。
        // 不拆的话，旧元素上的监听器（含上面那个 contextlost 兜底）会一直挂着。
        canvas.remove()
        if (canvasRef.current === canvas) canvasRef.current = null
      }
    }, [rendererType])

    // 3) 模型加载 / 热切换：渲染器就绪后加载配置里的模型（**不碰 WebGL context**）。
    // loadModel 内部已含"卸载旧模型 + 加载新模型"，故切换/切回都安全。
    useEffect(() => {
      // 两道守卫，缺一不可——切后端那一帧里 state 与 ref 是错位的：
      //   · 后端不匹配：config 已换成 live2d，而 state 里还挂着旧的 sprite 实例
      //   · 不是当前实例：cleanup 已把 ref 置空，state 要等下一次渲染才跟上
      // 少任何一道，loadModel 就会打在**刚被销毁**的渲染器上，报「渲染器未初始化」并弹降级提示。
      const backendMismatch = !!renderer && !!config && renderer.backend !== config.rendererType
      const notCurrent = !!renderer && rendererRef.current !== renderer.instance
      log.info(
        `[loadModel] 模型加载 effect 触发：config=${config?.id ?? 'null'} renderer=${renderer?.backend ?? 'null'}` +
          (notCurrent ? '（实例已弃用，跳过）' : backendMismatch ? '（后端不匹配，跳过）' : ''),
      )
      if (!renderer || !config || backendMismatch || notCurrent) return
      let cancelled = false

      const loadModel = async () => {
        try {
          const loadStart = performance.now()
          await renderer.instance.loadModel(config)
          petMetrics.recordModelLoad(performance.now() - loadStart)
          if (cancelled) return
          setTapModelConfig(config)
          setReady(true)
          onModelLoadedRef.current?.(config)
          log.info(`[loadModel] 模型就绪 ${config.id}`)
        } catch (err) {
          if (cancelled) return
          if (err instanceof CubismCoreMissingError) {
            onDegradeRef.current?.({ kind: 'core-missing', message: err.message })
          } else {
            const message = err instanceof Error ? err.message : String(err)
            log.error(`[loadModel] 模型加载失败: ${message}`)
            onDegradeRef.current?.({ kind: 'model-load-failed', message })
          }
        }
      }

      void loadModel()
      return () => {
        cancelled = true
      }
    }, [renderer, config])

    // 视口尺寸变化
    useEffect(() => {
      const onResize = () => {
        rendererRef.current?.resize(window.innerWidth, window.innerHeight)
      }
      window.addEventListener('resize', onResize)
      return () => window.removeEventListener('resize', onResize)
    }, [])

    // 空闲游走（R9）：仅 sprite 后端。
    //
    // 依赖里带 `config?.id`：换模型会重置地面线与缩放，而驱动内部持有旧的 x/y，
    // 必须重建（不是"继续用"——那是另一个坐标系）。带 `renderer` 是因为 state
    // 比 ref 慢一拍，切后端那一帧里读到的可能是刚被销毁的旧实例。
    useEffect(() => {
      if (!ready) return
      const instance = renderer?.instance
      if (!instance || renderer?.backend !== 'sprite') return
      // 同注视：只认"当前那个实例"。订到已销毁的实例上不会报错，只会永远不动
      if (rendererRef.current !== instance) return
      if (!instance.setFlip || !instance.getLayout) {
        log.warn('[wander] sprite 后端缺 setFlip/getLayout，自主行为不启动')
        return
      }

      const driver = new PetWanderDriver({
        renderer: instance,
        onActivity: (activity) => onAmbientActivityRef.current?.(activity),
      })
      wanderRef.current = driver
      driver.start()
      log.info('[wander] 自主行为已启动')

      return () => {
        log.info('[wander] 自主行为已停止')
        driver.stop()
        wanderRef.current = null
        // 驱动没了，挂着的延迟解除也要清——它会去碰一个已停的实例
        if (tapHoldRef.current !== null) {
          clearTimeout(tapHoldRef.current)
          tapHoldRef.current = null
        }
      }
    }, [ready, renderer, config?.id])

    /**
     * 性格/情绪 → 活动权重与时长（第二期 T2.2）。
     *
     * 单独一个 effect、**不并进上面那个**：`petTuning` 变化时重跑上面那个会把驱动
     * stop 再 start，而 `start()` 会把宠物拽回地面线重新计时——换个模型它就从半空
     * 掉回地上，看着像被重置了。这里只改参数，不动生命周期。
     *
     * 声明在上面那个之后，所以同一帧里 `wanderRef.current` 已经就位。
     */
    useEffect(() => {
      wanderRef.current?.setTuning(petTuning?.mood ?? null, petTuning?.traits ?? null)
    }, [petTuning, ready, renderer])

    // 攀附目标（程序主窗口的矩形）：主进程推来，转给驱动。
    //
    // 与注视订阅同一套守卫：只认当前实例、后端必须是 sprite——Live2D 那边
    // 没有翻滚与布局查询，爬不了（`setPerchRect` 传过去也没人消费）。
    useEffect(() => {
      const instance = renderer?.instance
      if (!ready || !instance || renderer?.backend !== 'sprite') return
      if (rendererRef.current !== instance) return
      if (!window.electronAPI?.pet?.onPerch) {
        log.warn('[perch] preload 未暴露 onPerch —— 攀附链路在第二段就断了')
        return
      }
      const off = window.electronAPI.pet.onPerch((event) => {
        wanderRef.current?.setPerchRect(event.rect)
      })
      log.info('[perch] 已订阅主窗口矩形')

      // 订阅之后**补问一次**。进入宠物模式的顺序是「窗口 show 出来 → 主进程立刻推一次
      // 矩形」，而那一刻渲染层还没加载完，`webContents.send` 直接丢掉；此后主进程只在
      // **矩形变化**时才推（窗口静止时零流量），于是只要用户不动主窗口，宠物就永远不知道
      // 有东西可爬——这是必现的，不是偶发竞态。
      //
      // 顺序不能反：先问再订阅的话，两步之间主窗口动的那一次推送会丢。
      let cancelled = false
      void window.electronAPI.pet
        .getPerchRect?.()
        .then((rect) => {
          // 期间可能已经换过实例或卸载了，别把过期位置喂给新的驱动
          if (cancelled || rendererRef.current !== instance) return
          log.info(
            `[perch] 补问一次 → ${
              rect
                ? `${rect.width}×${rect.height}@(${Math.round(rect.x)},${Math.round(rect.y)})`
                : '暂无目标'
            }`,
          )
          wanderRef.current?.setPerchRect(rect)
        })
        .catch((err: unknown) => {
          log.warn(`[perch] 补问失败：${err instanceof Error ? err.message : String(err)}`)
        })

      return () => {
        cancelled = true
        off?.()
        // 订阅断了就当目标没了：宠物若正爬在上面，会因此松手掉下来
        wanderRef.current?.setPerchRect(null)
      }
    }, [ready, renderer])

    // 自主行为总开关。放在驱动创建 effect **之后**：两个 effect 依赖同一组值，
    // React 按定义顺序执行，这样开关一定作用在刚建好的驱动上（而不是上一轮的）。
    useEffect(() => {
      const driver = wanderRef.current
      if (!driver) return
      // 只在"确实记过"时才解除，否则开机就会报一条 `resume 没有对应的让位记录`
      if (ambientEnabled) {
        if (driver.isHeldBy(AMBIENT_HOLD_DISABLED)) driver.resume(AMBIENT_HOLD_DISABLED)
      } else {
        driver.suspend(AMBIENT_HOLD_DISABLED)
      }
    }, [ambientEnabled, ready, renderer, config?.id])

    /**
     * 气泡让位：挂着就定格，撤下就还给自主行为。
     *
     * 与上面那个同构（同一组依赖，保证作用在当前的驱动上）。`suspend` 自己幂等，
     * 所以"挂着"这条不需要先问 `isHeldBy`；解除那条要问——不然开机/换模型时会
     * 白报一条 `resume 没有对应的让位记录`（driver 里那条 warn 是给"计数泄漏"留的，
     * 不该被正常路径刷屏）。
     */
    useEffect(() => {
      const driver = wanderRef.current
      if (!driver) return
      if (bubbleHold) {
        driver.suspend(AMBIENT_HOLD_BUBBLE, { keepPose: true })
      } else if (driver.isHeldBy(AMBIENT_HOLD_BUBBLE)) {
        driver.resume(AMBIENT_HOLD_BUBBLE)
      }
    }, [bubbleHold, ready, renderer, config?.id])

    // 性能：失焦降帧（~15 FPS），聚焦恢复（60 FPS）
    useEffect(() => {
      if (!ready) return
      const renderer = rendererRef.current
      if (!renderer) return

      const onBlur = () => renderer.setFpsCap(15)
      const onFocus = () => renderer.setFpsCap(60)
      window.addEventListener('blur', onBlur)
      window.addEventListener('focus', onFocus)
      // 初始按当前焦点状态设定
      if (!document.hasFocus()) renderer.setFpsCap(15)

      return () => {
        window.removeEventListener('blur', onBlur)
        window.removeEventListener('focus', onFocus)
      }
    }, [ready])

    // 鼠标交互：hover hitTest 上报 + 点击动作 + 拖拽
    useEffect(() => {
      if (!ready) return
      const renderer = rendererRef.current
      const canvas = canvasRef.current
      if (!renderer || !canvas) return

      /**
       * 放弃这次拖拽：清干净状态并把"让位"还给自主行为。
       *
       * **不触发点击、也不抛出去**——那两件事都需要"在哪松的手"，而丢 mouseup 的
       * 情况下我们没有这个信息（指针多半已经不在窗口里）。含糊地收尾好过猜一个动作。
       *
       * 这个函数存在的理由是一个**会把桌面点死**的缺陷（用户 2026-09-22 报的
       * 「打开宠物模式，全屏都被覆盖了，无法点击到非宠物后方的程序」）：
       * `pressed` 只在 `mouseup` 里复位，而在**窗口外松手**（拖到任务栏、另一块屏）
       * 时渲染进程收不到那一下；此后每次 mousemove 都会走进下面那条 `pressed` 分支
       * **无条件上报 hover=true**，主进程于是把整个全屏窗口设成可点——
       * 于是桌面上什么都点不动了，只有重启应用能救。
       */
      const abandonDrag = (reason: string) => {
        if (!dragRef.current.pressed) return
        log.warn(`[abandonDrag] ${reason}`)
        if (grabTimerRef.current !== null) {
          clearTimeout(grabTimerRef.current)
          grabTimerRef.current = null
        }
        // 摸头也要一并收尾：它是与拖拽并列的一条状态分支，只清拖拽会把它留在
        // "正在摸"里——`Purr` 会一直循环下去，且下一次按下时 `pettingRef` 还是 true
        stopPetting()
        const wasGrabbed = dragRef.current.active
        dragRef.current.pressed = false
        dragRef.current.active = false
        dragRef.current.hit = false
        dragRef.current.samples = []
        // 让位还给自主行为：不还的话宠物会永远停在原地不动（那次 suspend 没人解除）
        wanderRef.current?.resume(AMBIENT_HOLD_POINTER)
        // 被抓起来过就要告诉编排器"落地了"，否则它会一直停在"被拎着"的姿势
        if (wasGrabbed) {
          const p = renderer.getPosition()
          onInteractionRef.current?.({ type: 'landed', x: p.x, y: p.y })
        }
        reportModelHover(false)
      }

      const onMouseMove = (e: MouseEvent) => {
        const { x, y } = toCanvasLocal(e, canvas)
        pointRef.current = { x, y }
        /**
         * `buttons === 0` 是 OS 给的「左键已经松开」的权威信号。
         *
         * 它与 `pressed` 不一致，只可能是 mouseup 丢了（见 `abandonDrag`）。
         * 必须在下面那条分支**之前**判——否则这一帧又会上报一次 hover=true，
         * 窗口再被点开一次。
         *
         * ⚠ 它会被**别的指针设备的杂散移动**误触发：hover 到模型时主进程会把穿透
         * 关掉，于是其它来源的 `buttons: 0` 也送得进来（实测自动化测试时真鼠标的
         * 移动持续打断合成拖拽）。没改成"延后一帧再判"是因为那样挡不住**连续的**
         * 杂散事件；也没改成按坐标过滤是因为全屏窗口根本收不到 `mouseleave`，
         * 这条判定是"松手在屏幕外"的唯一信号。**真机上只有一个指针设备，不会误触**。
         */
        if (dragRef.current.pressed && e.buttons === 0) {
          abandonDrag('左键已松开但没收到 mouseup（多半是在窗口外松的手）')
        }
        if (dragRef.current.pressed) {
          /**
           * 摸头 vs 拖拽的位移判定（第二期 T2.4）。两个阈值方向相反：
           * - 还没摸上：动一点就**取消**（用户是要拖，不是要摸）
           * - 已经摸上：要动得多才**退出**（手腕晃一下不该判成拖）
           */
          const origin = petOriginRef.current
          const moved = origin ? Math.hypot(x - origin.x, y - origin.y) : 0
          if (pettingRef.current) {
            if (moved > PET_EXIT_DRAG_PX) stopPetting()
          } else if (moved > PET_MOVE_TOLERANCE_PX && petTimerRef.current !== null) {
            clearTimeout(petTimerRef.current)
            petTimerRef.current = null
          }

          // **只有抓住了才跟手**。没到 GRAB_HOLD_MS 之前指针怎么动宠物都不动——
          // 那是"点击"的进行时，不该把宠物拖歪。摸头中同样不跟手：
          // 用户是在摸它，不是要把它拎走。
          if (dragRef.current.active && !pettingRef.current) {
            const want = { x: x - dragRef.current.offsetX, y: y - dragRef.current.offsetY }
            const at = clampDrag(want, { x, y })
            renderer.setPosition(at.x, at.y)
            dragRef.current.samples.push({ x, y, t: performance.now() })
            // 采样窗只需要最近一小段，长拖时不清会让数组无限增长
            if (dragRef.current.samples.length > 200) dragRef.current.samples.shift()
          }
          reportModelHover(true)
          return
        }
        reportModelHover(renderer.isPointerOverModel(x, y))
      }

      /** 停掉正在进行的抛掷（再抓住时、卸载时都要） */
      const cancelThrow = () => {
        if (throwRef.current !== null) {
          cancelAnimationFrame(throwRef.current)
          throwRef.current = null
        }
      }

      /**
       * 拖动时的位置夹取：**内容不许出视口**。
       *
       * 早先拖拽的 `setPosition` 没有任何边界检查，宠物能被拖到屏幕外找不回来
       * （实测 `y = -21589`）。判据用**内容**而不是画布，见 `getContentExtents`——
       * 画布两侧的留白会让宠物停在离边 20 多像素的地方。
       *
       * 夹住之后"内容贴边"就等价于"锚点到达夹取区间的端点"，松手时驱动据此吸附
       * （`flushEdges`）。所以这里只管夹，不判断该不该吸。
       *
       * 拿不到内容包围盒时（Live2D、图集还没解码好）**不夹**：宁可让它像以前一样
       * 能被拖出去，也不要在不知道边距的情况下按画布瞎夹。
       */
      const clampDrag = (want: { x: number; y: number }, pointer: { x: number; y: number }) => {
        const ext = renderer.getContentExtents?.()
        if (!ext) {
          // **必须说出来**：夹取与"贴边吸附"都靠它，拿不到就双双失效，而画面上
          // 只是"拖到边上没反应"——与"没实现"长得一模一样。每次拖动只说一次。
          if (!warnedNoExtentsRef.current) {
            warnedNoExtentsRef.current = true
            log.warn(
              '[clampDrag] 拿不到内容包围盒 → 拖动不夹取、贴边也不吸附（退回旧行为）。' +
                `后端=${renderer.constructor?.name ?? '?'} 模型=${config?.id ?? '?'}`,
            )
          }
          return want
        }
        const vp = { width: canvas.clientWidth, height: canvas.clientHeight }
        const b = dragBoundsOf(ext, vp)
        let x = Math.min(Math.max(want.x, b.minX), b.maxX)
        let y = Math.min(Math.max(want.y, b.minY), b.maxY)

        /**
         * **光标顶到屏幕边 ⇒ 意图就是"推到底"，不再受抓取偏移限制。**
         *
         * 拖动是直接操作：`want = 光标 − 抓取偏移`，所以**抓得离锚点越远，能推的余量越小**。
         * 光标最低只能到 0，于是"抓在宠物左半边往左墙推"最多推到 `|偏移|`，
         * 而贴边要求锚点落到 `内容左缘`——`|偏移|` 比它大就永远差一截，
         * 松手判定不成立、宠物掉下去。用户报的正是这个：「鼠标在宠物中心的右边贴不住，
         * 不管抓宠物哪边的位置、靠近边缘都要能吸」。
         *
         * 判据用"光标离屏幕边 24px 以内"而不是"越界"：`attachDistance` 就是这个语义
         * （走到墙线 24px 内就吸），拖动这边保持一致。落在边上的位移很小——
         * `want` 本来就已经被推得很近了。
         */
        const EDGE_PUSH_PX = 24
        if (pointer.x <= EDGE_PUSH_PX) x = b.minX
        else if (pointer.x >= vp.width - EDGE_PUSH_PX) x = b.maxX
        if (pointer.y <= EDGE_PUSH_PX) y = b.minY
        else if (pointer.y >= vp.height - EDGE_PUSH_PX) y = b.maxY
        return { x, y }
      }

      /**
       * 点击回应：让自主行为停一会儿再继续。
       *
       * **只负责"延迟解除"，不自己再 suspend 一次**。一次指针交互从 `mousedown`
       * 起就只该有一个让位来源（`AMBIENT_HOLD_POINTER`），各分支只决定"什么时候还"。
       * 早先的写法是 mousedown 记 `drag`、点击分支再记一个 `tap` 并只解除自己，
       * 于是 `drag` 那一次永远无人解除——每点一下泄漏一个，实测把计数顶到 12。
       *
       * 重复点击会**重置**计时而不是叠加：宠物正在回应时又点一下，应当从头再回应一次。
       */
      const holdAmbientForTap = () => {
        const driver = wanderRef.current
        if (!driver) return
        if (tapHoldRef.current !== null) clearTimeout(tapHoldRef.current)
        tapHoldRef.current = window.setTimeout(() => {
          tapHoldRef.current = null
          driver.resume(AMBIENT_HOLD_POINTER)
        }, TAP_AMBIENT_HOLD_MS)
      }

      /**
       * 按初速度做抛物线。
       *
       * `dt` 上限 50ms：标签页切回来、断点续跑时两帧间隔可能是几秒，
       * 不夹住的话宠物会一步跨到屏幕外。
       */
      const startThrow = (from: { x: number; y: number }, v: { vx: number; vy: number }) => {
        let body: ThrowBody = { x: from.x, y: from.y, vx: v.vx, vy: v.vy }
        // `minY` 把顶边也封上——不加的话一次猛甩（实测 vy 到过 -4050）会让宠物
        // 飞到屏幕上方三千多像素处、消失三四秒。撞了按 restitution 弹回来。
        //
        // 落点是**工作区底边**（宠物窗口已排除任务栏，所以它就是任务栏上沿），是常量。
        // 不取"拖拽开始时的高度"的理由见 `dragRef` 的注释。
        const bounds = { minX: 0, maxX: canvas.clientWidth, groundY: canvas.clientHeight, minY: 0 }
        let last = performance.now()

        const step = () => {
          const now = performance.now()
          const dt = Math.min(0.05, (now - last) / 1000)
          last = now
          const r = stepThrow(body, dt, bounds, { restitution: THROW_RESTITUTION })
          body = r.body
          renderer.setPosition(body.x, body.y)
          if (r.landed) {
            throwRef.current = null
            // 落地：把位置权威还给自主行为（driving 会重新读一次当前位置）
            wanderRef.current?.resume(AMBIENT_HOLD_POINTER)
            onInteractionRef.current?.({ type: 'landed', x: body.x, y: body.y })
            return
          }
          throwRef.current = requestAnimationFrame(step)
        }
        throwRef.current = requestAnimationFrame(step)
      }

      const onMouseDown = (e: MouseEvent) => {
        // 只认左键。右键归 `onContextMenu`，不参与抓取/点击——不判的话右键会
        // 顺手把宠物拎起来，菜单弹出来的同时宠物已经在半空。
        if (e.button !== 0) return
        const { x, y } = toCanvasLocal(e, canvas)
        const hit = renderer.hitTest(x, y)
        const over = hit || renderer.isPointerOverModel(x, y)
        if (!over) return
        reportModelHover(true)
        // 抓住正在飞的宠物：中断抛物线，不叠加
        cancelThrow()
        // 按住期间就让位：宠物要是自己走开了，用户就抓了个空。
        // （短按那条路走完会由 holdAmbientForTap 接着让位，正好接上）
        wanderRef.current?.suspend(AMBIENT_HOLD_POINTER)
        // 新的指针周期开始：上一轮点击留下的延迟解除作废（否则它 2.5s 后会来
        // 解除一个已经不属于它的让位，只留下一行无用的 warn）
        if (tapHoldRef.current !== null) {
          clearTimeout(tapHoldRef.current)
          tapHoldRef.current = null
        }
        const pos = renderer.getPosition()
        dragRef.current = {
          pressed: true,
          // **还没抓住**：要按住 GRAB_HOLD_MS 才进拖拽态。在此之前指针移动
          // 不会带动宠物——这正是"点击"与"抓取"分开的关键
          active: false,
          offsetX: x - pos.x,
          offsetY: y - pos.y,
          hit: !!hit,
          samples: [],
        }
        grabTimerRef.current = window.setTimeout(() => {
          grabTimerRef.current = null
          if (!dragRef.current.pressed) return
          dragRef.current.active = true
          // 抓取期间指针可能已经移开了，按**当前**指针位置重算偏移，
          // 否则抓住的一瞬间宠物会跳到指针下面
          const p = pointRef.current
          const now = renderer.getPosition()
          dragRef.current.offsetX = p.x - now.x
          dragRef.current.offsetY = p.y - now.y
          dragRef.current.samples = [{ x: p.x, y: p.y, t: performance.now() }]
          warnedNoExtentsRef.current = false
          log.info(`[onMouseDown] 按住 ${GRAB_HOLD_MS}ms 进入抓取`)
          onInteractionRef.current?.({ type: 'picked' })
        }, GRAB_HOLD_MS)
        /**
         * 摸头的起步计时（第二期 T2.4）。
         *
         * 与上面那个抓取计时器**并行**、互不改写：抓取管"跟手"，摸头管"被摸"。
         * 用户按住不动时两个都会到点——抓取先（100ms），所以宠物会先摆出被拎起的姿势，
         * 到 800ms 再转呼噜。这条顺序是已知的、**待素材到位后手调**的观感问题，
         * 不是逻辑错误；把 picked 延后到"首次移动"能消掉它，但那会改动拖拽手感，
         * 在没有素材可验的当下不值得冒这个险。
         */
        petOriginRef.current = { x, y }
        petTimerRef.current = window.setTimeout(() => {
          petTimerRef.current = null
          if (!dragRef.current.pressed) return
          startPetting()
        }, PET_START_MS)
      }

      const onMouseUp = (e: MouseEvent) => {
        if (e.button !== 0) return
        const { x, y } = toCanvasLocal(e, canvas)
        // 定时器无论走哪条分支都要清掉，否则它会在下一次交互里冒出来
        if (grabTimerRef.current !== null) {
          clearTimeout(grabTimerRef.current)
          grabTimerRef.current = null
        }
        const wasPressed = dragRef.current.pressed
        const wasGrabbed = dragRef.current.active
        // 摸头必须在下面各分支**之前**收尾：它自己那套（Purr 循环、让位）与
        // 点击/抛掷/落地三条路的收尾方式都不同，混进去会两头都不对
        const wasPetting = pettingRef.current
        stopPetting()
        const { samples } = dragRef.current
        dragRef.current.pressed = false
        dragRef.current.active = false
        dragRef.current.hit = false
        dragRef.current.samples = []

        if (!wasPressed) {
          reportModelHover(renderer.isPointerOverModel(x, y))
          return
        }

        // **没按满 GRAB_HOLD_MS 就是"点击"**，不管指针移了多远——宠物全程没跟手，
        // 它还在原地。判据从"位移超没超阈值"换成了"按够时间没有"：
        // 位移判据下，短按和拖拽在体感上分不开（想点一下必然先把它拖歪一点）。
        if (!wasGrabbed) {
          const hit = renderer.hitTest(x, y)
          const over = hit || renderer.isPointerOverModel(x, y)
          if (over) {
            /**
             * 拒绝判定（第二期 T2.3 / 设计 §4.4）。
             *
             * **只在这一处**：这里是"用户碰它"的入口，`kind` 恒为 `interaction`。
             * 任务请求走的是另一条链路（编排器/受限实例），根本不经过这里——
             * 硬规则由 `shouldRefuse` 内部短路，这里的字面量只是把语义写明白。
             *
             * 心情读 `?? 0`（基线）：宠物**自己的** mood 第二期还没有来源（第四期接上），
             * 所以现在这条判定实际上不会触发——它随 mood 一起上线，不是死代码。
             */
            const tuning = petTuningRef.current
            const refused = tuning?.traits
              ? shouldRefuse(
                  tuning.traits.agreeableness,
                  tuning.mood?.valence ?? 0,
                  'interaction',
                )
              : false

            if (refused) {
              // 「躲开」：不播点击动作、不放烟花，只播回避动作。模型没有 Dodge 组时
              // `playConventionalMotion` 会静默跳过——组不存在不等于"要退化成照常回应"
              log.info('[onMouseUp] 拒绝这次互动（低亲和 + 心情差）')
              onRefusalRef.current?.()
            } else {
              // 点击（非拖拽）落在模型身上即触发互动：优先用命中的 hitArea，
              // 无命名 hitArea 的模型（如 mao_pro Name 全空）回退到 body，
              // 保证"点击宠物身上有反应"，不再因缺 hitArea 而静默。
              triggerTapMotion(renderer, hit ?? 'body')
              // 点击特效：在点击位置绽放一簇烟花（受鼠标点击开关控制）
              if (tapInteractionEnabled) spawnClickFireworks(e.clientX, e.clientY)
            }
          }
          // 点击回应期间**保持让位**，2.5 秒后自动交还。
          // 不这么做的话，宠物会在播跳跃动画的同时继续走路——脚不动、人在飘。
          holdAmbientForTap()
          // **这里不上报 `landed`**（2026-09-21 实测修正）。
          //
          // 点击没有经历"被抓起 → 下落"，报 `landed` 会让编排器走 `notifyLanded()`；
          // 而模型没有 `Land` 组时它会回落到 `playAmbientMotion()`——**当场把刚播的
          // 点击动作换成 Idle**。实测症状：点一下只看到 Idle 循环，`Wave` 一帧都没出
          //（`[playMotion] group="Idle"` 紧跟在下发点击的同一 tick）。
          //
          // 它原本是必要的：早先版本 `mousedown` 就上报 `picked`，所以 `mouseup` 必须
          // 上报 `landed` 复位。现在抓取改成"按住 `GRAB_HOLD_MS` 才成立"，未抓取时
          // `interactionActive` 本来就是 false，无状态可复位。
          // `landed` 只剩两条真正需要的路径，都在下方 `wasGrabbed` 分支里。
          reportModelHover(renderer.isPointerOverModel(x, y))
          return
        }

        /**
         * 刚摸完头就松手：**不进抛掷/落地那两条路**。
         *
         * 用户全程没拖动过它（真拖了的话位移早把摸头顶掉、`wasPetting` 会是 false），
         * 所以既没有"被拎起来"要落、也没有速度要抛。走 `landed` 反而会让编排器
         * 播一次 `Land` 再回待机——那是"被放下"，不是"被摸完"。
         */
        if (wasPetting) {
          log.info('[onMouseUp] 摸头结束，直接交还自主行为')
          wanderRef.current?.resume(AMBIENT_HOLD_POINTER)
          reportModelHover(renderer.isPointerOverModel(x, y))
          return
        }

        // 抓住了：按释放速度决定"抛出去"还是"原地落下"
        const v = estimateVelocity(samples)
        const pos = renderer.getPosition()
        if (isThrowable(v)) {
          log.info(`[onMouseUp] 抛出 v=(${v.vx.toFixed(0)}, ${v.vy.toFixed(0)}) px/s`)
          // 先告知"在空中"，再起飞：编排器据此换成下落姿势。
          // 顺序不能反——先飞再通知的话，头几帧还是地面姿势，看起来像"踩着空气飘出去"
          onInteractionRef.current?.({ type: 'thrown' })
          // 抛掷期间保持让位；位置权威交给抛物线，落地时（startThrow 内）才交还
          startThrow(pos, v)
        } else {
          // **先问"该不该吸住"，吸不住才自由落体。**
          //
          // 这一步原先没有：拖到屏幕边上/顶上松手时，宠物会被 `startThrow` 先摔到
          // 地面，等 `resume` 再判吸附时它已经在地上了——位置早就不贴边，于是
          // "拖到边缘吸附"整条路**从来没生效过**（用户实测报的就是这个）。
          //
          // ⚠ 顺序：`landed` 必须在 `resume` **之前**报。`attachPerch` 会在 `resume`
          // 里报动作组（`climb`/`crawl`），而编排器在 `interactionActive` 为真时
          // **静默不播**——先吸后报的话宠物会爬着墙播待机，正是用户说的"像坐电梯"。
          if (wanderRef.current?.canAttachHere()) {
            log.info(`[onMouseUp] 贴住了屏幕边，吸附而非落下 @(${pos.x.toFixed(0)}, ${pos.y.toFixed(0)})`)
            onInteractionRef.current?.({ type: 'landed', x: pos.x, y: pos.y })
            wanderRef.current.resume(AMBIENT_HOLD_POINTER)
            reportModelHover(renderer.isPointerOverModel(x, y))
            return
          }
          // 速度不够"抛"，但**该落还是要落**。这里原先直接 `resume()`，宠物就停在
          // 用户把它举到的那个高度上——日志里"原地落下"四个字名不副实：实测拖到
          // 半空松手后它一直在 y=972 的空气里走动，再没下来过。
          //
          // 走 `startThrow` 初速为零：落点、让位解除（落地时 `resume`）、`landed` 上报
          // 全都复用同一条已有路径，不必在这里再写一遍。
          log.info(`[onMouseUp] 速度不足（${Math.hypot(v.vx, v.vy).toFixed(0)} px/s），自由落下`)
          onInteractionRef.current?.({ type: 'thrown' })
          startThrow(pos, { vx: 0, vy: 0 })
        }
        reportModelHover(renderer.isPointerOverModel(x, y))
      }

      /**
       * 指针离开**窗口** ⇒ 这次交互结束了。
       *
       * 挂在 `document` 上而不是 canvas 上：canvas 是 `pointer-events:none`，
       * **根本收不到 mouseleave**——原先那条挂在 canvas 上的监听从来没生效过，
       * 是个留在那儿的坑。而指针到了窗口外就不再产生 mousemove，`buttons` 那招
       * 也救不了，所以这条是唯一信号。
       */
      const onWindowLeave = () => {
        abandonDrag('指针离开窗口')
        reportModelHover(false)
      }

      // 滚轮缩放：挂到 window（canvas 为 pointer-events:none，收不到 wheel）
      const onWheel = (e: WheelEvent) => {
        const { x, y } = toCanvasLocal(e, canvas)
        if (renderer.isPointerOverModel(x, y)) {
          e.preventDefault()
          renderer.adjustScaleByDelta?.(e.deltaY)
          log.info(`[onWheel] 缩放 deltaY=${e.deltaY}`)
        }
      }

      /**
       * 右键 → 弹选项菜单。
       *
       * 判 `isPointerOverModel` 是必须的：宠物窗口是**全屏**的，不判就等于
       * 整个桌面右键都弹宠物菜单。
       */
      const onContextMenu = (e: MouseEvent) => {
        const { x, y } = toCanvasLocal(e, canvas)
        if (!renderer.isPointerOverModel(x, y)) return
        e.preventDefault()
        onContextMenuRef.current?.(e.clientX, e.clientY)
      }

      window.addEventListener('mousemove', onMouseMove)
      window.addEventListener('mousedown', onMouseDown)
      window.addEventListener('mouseup', onMouseUp)
      window.addEventListener('contextmenu', onContextMenu)
      window.addEventListener('wheel', onWheel, { passive: false })
      // 挂在 document 上：canvas 是 pointer-events:none，收不到 mouseleave（见 onWindowLeave）
      document.addEventListener('mouseleave', onWindowLeave)
      return () => {
        window.removeEventListener('mousemove', onMouseMove)
        window.removeEventListener('mousedown', onMouseDown)
        window.removeEventListener('mouseup', onMouseUp)
        window.removeEventListener('contextmenu', onContextMenu)
        window.removeEventListener('wheel', onWheel)
        document.removeEventListener('mouseleave', onWindowLeave)
        reportModelHover(false)
        disposePetParticles()
        // 点击让位的定时器要清掉：不清的话组件已卸载，回调还会去碰已销毁的驱动
        if (tapHoldRef.current !== null) {
          clearTimeout(tapHoldRef.current)
          tapHoldRef.current = null
        }
        // 抓取定时器同理——它比点击那个更长命，更容易在卸载后才烧到
        if (grabTimerRef.current !== null) {
          clearTimeout(grabTimerRef.current)
          grabTimerRef.current = null
        }
        // 摸头的两个定时器命最长（800ms / 3s），漏清的话回调会去碰已销毁的驱动
        stopPetting()
      }
    }, [ready])

    return (
      // 宿主容器，样式与原来的 canvas 一致（canvas 填满它）。
      // **canvas 不在这里渲染**——它由 setup effect 每次重建，理由见 `canvasHostRef`。
      <div
        ref={canvasHostRef}
        style={{
          position: 'fixed',
          inset: 0,
          width: '100vw',
          height: '100vh',
          pointerEvents: 'none', // 穿透由主进程 setIgnoreMouseEvents 控制，容器自身不拦截
          background: 'transparent',
        }}
      />
    )
  },
)

PetCanvas.displayName = 'PetCanvas'

/** 命中区域 → tapMotion（当前模型 tapMotions 映射在 config，简化：直接用 hitArea 名作动作组兜底） */
let cachedTapModelConfig: PetModelConfig | null = null
export function setTapModelConfig(config: PetModelConfig | null): void {
  cachedTapModelConfig = config
}

/** 鼠标点击控制开关：关闭时点击宠物身体不触发互动动作（默认开启） */
let tapInteractionEnabled = true
export function setTapInteractionEnabled(enabled: boolean): void {
  tapInteractionEnabled = enabled
}

function triggerTapMotion(renderer: PetRendererProvider, hitArea: string): void {
  if (!tapInteractionEnabled) return
  const tapMotions = cachedTapModelConfig?.tapMotions?.[hitArea]
  // 这一行是**诊断用**的：点击"没反应"有两条完全不同的原因——事件没到（看 driver 的
  // suspend 日志）和映射没命中（看这里）。少了它只能靠猜。
  log.info(
    `[triggerTapMotion] hitArea="${hitArea}" 命中映射=${tapMotions ? JSON.stringify(tapMotions) : '无'}`,
  )
  if (tapMotions) {
    const [group, index] = Object.entries(tapMotions)[0] ?? []
    if (group) {
      renderer.playMotion(group, typeof index === 'number' ? index : undefined)
      return
    }
  }
  // 兜底：命中区域名对应的动作组存在就用它，否则退到 Tap/tap 组，
  // 再退到装饰动作组（如 mao_pro 的 $unnamed），保证点击总有可见反馈。
  const candidates = [
    hitArea,
    'Tap',
    'tap',
    'TapBody',
    cachedTapModelConfig?.idleMotionFallbackGroup ?? PET_MOTION_GROUP_UNNAMED,
  ]
  for (const group of candidates) {
    if (group && renderer.getMotionCount(group) > 0) {
      renderer.playRandomMotion(group)
      return
    }
  }
}

export default PetCanvas
