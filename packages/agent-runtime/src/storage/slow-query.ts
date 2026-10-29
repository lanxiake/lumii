/**
 * 慢查询观测钩子
 *
 * 为什么放在 agent-runtime 而不是 Electron 侧：SQL 全部从 `LocalDatabase` 的连接适配器
 * 出去（node:sqlite 与 better-sqlite3 两条路径收敛在同一处），在那里计时才能一处覆盖全部语句。
 * 但共享包不能依赖 apps/windows 的类型与 perf 扩展，所以这里只留一个**可空的回调**：
 * 宿主启动后调 `setSlowQueryListener` 接上，没接时零开销（一次 null 判断）。
 *
 * 只记**超阈值**的语句。常规查询不产生任何输出——一天几十万次查询全记下来，
 * 慢的那几十条就没法找了。
 */

export interface SlowQuerySample {
  /** 数据库文件标识（文件名，不含目录），多库时用于区分 */
  db: string
  /** run / get / all / exec */
  op: string
  /** 归一化后的语句模板（字面量已替换为 ?） */
  sql: string
  durationMs: number
  /** 返回行数；get/exec 无数组结果时为 -1 */
  rows: number
}

export type SlowQueryListener = (sample: SlowQuerySample) => void

/** SQL 模板上限：太长会撑破诊断页与日志文件 */
export const MAX_SQL_TEMPLATE_CHARS = 200

/**
 * 监听器与阈值挂在 `globalThis` 上，**不能用模块级变量**。
 *
 * 官方扩展（perf）是独立的 esbuild bundle，`@mtbot/agent-runtime` 会被内联进去，
 * 于是同一份模块在进程里存在两个实例：扩展里注册监听器，写的是扩展那份的变量；
 * 而真正执行 SQL 的 `LocalDatabase` 在主进程 bundle 里，读的是另一份 —— 永远是 null，
 * 慢查询一条也记不到（静默失能，日志里什么都看不见）。
 * 用 `Symbol.for` 做全局单例，与 `main/kernel/cloud-sync-contract.ts` 的访问器同一做法。
 */
const STATE_KEY = Symbol.for('lumii.agent-runtime.slow-query')
const state = ((globalThis as Record<symbol, unknown>)[STATE_KEY] ??= {
  listener: null as SlowQueryListener | null,
  thresholdMs: 50,
}) as { listener: SlowQueryListener | null; thresholdMs: number }

/**
 * 接上/断开慢查询监听。传 null 断开（插件停用时必须断开，否则 perf 停了自己还在计时）。
 * 顺带设置阈值，默认 50ms——低于这个值的抖动多是正常查询计划差异，不值得记。
 */
export function setSlowQueryListener(fn: SlowQueryListener | null, threshold = 50): void {
  state.listener = fn
  state.thresholdMs = threshold > 0 ? threshold : 50
}

/** 当前生效的阈值（测试与诊断用） */
export function getSlowQueryThresholdMs(): number {
  return state.thresholdMs
}

/**
 * 把 SQL 归一化成模板：字面量换成 `?`、空白压成一个空格、超长截断。
 *
 * 目的是「同一条语句的不同参数版本」聚合到一起，同时**不把参数写进日志**——
 * 参数里可能是用户正文、搜索词、文件路径。
 *
 * 用状态机而不是一串 replace：`'It''s'` 这种转义引号、以及字符串里的 `--`
 * 都得按 SQL 的规则走，正则逐条替换会在这些地方切错。
 */
export function normalizeSql(sql: string): string {
  let out = ''
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]!
    // 单引号字符串（SQL 里用 '' 转义）
    if (ch === "'") {
      i++
      while (i < n) {
        if (sql[i] === "'") {
          if (sql[i + 1] === "'") {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      out += '?'
      continue
    }
    // 双引号标识符：保留（它通常是列名，不是数据）
    if (ch === '"') {
      const start = i
      i++
      while (i < n) {
        if (sql[i] === '"') {
          if (sql[i + 1] === '"') {
            i += 2
            continue
          }
          i++
          break
        }
        i++
      }
      out += sql.slice(start, i)
      continue
    }
    // 行注释与块注释：整段丢弃（注释里常带调试用的参数）
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < n && sql[i] !== '\n') i++
      out += ' '
      continue
    }
    if (ch === '/' && sql[i + 1] === '*') {
      i += 2
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++
      i += 2
      out += ' '
      continue
    }
    // 数字字面量（含小数、科学计数、0x 前缀）
    if (/[0-9]/.test(ch) && !/[A-Za-z_$]/.test(sql[i - 1] ?? '')) {
      while (i < n && /[0-9a-fA-FxX._eE+-]/.test(sql[i]!)) {
        // 只有在指数/十六进制上下文里才允许 +-，避免把 `1+2` 吞成一个字面量
        const c = sql[i]!
        if ((c === '+' || c === '-') && !/[eExX]/.test(sql[i - 1]!)) break
        i++
      }
      out += '?'
      continue
    }
    out += ch
    i++
  }

  const compact = out.replace(/\s+/g, ' ').trim()
  return compact.length > MAX_SQL_TEMPLATE_CHARS
    ? `${compact.slice(0, MAX_SQL_TEMPLATE_CHARS)}…`
    : compact
}

/** 计时并上报（超阈值才上报）。`fn` 抛错时照常上抛，不影响业务语义。 */
export function timeSql<T>(db: string, op: string, sql: string, fn: () => T): T {
  const active = state.listener
  if (!active) return fn()

  const startedAt = performance.now()
  try {
    const result = fn()
    report(active, db, op, sql, startedAt, result)
    return result
  } catch (err) {
    // 失败也计时：慢 + 抛错往往才是真问题（如锁等待超时）
    report(active, db, op, sql, startedAt, undefined)
    throw err
  }
}

function report(
  listener: SlowQueryListener,
  db: string,
  op: string,
  sql: string,
  startedAt: number,
  result: unknown,
): void {
  const durationMs = performance.now() - startedAt
  if (durationMs < state.thresholdMs) return
  try {
    // 行数：慢查询的真正成本不在 SQL 文本，而在**搬了多少行**。实测同一条
    // `... content_json ...` 的语句在 323–522ms 间波动，事后无从判断是库变大了
    // 还是这次恰好命中更多行；带上行数才能回答「是不是全表扫了」。
    // get/exec 没有数组结果，记 -1（不记 0，避免与「查询确实返回 0 行」混淆）。
    const rows = Array.isArray(result) ? result.length : -1
    listener({ db, op, sql: normalizeSql(sql), durationMs, rows })
  } catch {
    // 观测不得影响业务
  }
}
