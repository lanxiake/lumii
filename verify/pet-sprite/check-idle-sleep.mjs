#!/usr/bin/env node
/**
 * 闲置感知验证：用户离开后宠物会不会打盹、睡着，回来会不会醒
 *
 * 设计依据：docs/plans/客户端UI/2026-09-21-宠物自制系统P2-c实施计划.md §5.1
 *
 * ## 判据为什么落在日志上，而不是截图
 *
 * 截图只能证明「脸变了」；日志能证明**切到的是哪一张脸**——
 * `[setExpression] orchestrator → renderer index=9 name=sleepy` 是编排器的意图，
 * `[SpritePetRenderer] [setExpression] index=9 → eye_sleepy` 是渲染器真的换了部件。
 * 两者都在 `~/.lumii/logs/app/mtbot-<日期>.log` 里（渲染层的 console 会被带进去）。
 *
 * ## ⚠️ 必须先把阈值调小，否则本脚本跑不动
 *
 * 默认阈值是 60s/300s，完整跑一遍要 6 分钟**全程不碰键鼠**（系统闲置时长是全局的，
 * 你在别的窗口打字就会把它清零）。所以本脚本要求客户端以调试阈值启动：
 *
 *   pnpm dev:stop
 *   LUMII_PET_IDLE_DROWSY_SEC=3 LUMII_PET_IDLE_ASLEEP_SEC=8 pnpm dev:start
 *
 * 脚本进宠物模式后先从日志里读回**真实生效**的阈值，不是这个数就明确报
 * 「环境未就绪」并退出，而不是把「跑不起来」伪装成「功能坏了」。
 *
 * ## 会接管鼠标
 *
 * 系统闲置是靠「有没有输入」判定的，所以脚本必须能**主动制造输入**：
 * 就绪前抖光标保持清醒，判定醒来时抖一下。跑的时候别动鼠标。
 *
 * 用法：node verify/pet-sprite/check-idle-sleep.mjs [--model demo_pixel_cat]
 *   --model  用哪个宠物（默认 demo_pixel_cat：唯一同时有 sleepy 与 calm 两档表情的
 *            sprite 模型。换成 real_dog 只会停动作，脸上什么都不演，见计划 §七）
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { makeAppUiPost, petBlob, readAppUiConfig, shootPet, sleep, startCursorServer } from './lib/pet-frame.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = join(HERE, '..', '..')
const EVIDENCE = join(REPO, 'docs', 'test', 'pet-sprite', 'evidence')

const args = process.argv.slice(2)
const argOf = (name, fallback) => {
  const i = args.indexOf(name)
  return i === -1 ? fallback : args[i + 1]
}
const MODEL = argOf('--model', 'demo_pixel_cat')
/** 分析窗口：半尺寸整屏（截图是 0.5 倍，见 lib/pet-frame.mjs）。取最大连通域，坞会被排除 */
const WINDOW = { x0: 0, x1: 1280, y0: 0, y1: 700 }

/**
 * 这个模型有没有「装饰性随机待机动作」——即睡着时要停掉的那类动作。
 *
 * 判定规则抄的是编排器的 `hasRandomIdleSource()`：显式配了 `idleMotionRandomGroups`
 * 或配了回退组（mao_pro 的 `$unnamed`）才算有。**demo 两兄弟两个都没配**，
 * 所以「睡着后不再有随机动作」这条对它们是**空过**的——脚本会明说「不适用」，
 * 而不是拿一条永远为真的断言冒充验证。要真验这条得用 `--model mao_pro`。
 */
function hasRandomIdlePool(modelId) {
  try {
    const reg = JSON.parse(
      readFileSync(join(REPO, 'apps', 'windows', 'resources', 'pet-models', 'registry.json'), 'utf-8'),
    )
    const m = reg.models?.find((x) => x.id === modelId)
    if (!m) return false
    if (Array.isArray(m.idleMotionRandomGroups) && m.idleMotionRandomGroups.length > 0) return true
    return !!m.idleMotionFallbackGroup
  } catch {
    return false
  }
}

/** 日志文件按本地日期分片（与应用内 logger 同一规则） */
function logPath() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return join(
    homedir(), '.lumii', 'logs', 'app',
    `mtbot-${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}.log`,
  )
}

