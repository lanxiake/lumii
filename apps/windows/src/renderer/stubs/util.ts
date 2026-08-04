/**
 * Node `util` 模块最小 stub（renderer 环境 nodeIntegration=false，无 Node 内置模块）。
 *
 * object-inspect（qs 等库的依赖）在模块顶层访问 util.inspect.custom，
 * production rollup 不注入 Node polyfill → util 为 undefined → 白屏崩溃。
 * 此 stub 提供唯一被访问的字段，其余 API 按需可扩展。
 */

// Node 运行时用的 Symbol key，浏览器/Electron renderer 需手动声明
const customInspectSymbol =
  typeof Symbol === 'function' && typeof Symbol.for === 'function'
    ? Symbol.for('nodejs.util.inspect.custom')
    : null

export const inspect = Object.assign(
  (obj: unknown): string => String(obj),
  { custom: customInspectSymbol },
)

export default { inspect }
