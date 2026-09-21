#!/usr/bin/env node
/**
 * 验 B4：点击宠物身体，是否真的播了动作组。
 *
 * ## 定位：读日志里的驱动起点，不猜坐标、不靠截图
 *
 * 三个失败过的方案，别再走回头路：
 * - **`petBlob` 找最大亮块**：宠物窗口是透明覆盖层，CDP 与控制口的截图都是**整屏**
 *   （透明处露出桌面）。当前壁纸下整屏都亮，连通域超限 → 返回 null。
 * - **帧差分**（拍两张找动的区域）：**CDP 的截图根本拍不到宠物**——实测两张间隔 600ms
 *   的截图 **MD5 完全相同**（56,865 字节、逐字节一致），拍到的是静止的桌面。
 * - **算 `resetToGround` 的常量**：只在"刚进宠物模式"那一刻成立。R9 的自主行为会让
 *   宠物走动**甚至爬主窗口**——实测跑到 `(2059, 1258)`，而地面线是 `y=1352`。
 *
 * 可靠的锚点是**日志**：`switchMode` 进宠物模式会重建 `PetWanderDriver`，
 * 它必打一行 `[PetWander] [start] 起点 (x, y)`，且**首个活动固定是 stand（约 43s）**——
 * 这就是一个确定性极强的静止窗口。读这一行、在窗口内点击即可。
 *
 * ## 判据（带正负对照）
 * - 负对照：点高空（宠物不可能在的地方）→ 不应有任何 `[playMotion]`
 * - 正例：点起点上方约 55px（身体中心）→ 应出现 `[playMotion] group="Wave"`
 * 有正对照才能把"没日志"读成"链路断了"，否则可能只是"输入没到"。
 */
import { statSync, openSync, readSync, closeSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { makeAppUiPost, readAppUiConfig, sleep } from './lib/pet-frame.mjs'

const ROOT = 'C:/myself/projects/my/open-source/lumii'
const LOG = join(homedir(), '.lumii', 'logs', 'app', `mtbot-${new Date().toISOString().slice(0, 10)}.log`)

const post = makeAppUiPost(readAppUiConfig())
const cdp = (...args) =>
  execFileSync('node', [join(ROOT, 'scripts/lumii-cdp.mjs'), ...args], { encoding: 'utf-8' })

function readFrom(path, from) {
  const size = statSync(path).size
  if (size <= from) return ''
  const fd = openSync(path, 'r')
  const buf = Buffer.alloc(size - from)
  readSync(fd, buf, 0, buf.length, from)
  closeSync(fd)
  return buf.toString('utf-8')
}

/** 从"进宠物模式之后新增的日志"里取驱动起点 */
function findWanderStart(from) {
  const m = readFrom(LOG, from).match(/\[PetWander\] \[start\] 起点 \((\d+), (\d+)\)/)
  return m ? { x: Number(m[1]), y: Number(m[2]) } : null
}

const relevant = (from) =>
  readFrom(LOG, from)
    .split('\n')
    .filter((l) => /playMotion|triggerTapMotion|onMouseUp|onWheel/.test(l))
    .map((l) => '      ' + l.slice(0, 165))

async function clickAt(x, y) {
  const mark = statSync(LOG).size
  cdp('click', '?mode=pet', String(Math.round(x)), String(Math.round(y)))
  await sleep(1000)
  return relevant(mark)
}

// ---- 1. 确保在宠物模式 ----
await post('/ipc/pet/switchMode', { mode: 'pet', modelId: 'demo_anime_girl' })
await sleep(2000)

// ---- 2. 用"点高空 → 让位 → 恢复"逼出一条带坐标的日志来定位宠物 ----
//
// 为什么不读 `[PetWander] [start] 起点`：那条只在 **driver 重建**时打，而 `switchMode`
// 不会重建（`PetCanvas` 不卸载，useEffect 的 deps `[ready, renderer, config?.id]` 没变）——
// 实测切模式后日志里没有新的 start 行。
//
// 而 `[resume] 恢复（pointer）位置 (x, y)` **每次让位结束都会打**，且报的就是锚点（脚底）位置。
// 点高空不会命中模型（不会播动作），但同样会走 `holdAmbientForTap()` → 2.5s 后 resume，
// 于是白拿一次当前位置。这是纯读日志、不猜、不靠截图。
console.log('定位：点一次高空（不命中模型），等它让位结束报出坐标…')
const probeMark = statSync(LOG).size
cdp('click', '?mode=pet', '640', '120')
await sleep(3600)
const resumeMs = readFrom(LOG, probeMark).match(/\[resume\] 恢复（pointer）位置 \((\d+), (\d+)\)/g)
if (!resumeMs?.length) {
  console.log('✗ 没拿到 [resume] 坐标行——让位机制可能没跑（宠物不在 sprite 后端？）')
  process.exit(1)
}
const last = resumeMs[resumeMs.length - 1].match(/\((\d+), (\d+)\)/)
const anchor = { x: Number(last[1]), y: Number(last[2]) }
/** 锚点是脚底中心；宠物屏幕高约 109px 时，身体中心在脚底上方约 55px */
const BODY_ABOVE = 55
const px = anchor.x
const py = anchor.y - BODY_ABOVE
console.log(`宠物锚点 (${anchor.x}, ${anchor.y}) → 点身体中心 (${px}, ${py})`)

// ---- 3. 负对照：点高空 ----
const negY = Math.max(20, Math.round(anchor.y * 0.15))
console.log(`\n--- 负对照：点高空 (${px}, ${negY})`)
const neg = await clickAt(px, negY)
console.log(neg.length ? neg.join('\n') : '      (无相关日志)')

// ---- 4. 正例：点宠物 ----
console.log(`\n--- 正例：点身体中心 (${px}, ${py})`)
const pos = await clickAt(px, py)
console.log(pos.length ? pos.join('\n') : '      (无相关日志)')

// ---- 4. 判定 ----
console.log('\n===== 判定 =====')
const negClean = neg.length === 0
const posTap = pos.some((l) => /triggerTapMotion/.test(l))
const posAny = pos.some((l) => /playMotion/.test(l))
console.log(`负对照（高空不应有反应）：${negClean ? '✓ 干净' : '✗ 有日志，本轮作废'}`)
console.log(`正例（点击应触发动作）：${posTap && posAny ? '✓ triggerTapMotion + playMotion 都在' : posAny ? '✗ 有动作但没走 triggerTapMotion' : '✗ 无动作日志'}`)