/** 日志行首带毫秒时间戳；解析不出来（多行堆栈等）就丢掉 */
const LINE_RE = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\.(\d{3})\]/

/**
 * 增量读日志。
 *
 * 整天日志实测 2.8MB，而 `waitFor` 每 250ms 就要看一次——每次全量读一遍是白烧 IO。
 * 这里只从上次读到的字节位置往后读，并把最近若干行留在内存里供反复匹配
 * （`waitFor` 是按时间戳筛的，所以留着的旧行不会干扰后面的阶段）。
 */
const MAX_RECENT = 8000
const recent = []
let readOffset = -1
let carry = ''

function poll() {
  const file = logPath()
  if (!existsSync(file)) return
  const size = statSync(file).size
  // 首次只读尾部：整天几 MB 没必要拖进来
  if (readOffset < 0) readOffset = Math.max(0, size - 512 * 1024)
  // 日志被轮转/清空过
  if (size < readOffset) {
    readOffset = 0
    carry = ''
  }
  if (size === readOffset) return

  const len = size - readOffset
  const buf = Buffer.alloc(len)
  const fd = openSync(file, 'r')
  try {
    readSync(fd, buf, 0, len, readOffset)
  } finally {
    closeSync(fd)
  }
  readOffset = size

  const parts = (carry + buf.toString('utf-8')).split('\n')
  carry = parts.pop() ?? ''
  for (const line of parts) {
    const m = LINE_RE.exec(line)
    if (!m) continue
    recent.push({
      t: new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6], +m[7]).getTime(),
      line,
    })
  }
  if (recent.length > MAX_RECENT) recent.splice(0, recent.length - MAX_RECENT)
}

/** 轮询日志直到 pred 命中或超时。返回命中的那一行（带时间戳），超时返回 null */
async function waitFor(since, pred, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    poll()
    const hit = recent.find((e) => e.t >= since && pred(e))
    if (hit) return hit
    if (Date.now() > deadline) return null
    await sleep(250)
  }
}

/** 从「已启动闲置轮询」那行里读回真实生效的阈值（取最近一次） */
function readLiveThresholds() {
  poll()
  for (let i = recent.length - 1; i >= 0; i--) {
    const e = recent[i]
    if (!e.line.includes('已启动闲置轮询')) continue
    const m = /阈值 打盹=(\S+) 睡着=(\S+)/.exec(e.line)
    if (m) return { drowsy: m[1], asleep: m[2], at: new Date(e.t).toISOString() }
  }
  return null
}

const post = makeAppUiPost(readAppUiConfig())

