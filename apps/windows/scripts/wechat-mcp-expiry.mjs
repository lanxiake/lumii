/**
 * 内置有效期的构建期注入（主产品 wechat-mcp + 四件套，五个构建脚本共用一份）。
 *
 * 打包时把「构建日期 + N 天」写成一个 `expiry.py`（`BUILT_EXPIRY = <unix 秒>`）放进
 * PyInstaller 的搜索路径；运行时 `resources/wechat-mcp/builtin_expiry.py` 读它判到期。
 * **工作区不落这个文件**——跑源码 = 不判到期，那是开发/测试场景。
 *
 * 用法（各构建脚本自己调；`--days` 缺省 365）：
 *
 *     node scripts/build-wechat-mcp.mjs --days 180
 *
 * **为什么 `--if-stale` 不能只看 mtime**：有效期是从**构建那一刻**算起的，一份躺在磁盘上
 * 不动的旧 exe，剩余天数每天都在少。只看"产物比源码新"就跳过，会发出一份有效期只剩几天的
 * exe——而且是静默的。所以跳过条件多一条：**剩余有效期 > STALE_MARGIN_DAYS**。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 默认有效期天数 */
export const DEFAULT_DAYS = 365
/** `--if-stale` 的额外门槛：剩余不足这么多天就重新构建 */
export const STALE_MARGIN_DAYS = 30

/**
 * 解析 `--days`（缺省 `DEFAULT_DAYS`）
 * @param {string[]} argv 命令行参数
 * @returns {number} 天数
 */
export function parseDays(argv = process.argv) {
  const i = argv.indexOf('--days')
  if (i < 0) return DEFAULT_DAYS
  const v = Number.parseInt(argv[i + 1], 10)
  if (!Number.isFinite(v) || v < 1) throw new Error(`--days 只认正整数，收到 ${argv[i + 1]}`)
  return v
}

/**
 * 往打包源码目录写 `expiry.py`
 * @param {string} dir 该模块要落进哪个目录（必须在该次构建的 `--paths` 里）
 * @param {number} days 有效期天数
 * @returns {number} 写进去的到期时刻（unix 秒）
 */
export function writeExpiryPy(dir, days) {
  const exp = Math.floor(Date.now() / 1000) + days * 86400
  fs.writeFileSync(path.join(dir, 'expiry.py'), `# 构建期生成：本产物的内置有效期\nBUILT_EXPIRY = ${exp}\n`)
  return exp
}

/**
 * 产物还剩多少天有效期（按 exe 的 **mtime** 反推）。
 *
 * 为什么不问 exe 自己：`--expiry-status` 冷启动要解包 1–3s（这条在 wechat-mcp 那边实测过），
 * 而且四件套那个开关出的是给人看的中文，不是 JSON。mtime 与"构建那一刻"只差 PyInstaller
 * 写文件的那几秒，相对于 30 天的门槛可以忽略。
 *
 * ⚠️ **前提是同一个人一直用同一个 `--days`**：这里算的是"mtime + **本次命令行**的 days"，
 * 而产物里烤的是**上次构建时**的 days。所以别拿一个跟上次不同的 `--days` 去跑 `--if-stale`
 * （那会算出一个比实际乐观的值）。想知道产物**真正**剩多少天，问它自己：
 * `wechat-mcp.exe --expiry-status` / `wechat-*-mcp.exe --expiry-status`。
 *
 * @param {string} exe 产物路径
 * @param {number} days 本次构建用的有效期天数
 * @returns {number} 剩余天数
 */
export function remainingDays(exe, days) {
  const builtSec = fs.statSync(exe).mtimeMs / 1000
  return (builtSec + days * 86400 - Date.now() / 1000) / 86400
}
