/**
 * 原生 ONNX 运行时的加载顺序互斥闸（进程级）
 *
 * ## 这个文件要解决的问题（2026-09-18 实测）
 *
 * 打开 `LUMII_PALACE_VECTOR=1` 后连续 **3 次**启动都在同一指纹处崩溃：
 * ```
 * [VadEngine] [initialize] 加载 Silero VAD 模型: ...\silero_vad.onnx
 * The given version [27] is not supported, only version 1 to 14 is supported in this build.
 * Exit status 4294930435
 * ```
 *
 * ## 根因：两个不兼容的 ONNX Runtime 被 Windows 按**基名**解析到一起
 *
 * 进程里有两份 `onnxruntime.dll`：
 * | 来源 | 版本 | opset 上限 |
 * |---|---|---|
 * | `sherpa-onnx-win-x64/onnxruntime.dll`（VAD 用） | **1.27.0** | 27 ✅ |
 * | `onnxruntime-node/bin/.../onnxruntime.dll`（E5 用） | **1.14** | 14 ❌ |
 *
 * 报错文案 "only version 1 to 14" 精确对应 **1.14**。而
 * `sherpa-onnx-c-api.dll` 的字符串表里只有**裸 `onnxruntime.dll`**（二进制确认，
 * 没有路径）——Windows 的模块解析会在**已加载模块**里先按基名找，于是：
 *
 * 1. 宫殿补齐启动 → 创建 E5 流水线 → 把 **1.14** 加载进进程
 * 2. 3 秒后 VAD 预热 → sherpa 绑定到**已在进程里的 1.14**（而不是它自带的 1.27）
 * 3. 1.14 去加载 opset **27** 的 VAD 模型 → 报错 → 原生崩溃
 *
 * 隔离复现（`scripts/repro-vad-crash.mjs` / `repro-vad-concurrent.mjs`）给了同向证据：
 * - **VAD 先加载、再跑 E5** → 30 轮交替全过 ✅
 * - **E5 先跑、VAD 后加载** → 卡死在原生调用里（153 秒 CPU 仅 0.09 秒）❌
 *
 * ## 为什么不能"先关掉宫殿向量躲过去"
 *
 * 地雷是**既有的**，不是本次引入——只要有任何 E5 初始化早于 VAD，就会踩。
 * 之前没炸是因为 wiki 向量是**查询时懒加载**（必然在启动后的 VAD 之后）。
 * 宫殿补齐是第一个"启动即跑 E5"的路径，把它暴露了。
 *
 * ## 修法：门控顺序，而不是改人家的依赖
 *
 * **VAD 初始化必须排在所有 E5 初始化之前。** 这是进程级约束，故用进程级状态表达，
 * 而不是靠"两个模块各自记得排序"（那正是会漂移的东西）。
 *
 * 状态机只有三态：
 * ```
 * idle ──sherpaFirst()──> sherpaHolding ──sherpaDone()──> sherpaDone
 *   │                                                        ▲
 *   └──waitForSherpa()──> e5Running ──────────────────────────┘（不可逆）
 * ```
 * 进入 `e5Running` 后 `sherpaFirst()` 会**拒绝**——那时再加载 sherpa 已经晚了，
 * 如实报错好过让它在原生层崩掉。
 */

export type OnnxGatePhase = 'idle' | 'sherpaHolding' | 'sherpaDone' | 'e5Running'

let phase: OnnxGatePhase = 'idle'
const e5Waiters: Array<() => void> = []

/**
 * 供 VAD 初始化调用：声明"我要先占原生运行时"。
 *
 * @returns true = 可以安全加载 VAD；false = 已经有 E5 跑过，此时加载 sherpa
 *          会在原生层失败，调用方应**如实报错并跳过**，不要硬上。
 */
export function sherpaFirst(): boolean {
  if (phase === 'e5Running') return false
  if (phase === 'idle') phase = 'sherpaHolding'
  return true
}

/** VAD 初始化结束（成功或失败）后调用：放行等待中的 E5 初始化 */
export function sherpaDone(): void {
  if (phase === 'sherpaHolding') phase = 'sherpaDone'
  for (const w of e5Waiters.splice(0)) w()
}

/**
 * 供 E5 初始化调用：等 VAD 让行。
 *
 * - VAD 尚未开始（idle）→ 立即进入 `e5Running` 并返回。此后 `sherpaFirst()`
 *   会拒绝加载 VAD——顺序已定，晚了。
 * - VAD 正在初始化（sherpaHolding）→ 挂起，直到 `sherpaDone()` 放行。
 * - VAD 已完成（sherpaDone）→ 立即返回。
 */
export async function waitForSherpa(): Promise<void> {
  if (phase === 'sherpaHolding') {
    await new Promise<void>((r) => e5Waiters.push(r))
  }
  if (phase !== 'e5Running') phase = 'e5Running'
}

/** 诊断用：当前闸门状态 */
export function onnxGateState(): { phase: OnnxGatePhase; pendingE5: number } {
  return { phase, pendingE5: e5Waiters.length }
}

/** 仅测试用：重置进程级状态 */
export function __resetOnnxGateForTest(): void {
  phase = 'idle'
  e5Waiters.length = 0
}
