/**
 * TTS 引擎注册表。
 *
 * 每个 TTS 引擎是**独立插件**（`builtin/tts-<engine>/`），在 `apply(ctx)` 里注册自己；
 * voice 插件不 import 任何引擎实现（守卫 ⑪ / ⑫），只在这里按 id 查找。
 *
 * **为什么不是 `S.*` 服务 key**：服务容器是单值槽位，而这里需要的是**动态集合**
 * （启停任意个子集）。用注册表就不依赖插件加载顺序——启动期不装配，使用时才查。
 *
 * 与 `plugins/active.ts` 不同，这里用普通模块级 Map 而非 `Symbol.for` 全局：
 * 所有引擎都是主进程静态 import，与 voice 插件共享同一个模块实例。
 */
import type { TtsOutputFormat, TtsProvider } from './tts-engine'
import type { VoiceTtsConfig } from './voice-events'

/** voice 插件交给引擎的宿主能力：模型目录、就绪判定、克隆档案 */
export interface TtsHostContext {
  /** 解析某个模型 id 的落盘目录（不存在时返回预期路径） */
  modelDir(modelId: string): string
  /** 模型是否已下载完成 */
  isModelReady(modelId: string): boolean
  /** Qwen3 克隆音色档案；其他引擎用不到，返回 null 即可 */
  getVoiceProfile(
    id: string,
  ): { refAudioPath: string; refText: string; language?: string; xVectorOnly?: boolean } | null
  log: (...args: unknown[]) => void
}

export interface TtsEngineEntry {
  /** 配置里的 `tts.provider` 值，如 `edge` / `local-vits` / `qwen3` / `breeze` */
  id: string
  /** 设置页下拉的显示名 */
  label: string
  /** 该引擎拥有的模型 id（供模型面板按启用插件过滤；无本地模型则为空数组） */
  modelIds: string[]
  /**
   * 建议合成并发（句级并行）。可以是函数：Qwen3 的并发取决于 sidecar 池大小，
   * 静态数字会在池大小变化后失真。
   */
  concurrency: number | (() => number)
  /** 输出格式：`mp3` 时 voice-service 会把 chunk 的 sampleRate 标成 -1 */
  outputFormat: TtsOutputFormat
  /**
   * 除「模型下载完」之外的可用性条件。
   *
   * 有本地模型的引擎靠 `modelIds` 判定就够；不下载模型、但需要用户先配好外部
   * 服务的引擎（Breeze）得自己回答「现在能不能用」。返回 false 时下拉里会置灰，
   * 而不是等用户选中后才在合成时抛错。
   */
  isReady?: (cfg: VoiceTtsConfig) => boolean
  create(host: TtsHostContext, cfg: VoiceTtsConfig): Promise<TtsProvider>
}

const engines = new Map<string, TtsEngineEntry>()

/** 注册一个引擎；返回注销函数（插件放在 `ctx.effect(...)` 里）。 */
export function registerTtsEngine(entry: TtsEngineEntry): () => void {
  if (engines.has(entry.id)) {
    throw new Error(`TTS 引擎 id 重复: ${entry.id}`)
  }
  engines.set(entry.id, entry)
  return () => {
    // 只删自己，避免误删同 id 的后来者
    if (engines.get(entry.id) === entry) engines.delete(entry.id)
  }
}

export function getTtsEngine(id: string): TtsEngineEntry | null {
  return engines.get(id) ?? null
}

/** 已注册引擎（按注册顺序）。设置页下拉与模型过滤都用它。 */
export function listTtsEngines(): TtsEngineEntry[] {
  return [...engines.values()]
}

/** 已注册引擎声明的全部模型 id 的并集 */
export function enabledTtsModelIds(): Set<string> {
  const out = new Set<string>()
  for (const e of engines.values()) {
    for (const id of e.modelIds) out.add(id)
  }
  return out
}
