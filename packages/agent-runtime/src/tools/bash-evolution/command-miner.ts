/**
 * CommandPatternMiner — bash 命令模式挖掘（纯函数）
 *
 * 「工具进化」管道的第一级：把逐条 bash 调用归一化为参数化模式，
 * 聚合频率 / 错误率 / 持续天数，过滤掉不值得工具化的命令。
 *
 * 归一化思路：只抽象「参数位」，保留命令结构（命令名、子命令、flags），
 * 使同一操作的重复调用收敛到同一模式。抽象顺序敏感：
 * 引号 → 路径 → git 消息位 → 数字 → 带扩展名文件。
 */

/** 单条 bash 调用样本 */
export interface CommandSample {
  command: string
  isError: boolean
  durationMs: number | null
  /** ISO 时间字符串，用于计算出现天数 */
  createdAt: string
}

/** 挖掘出的命令模式 */
export interface CommandPattern {
  /** 归一化模式（参数位为 {{path}}/{{num}}/{{string}}/{{msg}}/{{file}}） */
  pattern: string
  count: number
  errorCount: number
  /** 0-1 */
  errorRate: number
  avgDurationMs: number | null
  /** 出现天数（按 created_at 日期去重） */
  distinctDays: number
  /** 原始命令样本（最多 maxSamplesKept 条，供 LLM 草拟参考） */
  samples: string[]
}

export interface MinerOptions {
  /** 最少样本数，低于此值不产出（默认 5） */
  minSamples?: number
  /** 模式字符串最小长度（默认 20），过短的简单命令不值得工具化 */
  minPatternLength?: number
  /** 每个模式保留的样本数（默认 10） */
  maxSamplesKept?: number
}

/** 已有专用工具覆盖的命令前缀（与 bash-tool description 的"NEVER use bash for"清单一致） */
const DEDICATED_TOOL_PREFIXES = [
  'cat', 'head', 'tail', 'ls', 'find', 'grep',
  'mkdir', 'cp', 'mv', 'sed', 'awk',
  'echo >', 'dir ',
]

/** 将命令链按 && / || / ; / 换行拆分为独立命令段 */
export function splitCommandChain(command: string): string[] {
  return command
    .split(/(?:&&|\|\||;)/)
    .flatMap((seg) => seg.split(/\r?\n/))
    .map((seg) => seg.trim())
    .filter((seg) => seg.length > 0)
}

/** 把单条命令归一化为模式（参数抽象） */
export function normalizeCommand(command: string): string {
  let out = command.trim()

  // 1. 引号内容（含引号本身）→ {{string}}
  out = out.replace(/"[^"]*"|'[^']*'/g, '{{string}}')

  // 2. 路径：Windows 盘符 / POSIX 绝对 / 相对（含 ./ ../）
  //    负向后顾防止吃掉 `dir/file` 中间的片段（如 scripts/build.js 的 /build.js）
  out = out.replace(
    /(?:[A-Za-z]:[\\/][\w.\-~\\/ ]+|(?<![A-Za-z0-9_\-])\/[\w.\-~\/]+|(?<![A-Za-z0-9_\-])\.\.?\/[\w.\-~\/]+)/g,
    '{{path}}',
  )

  // 3. git commit -m <消息> 位 → {{msg}}
  out = out.replace(/-m\s+\{\{string\}\}/g, '-m {{msg}}')

  // 4. 独立纯数字 → {{num}}（不碰标识符内数字）
  out = out.replace(/(?<![A-Za-z0-9_])\d+(?![A-Za-z0-9_])/g, '{{num}}')

  // 5. 含扩展名的文件 token（允许相对路径段，如 scripts/foo.js）→ {{path}}
  //    命令名/子命令不带扩展名，不受影响
  out = out.replace(
    /(?:[A-Za-z0-9_\-]+\/)*[A-Za-z0-9_\-]+\.(?:md|tsx?|jsx?|mjs|cjs|jsonc?|css|scss|html?|txt|csv|ya?ml|toml|py|sh|bat|ps1|sql|png|jpe?g|gif|svg|webp|ico|pdf|docx?|xlsx?|pptx?|zip|tar|gz|lock|env|log|sqlite|db)(?![A-Za-z0-9_\-])/g,
    '{{path}}',
  )

  return out
}