async function main() {
  const before = await post('/ipc/pet/getMode')
  const initialMode = before?.mode === 'pet' ? 'pet' : 'desktop'

  const t0 = Date.now()
  await post('/ipc/pet/switchMode', { mode: 'desktop' })
  await sleep(1200)
  await post('/ipc/pet/switchMode', { mode: 'pet', modelId: MODEL })
  // 进宠物模式时 watcher 会打一行「已启动闲置轮询」，阈值就在那行里
  await sleep(500)

  const live = readLiveThresholds()
  if (!live || live.drowsy === '(默认)' || live.asleep === '(默认)') {
    console.log('✗ 环境未就绪：客户端当前用的是默认阈值（60s/300s），本脚本跑不动。')
    console.log('  默认阈值下要全程 6 分钟不碰键鼠，而且系统闲置是全局的，你在别处打字就会清零。')
    console.log('  按下面这样重启客户端再跑：')
    console.log('    pnpm dev:stop')
    console.log('    LUMII_PET_IDLE_DROWSY_SEC=3 LUMII_PET_IDLE_ASLEEP_SEC=8 pnpm dev:start')
    await post('/ipc/pet/switchMode', { mode: initialMode }).catch(() => {})
    process.exitCode = 2
    return
  }
  const DROWSY = Number(live.drowsy)
  const ASLEEP = Number(live.asleep)
  console.log(`生效阈值：打盹 ${DROWSY}s / 睡着 ${ASLEEP}s（读自 ${live.at} 那次启动）`)
  console.log(`模型 ${MODEL}（脚本会接管鼠标，请勿操作）\n`)

  const cursor = startCursorServer()
  /**
   * 制造一次真实输入。
   *
   * **必须用 `poke` 而不是 `move`**：`SetCursorPos`（`Cursor.Position = …`）不更新
   * 系统闲置计时——实测期间闲置从 663s 一路涨、一点没归零，宠物在「抖光标」中照样睡死。
   * `mouse_event` 才是真输入（一调就归零）。见 lib/pet-frame.mjs 的说明。
   */
  const poke = async (tag) => {
    await cursor.poke()
    if (tag) console.log(`  · 制造一次输入（${tag}）`)
  }

  let ok = true
  const checks = []
  const check = (pass, label, detail) => {
    checks.push({ label, ok: pass, detail })
    if (!pass) ok = false
    console.log(`  ${pass ? '✓' : '✗'} ${label}：${detail}`)
  }
  /** 从编排器那行里取出 index/name（`… index=9 name=sleepy`） */
  const faceOf = (line) => {
    const m = /index=(-?\d+) name=(\S+)/.exec(line)
    return m ? { index: Number(m[1]), name: m[2] } : null
  }
  const describeFace = (line) => {
    const f = faceOf(line)
    return f ? `index=${f.index} name=${f.name}` : line.slice(-80)
  }

  let readyAt = 0
  let drowsyEvt = null
  let asleepEvt = null
  let wakeEvt = null
  let drowsyFace = null
  let asleepFace = null
  let baselineFace = null
  let wakeAt = 0
  /** 该模型有没有装饰性随机待机组（决定「睡着后无随机动作」是真验过还是空过） */
  let hasPool = false
  /** 醒着时观察窗里抓到的随机待机动作次数（正对照；0 = 这条判据没被证明） */
  let baselineRandoms = 0
  let randoms = []
  let asleepShot = null

  try {
    // ---- 阶段 0：就绪（制造输入保持清醒，别让它在模型加载完之前就睡着） ----
    //
    // 就绪判据是「屏幕上真的看得见宠物」，**不是**等 `[loadModel] 模型就绪`：
    // 宠物窗口在模式切换之间是**隐藏**而不是销毁的（日志里只有 createPetWindow 一次），
    // 页面上的渲染器与编排器都还活着，重进宠物模式不会再走一遍模型加载。
    console.log('阶段 0：等宠物出现在屏幕上（期间持续制造输入保持清醒）…')
    let pet = null
    for (let i = 0; i < 60 && !pet; i++) {
      await poke()
      // 每轮 poke 间隔远小于打盹阈值，系统闲置才攒不起来
      await sleep(400)
      pet = await petBlob(await shootPet(post), WINDOW).catch(() => null)
    }
    if (!pet) {
      console.log('✗ 屏幕上一直找不到宠物 —— 渲染没起来（看日志的 [setup]/[loadModel] 那几行）')
      process.exitCode = 1
      return
    }
    // ---- 阶段 0.5：醒着时的随机动作基线（只在模型真有装饰随机组时做） ----
    //
    // 「睡着后不再有随机动作」必须配一条**正对照**才算验证：没有它，
    // 一条「0 次」的断言在一个压根不会播随机动作的模型上永远为真（demo 两兄弟就是这样）。
    hasPool = hasRandomIdlePool(MODEL)
    if (hasPool) {
      console.log('\n阶段 0.5：醒着时应当有随机待机动作（正对照，持续制造输入保持清醒）…')
      const baseStart = Date.now()
      const baseMs = 40_000
      while (Date.now() - baseStart < baseMs) {
        await poke()
        await sleep(1200)
      }
      poll()
      baselineRandoms = recent.filter(
        (e) => e.t >= baseStart && e.line.includes('[playRandomIdleNow]'),
      ).length
      check(
        baselineRandoms > 0,
        '醒着时有随机待机动作（正对照）',
        `${baseMs / 1000}s 内 ${baselineRandoms} 次（随机间隔 8~15s，有装饰组才播）`,
      )
    } else {
      console.log(`\n阶段 0.5：${MODEL} 没有装饰性随机待机组 —— 「睡着后不再有随机动作」这条对它不适用`)
    }

    // 最后一次输入之后才起算：起点若早于它，第一段的时间会算多
    await poke()
    readyAt = Date.now()
    console.log(
      `  宠物在屏幕 x[${pet.gx0 * 2},${pet.gx1 * 2}] y[${pet.gy0 * 2},${pet.gy1 * 2}]，` +
        `起算于 ${new Date(readyAt).toISOString()}（此刻系统闲置刚被清零）`,
    )

    // ---- 阶段 1：打盹（停止输入） ----
    console.log('\n阶段 1：不再输入，等它犯困…')
    drowsyEvt = await waitFor(
      readyAt,
      (e) => e.line.includes('[setIdleStage] awake → drowsy'),
      (DROWSY + 6) * 1000,
    )
    check(
      !!drowsyEvt,
      '闲置到阈值即进入打盹',
      drowsyEvt
        ? `${((drowsyEvt.t - readyAt) / 1000).toFixed(1)}s 后（阈值 ${DROWSY}s）`
        : `${DROWSY + 6}s 内没等到 [setIdleStage] awake → drowsy`,
    )
    if (!drowsyEvt) return

    // 睡前那张脸 = 基准（模型加载完时编排器设的 defaultExpression）。
    // 「醒来回到默认」要跟它比，而不是写死 index=0。
    const baselineEvt = [...recent]
      .reverse()
      .find(
        (e) =>
          e.t < drowsyEvt.t &&
          e.line.includes('[PetOrchestrator] [setExpression] orchestrator → renderer'),
      )
    baselineFace = baselineEvt ? faceOf(baselineEvt.line) : null

    drowsyFace = await waitFor(
      drowsyEvt.t,
      (e) => e.line.includes('[PetOrchestrator] [setExpression] orchestrator → renderer'),
      3000,
    )
    check(!!drowsyFace, '打盹切了表情', drowsyFace ? describeFace(drowsyFace.line) : '3s 内没有表情切换')

    // ---- 阶段 2：睡着 ----
    console.log('\n阶段 2：继续不动，等它睡实…')
    asleepEvt = await waitFor(
      drowsyEvt.t,
      (e) => e.line.includes('[setIdleStage] drowsy → asleep'),
      (ASLEEP - DROWSY + 6) * 1000,
    )
    check(
      !!asleepEvt,
      '闲置再久一档即睡着',
      asleepEvt
        ? `${((asleepEvt.t - drowsyEvt.t) / 1000).toFixed(1)}s 后（阈值 ${ASLEEP}s）`
        : `${ASLEEP - DROWSY + 6}s 内没等到 [setIdleStage] drowsy → asleep`,
    )
    if (!asleepEvt) return

    asleepFace = await waitFor(
      asleepEvt.t,
      (e) => e.line.includes('[PetOrchestrator] [setExpression] orchestrator → renderer'),
      3000,
    )
    check(!!asleepFace, '睡着切了表情', asleepFace ? describeFace(asleepFace.line) : '3s 内没有表情切换')

    const df = drowsyFace ? faceOf(drowsyFace.line) : null
    const af = asleepFace ? faceOf(asleepFace.line) : null
    check(
      !!df && !!af && df.index !== af.index,
      '打盹与睡着是两张不同的脸',
      df && af ? `打盹 ${df.name}(${df.index}) vs 睡着 ${af.name}(${af.index})` : '缺一次表情切换，无法比较',
    )

    asleepShot = await shootPet(post).catch(() => null)

    // 睡着观察窗：不该再有随机待机动作。
    //
    // 这条**必须配对正对照**才算验证过：
    //  · 模型压根没有装饰随机组（demo 两兄弟）→ 空过，明确标注「不适用」
    //  · 有随机组、但醒着时一次都没抓到 → 观察窗里的「0 次」毫无意义，**判失败**
    //    （实测抓到过这种情况：跨后端换模型后编排器还攥着已销毁的渲染器，
    //      `getMotionCount` 恒为 0，醒着睡着都不播）
    //  · 有随机组且醒着时播过 → 睡着后 0 次才算真验过
    const observeMs = Math.max(12, ASLEEP * 2) * 1000
    console.log(`\n  观察 ${observeMs / 1000}s：睡着期间不该出现随机待机动作…`)
    const windowEnd = Date.now() + observeMs
    while (Date.now() < windowEnd) await sleep(500)
    poll()
    randoms = recent.filter((e) => e.t >= asleepEvt.t && e.line.includes('[playRandomIdleNow]'))
    const randomProven = !hasPool || baselineRandoms > 0
    check(
      randoms.length === 0 && randomProven,
      hasPool ? '睡着期间没有随机待机动作' : '睡着期间没有随机待机动作（不适用：本模型无装饰随机组）',
      randoms.length > 0
        ? `${observeMs / 1000}s 内出现 ${randoms.length} 次`
        : !hasPool
          ? `${observeMs / 1000}s 内 0 次 —— 但本模型本来就没有随机组，这条是空过的`
          : baselineRandoms > 0
            ? `${observeMs / 1000}s 内 0 次（正对照：醒着时 ${baselineRandoms} 次）`
            : `${observeMs / 1000}s 内 0 次，但正对照也没抓到一次 —— 这条没被证明`,
    )

    // ---- 阶段 3：醒来 ----
    console.log('\n阶段 3：抖一下光标，它该醒…')
    wakeAt = Date.now()
    await poke('唤醒')
    wakeEvt = await waitFor(wakeAt, (e) => e.line.includes('[setIdleStage] asleep → awake'), 3500)
    check(
      !!wakeEvt,
      '有输入即醒（1Hz 轮询，最迟约 1s）',
      wakeEvt
        ? `${((wakeEvt.t - wakeAt) / 1000).toFixed(1)}s 后`
        : '3.5s 内没等到 [setIdleStage] asleep → awake',
    )

    if (wakeEvt) {
      const feedback = await waitFor(wakeEvt.t, (e) => e.line.includes('[playWakeFeedback]'), 2500)
      check(
        !!feedback,
        '醒来给了一次「被吵醒」的反馈',
        feedback ? describeFace(feedback.line) : '没等到 [playWakeFeedback]',
      )

      // 反馈只停留 1.2s，之后才回默认。要取**最后**一条 setExpression，
      // 不能取醒来后的第一条——那条正是反馈表情本身。
      await sleep(1800)
      poll()
      const back = [...recent]
        .reverse()
        .find(
          (e) =>
            e.t >= wakeEvt.t + 1000 &&
            e.line.includes('[PetOrchestrator] [setExpression] orchestrator → renderer'),
        )
      const backFace = back ? faceOf(back.line) : null
      check(
        !!backFace && !!baselineFace && backFace.index === baselineFace.index,
        '反馈之后回到默认表情',
        backFace
          ? `${describeFace(back.line)}（睡前的基准是 ${baselineFace ? `${baselineFace.name}(${baselineFace.index})` : '(没采到)'}）`
          : '1s 之后没再看到表情切换',
      )
    }
  } finally {
    cursor.close()
    const df = drowsyFace ? faceOf(drowsyFace.line) : null
    const af = asleepFace ? faceOf(asleepFace.line) : null
    mkdirSync(EVIDENCE, { recursive: true })
    writeFileSync(
      join(EVIDENCE, 'check-idle-sleep-result.json'),
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          modelId: MODEL,
          thresholds: { drowsySec: DROWSY, asleepSec: ASLEEP, source: '客户端启动日志（环境变量覆盖）' },
          metric: '日志里的阶段迁移 + 编排器 [setExpression] 的 index/name（同一份 mtbot-<日期>.log）',
          timeline: {
            readyAt: readyAt ? new Date(readyAt).toISOString() : null,
            drowsyMs: drowsyEvt ? drowsyEvt.t - readyAt : null,
            asleepMs: drowsyEvt && asleepEvt ? asleepEvt.t - drowsyEvt.t : null,
            wakeMs: wakeEvt ? wakeEvt.t - wakeAt : null,
          },
          faces: { baseline: baselineFace, drowsy: df, asleep: af },
          hasRandomIdlePool: hasPool,
          randomIdleMotionsWhileAwake: baselineRandoms,
          randomIdleMotionsWhileAsleep: randoms.length,
          screenshotAtAsleep: asleepShot,
          checks,
        },
        null,
        2,
      ),
    )
    console.log('\n证据：docs/test/pet-sprite/evidence/check-idle-sleep-result.json')
    await post('/ipc/pet/switchMode', { mode: initialMode }).catch(() => {})
    console.log(`（已还原为 ${initialMode} 模式）`)
  }

  if (!ok) {
    console.log(`\n✗ 未通过：${checks.filter((c) => !c.ok).map((c) => c.label).join('、')}`)
    process.exitCode = 1
  } else {
    console.log('\n✓ 闲置感知判据全部通过')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