/** 判断模式是否已有专用工具覆盖（不值得再工具化） */
export function hasDedicatedTool(pattern: string): boolean {
  return DEDICATED_TOOL_PREFIXES.some((prefix) => pattern.startsWith(prefix))
}

interface Aggregate {
  pattern: string
  count: number
  errorCount: number
  totalDuration: number
  durationCount: number
  days: Set<string>
  samples: string[]
}

/**
 * 从样本序列挖掘命令模式候选
 *
 * @returns 按「错误率优先、频率加权」降序排列的候选列表
 */
export function mineCommandPatterns(
  samples: readonly CommandSample[],
  options: MinerOptions = {},
): CommandPattern[] {
  const { minSamples = 5, minPatternLength = 20, maxSamplesKept = 10 } = options

  const byPattern = new Map<string, Aggregate>()
  const aggFor = (pattern: string): Aggregate => {
    let agg = byPattern.get(pattern)
    if (!agg) {
      agg = {
        pattern,
        count: 0,
        errorCount: 0,
        totalDuration: 0,
        durationCount: 0,
        days: new Set(),
        samples: [],
      }
      byPattern.set(pattern, agg)
    }
    return agg
  }

  for (const s of samples) {
    const segments = splitCommandChain(s.command)
    if (segments.length === 0) continue
    for (const seg of segments) {
      const pattern = normalizeCommand(seg)
      if (pattern.length === 0) continue
      const agg = aggFor(pattern)
      agg.count++
      if (s.isError) agg.errorCount++
      if (s.durationMs !== null && s.durationMs !== undefined && s.durationMs >= 0) {
        agg.totalDuration += s.durationMs
        agg.durationCount++
      }
      // 出现天数：按日期部分去重（ISO 字符串前 10 位）
      const day = String(s.createdAt).slice(0, 10)
      if (day) agg.days.add(day)
      if (agg.samples.length < maxSamplesKept && !agg.samples.includes(s.command)) {
        agg.samples.push(s.command)
      }
    }
  }

  const candidates: CommandPattern[] = []
  for (const agg of byPattern.values()) {
    if (agg.count < minSamples) continue
    if (agg.pattern.length < minPatternLength) continue
    if (hasDedicatedTool(agg.pattern)) continue

    candidates.push({
      pattern: agg.pattern,
      count: agg.count,
      errorCount: agg.errorCount,
      errorRate: agg.count > 0 ? agg.errorCount / agg.count : 0,
      avgDurationMs: agg.durationCount > 0 ? Math.round(agg.totalDuration / agg.durationCount) : null,
      distinctDays: agg.days.size,
      samples: agg.samples,
    })
  }

  // 错误率优先（高频且高犯错最值得固化），同错误率按频率
  candidates.sort((a, b) => {
    const score = (p: CommandPattern) => p.errorRate * 1000 + Math.min(p.count, 20)
    return score(b) - score(a)
  })
  return candidates
}

/** LLM 草拟默认门槛：次数必须严格大于该值（默认 100 → 至少 101） */
export const DEFAULT_MIN_COUNT_EXCLUSIVE = 100
/** 每周最多送入 LLM 的模式数 */
export const DEFAULT_TOP_N_FOR_LLM = 5

export interface HighValuePatternOptions {
  /** 次数必须严格大于该值（默认 100） */
  minCountExclusive?: number
  /** 按次数降序取前 N 个（默认 5） */
  topN?: number
}

/**
 * 从挖掘结果中选出值得调用 LLM 的高频模式：count > 门槛，按次数 Top N。
 */
export function selectHighValuePatterns(
  patterns: readonly CommandPattern[],
  options: HighValuePatternOptions = {},
): CommandPattern[] {
  const minCountExclusive = options.minCountExclusive ?? DEFAULT_MIN_COUNT_EXCLUSIVE
  const topN = options.topN ?? DEFAULT_TOP_N_FOR_LLM
  return patterns
    .filter((p) => p.count > minCountExclusive)
    .sort((a, b) => b.count - a.count || b.errorRate - a.errorRate)
    .slice(0, Math.max(0, topN))
}
