#!/usr/bin/env node
/**
 * Lumii 插件开发辅助脚本（不依赖 App / Electron，Node 18+ 可直接跑）。
 *
 *   node plugin-dev.mjs validate <dir>                     静态校验
 *   node plugin-dev.mjs test <dir>                         冒烟测试（注册/加载）
 *   node plugin-dev.mjs deploy <dir> [--data-dir <dir>]    部署/升级到插件根
 *   node plugin-dev.mjs new <example> <id> [--dir <dir>]   从示例新建
 *   node plugin-dev.mjs examples                           列出示例
 *
 * 所有命令输出一行 JSON（退出码非 0 表示失败），方便 Agent 直接解析。
 *
 * 数据根默认 `~/.lumii`，可用 `--data-dir` 或环境变量 `LUMII_DATA_DIR` 覆盖
 * （dev 实例通常要指到它自己的数据目录）。
 */
import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import vm from 'node:vm'

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url))
const SKILL_DIR = path.resolve(SCRIPT_DIR, '..')
const EXAMPLES_DIR = path.join(SKILL_DIR, 'examples')

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/

const KNOWN_SLOTS = new Set([
  'app.view',
  'app.nav',
  'app.overlay',
  'app.titlebar.actions',
  'dashboard.main',
  'dashboard.grid',
  'dashboard.plugins',
  'workspace.version',
  'settings.section',
])
const SLOT_PREFIXES = ['settings.category.', 'settings.channel.', 'settings.section.']

function out(result, code = 0) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
  process.exit(code)
}

function fail(error, extra = {}) {
  out({ ok: false, error, ...extra }, 1)
}

function parseArgs(argv) {
  const args = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--data-dir') args.dataDir = argv[++i]
    else if (a === '--dir') args.dir = argv[++i]
    else args._.push(a)
  }
  return args
}

function dataDir(args) {
  return path.resolve(args.dataDir || process.env.LUMII_DATA_DIR || path.join(os.homedir(), '.lumii'))
}

function rootsFor(args) {
  const data = dataDir(args)
  return { data, plugins: path.join(data, 'plugins'), extensions: path.join(data, 'extensions') }
}

function isFile(p) {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

function findRoot(dir) {
  let cur = path.resolve(dir)
  for (let depth = 0; depth <= 3; depth++) {
    if (isFile(path.join(cur, 'main.js')) || isFile(path.join(cur, 'client.js'))) return cur
    let entries
    try {
      entries = readdirSync(cur).filter((e) => !e.startsWith('.') && e !== '__MACOSX')
    } catch {
      return null
    }
    if (entries.length !== 1) return null
    const child = path.join(cur, entries[0])
    try {
      if (!statSync(child).isDirectory()) return null
    } catch {
      return null
    }
    cur = child
  }
  return null
}

function kindOf(root) {
  const hasMain = isFile(path.join(root, 'main.js'))
  const hasClient = isFile(path.join(root, 'client.js'))
  return hasMain && hasClient ? 'both' : hasMain ? 'main' : hasClient ? 'client' : null
}

function readMeta(root) {
  const file = path.join(root, 'plugin.json')
  if (!existsSync(file)) return { present: false, meta: {} }
  try {
    const meta = JSON.parse(readFileSync(file, 'utf8'))
    return { present: true, meta: meta && typeof meta === 'object' ? meta : {} }
  } catch (err) {
    return { present: true, meta: {}, error: `plugin.json 不是合法 JSON：${err.message}` }
  }
}

function checkSyntax(code, asModule) {
  const argv = asModule ? ['--input-type=module', '--check'] : ['--check']
  const r = spawnSync(process.execPath, argv, { input: code, encoding: 'utf8' })
  return r.status === 0 ? null : (r.stderr || '').split('\n').filter(Boolean).slice(0, 6).join('\n')
}

function compareVersions(a, b) {
  const core = (v) => v.split(/[-+]/, 1)[0].split('.').map((n) => Number(n) || 0)
  const [ac, bc] = [core(a), core(b)]
  for (let i = 0; i < 3; i++) {
    const diff = (ac[i] ?? 0) - (bc[i] ?? 0)
    if (diff !== 0) return diff
  }
  const aPre = /[-+]/.test(a)
  const bPre = /[-+]/.test(b)
  if (aPre !== bPre) return aPre ? -1 : 1
  return a.localeCompare(b)
}

function collectErrors(root) {
  const errors = []
  const warnings = []
  const kind = kindOf(root)
  if (!kind) return { errors: ['没有 main.js 或 client.js，不是有效的插件'], warnings, kind }

  const { present, meta, error: metaError } = readMeta(root)
  if (metaError) errors.push(metaError)
  if (present && !metaError) {
    if (typeof meta.id !== 'string' || !meta.id.trim()) errors.push('plugin.json 缺少 id')
    if (typeof meta.name !== 'string' || !meta.name.trim()) warnings.push('plugin.json 缺少 name（列表会显示目录名）')
    if (typeof meta.description !== 'string' || !meta.description.trim()) {
      errors.push('plugin.json 缺少 description（插件页需要展示功能说明）')
    }
    if (meta.version == null) warnings.push('plugin.json 缺少 version（同名插件将无法判断升级）')
    else if (typeof meta.version !== 'string' || !VERSION_RE.test(meta.version)) {
      errors.push(`plugin.json.version 格式不合法：「${meta.version}」，应为 x.y.z 或 x.y.z-tag`)
    }
    if (present && typeof meta.id === 'string' && meta.id.trim() !== path.basename(root)) {
      warnings.push(`plugin.json.id（${meta.id}）与目录名（${path.basename(root)}）不一致`)
    }
  } else if (!present) {
    warnings.push('没有 plugin.json：插件页会显示「未填写功能说明」，也无法做版本升级')
  }

  for (const file of ['client.js', 'main.js']) {
    const p = path.join(root, file)
    if (!isFile(p)) continue
    const code = readFileSync(p, 'utf8')
    const syntaxError = checkSyntax(code, file === 'main.js')
    if (syntaxError) errors.push(`${file} 语法错误：\n${syntaxError}`)
    if (file === 'client.js') {
      if (/^\s*import\s/m.test(code)) errors.push('client.js 必须是无构建的普通脚本，不能写 import 语句')
      if (/\brequire\s*\(/.test(code)) errors.push('client.js 不能使用 require()')
      if (/\bmodule\.exports\b/.test(code)) errors.push('client.js 不能用 module.exports（用 __LUMII_REGISTER_PLUGIN__）')
    }
    if (file === 'main.js' && /\bipcMain\./.test(code)) {
      errors.push('main.js 不能直接使用 ipcMain（停用摘不掉），请用 ctx.registerIpc / ctx.registerIpcListener')
    }
  }
  return { errors, warnings, kind, meta }
}

function commandValidate(args) {
  const dir = args._[1]
  if (!dir) fail('用法：validate <插件目录>')
  const root = findRoot(dir)
  if (!root) fail(`没有找到插件根（main.js / client.js）：${dir}`)
  const { errors, warnings, kind, meta } = collectErrors(root)
  out({ ok: errors.length === 0, command: 'validate', root, kind, meta: meta ?? {}, errors, warnings })
}

function fakeClientApi(state) {
  const record = (list) => (name, entry) => {
    list.push({ name, entry })
    return () => undefined
  }
  const storageData = new Map()
  return {
    React: {
      createElement: (type, props, ...children) => ({ type, props, children }),
      Fragment: Symbol.for('Fragment'),
      useState: (init) => [typeof init === 'function' ? init() : init, () => undefined],
      useEffect: () => undefined,
      useMemo: (fn) => fn(),
      useCallback: (fn) => fn,
      useRef: (v) => ({ current: v }),
      createContext: (v) => ({ Provider: () => null, _value: v }),
      useContext: () => undefined,
    },
    ReactDOM: { createRoot: () => ({ render: () => undefined, unmount: () => undefined }) },
    registerSlot: record(state.slots),
    registerCard: (type) => {
      state.cards.push(type)
      return () => undefined
    },
    Page: (props) => ({ type: 'Page', props }),
    format: {
      number: (n) => String(n),
      percent: (n) => `${Math.round(n * 100)}%`,
      currency: (n) => `¥${n}`,
      bytes: (n) => `${n} B`,
      date: (v) => String(v),
      dateTime: (v) => String(v),
      relative: (v) => String(v),
    },
    storage: {
      get: (k, d) => (storageData.has(k) ? storageData.get(k) : d),
      set: (k, v) => storageData.set(k, v),
      keys: () => [...storageData.keys()],
      remove: (k) => storageData.delete(k),
      clear: () => storageData.clear(),
    },
  }
}

async function testClient(root) {
  const code = readFileSync(path.join(root, 'client.js'), 'utf8')
  const state = { slots: [], cards: [], registeredIds: [], factory: null }
  const timers = []
  const sandbox = {
    console,
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length },
    clearTimeout: () => undefined,
    setInterval: () => 0,
    clearInterval: () => undefined,
    window: { electronAPI: {}, addEventListener: () => undefined, removeEventListener: () => undefined },
    document: { createElement: () => ({ style: {}, appendChild: () => undefined }) },
    __LUMII_REGISTER_PLUGIN__: (id, factory) => {
      state.registeredIds.push(id)
      if (state.factory) throw new Error('同一脚本只能注册一次插件')
      state.factory = factory
    },
  }
  const errors = []
  try {
    vm.runInNewContext(code, sandbox, { timeout: 5000, filename: 'client.js' })
  } catch (err) {
    return { errors: [`client.js 执行失败：${err.message}`], slots: [], registeredIds: state.registeredIds }
  }
  if (state.registeredIds.length === 0) {
    return { errors: ['没有调用 __LUMII_REGISTER_PLUGIN__'], slots: [], registeredIds: [] }
  }
  if (typeof state.factory !== 'function') {
    return { errors: ['__LUMII_REGISTER_PLUGIN__ 的第二个参数必须是函数'], slots: [], registeredIds: state.registeredIds }
  }
  const api = fakeClientApi(state)
  let disposer
  try {
    disposer = state.factory(api)
  } catch (err) {
    return { errors: [`注册工厂执行失败：${err.message}`], slots: [], registeredIds: state.registeredIds }
  }
  if (typeof disposer === 'function') {
    try {
      disposer()
    } catch (err) {
      errors.push(`dispose 执行失败：${err.message}`)
    }
  }
  for (const { name, entry } of state.slots) {
    if (!entry || typeof entry !== 'object') {
      errors.push(`槽位 ${name} 的条目必须是对象`)
      continue
    }
    if (typeof entry.id !== 'string' || !entry.id) errors.push(`槽位 ${name} 的条目缺少 id`)
    if (typeof entry.component !== 'function' && (typeof entry.component !== 'object' || !entry.component)) {
      errors.push(`槽位 ${name}（${entry.id}）缺少 component`)
    }
    const known = KNOWN_SLOTS.has(name) || SLOT_PREFIXES.some((p) => name.startsWith(p))
    if (!known) errors.push(`未知槽位：${name}`)
  }
  return {
    errors,
    slots: state.slots.map((s) => ({ slot: s.name, id: s.entry?.id ?? null })),
    registeredIds: state.registeredIds,
  }
}

function fakeMainCtx(state) {
  const log = () => undefined
  return {
    pluginId: 'smoke',
    log: { info: log, warn: log, error: log, debug: log },
    registerIpc: (ch) => state.ipc.push(ch),
    registerIpcListener: (ch) => state.listeners.push(ch),
    provide: (key) => state.provides.push(String(key)),
    get: () => undefined,
    require: () => undefined,
    effect: (dispose) => state.disposers.push(dispose),
    on: () => undefined,
    onWaterfall: () => undefined,
    emit: () => undefined,
    waterfall: async (x) => x,
    serial: async (x) => x,
    parallel: async () => undefined,
  }
}

async function testMain(root) {
  const file = path.join(root, 'main.js')
  const state = { ipc: [], listeners: [], provides: [], disposers: [] }
  const errors = []
  const warnings = []
  let mod
  try {
    mod = await import(`${pathToFileURL(file).href}?t=${Date.now()}`)
  } catch (err) {
    // main.js 通常 import electron / 第三方包，纯 Node 下加载失败是正常现象
    warnings.push(`纯 Node 下无法加载 main.js（可能依赖 electron），已跳过 apply 冒烟：${err.message}`)
    return { errors, warnings, ...state }
  }
  const ext = mod.default
  if (!ext || typeof ext !== 'object') errors.push('main.js 必须 export default { manifest, definition }')
  else {
    if (!ext.manifest || ext.manifest.id !== ext.definition?.id) {
      errors.push('manifest.id 与 definition.id 不一致或缺失')
    }
    if (typeof ext.definition?.apply !== 'function') errors.push('definition.apply 必须是函数')
    if (typeof ext.manifest?.description !== 'string' || !ext.manifest.description.trim()) {
      errors.push('manifest.description 必须写（插件页展示功能说明）')
    }
    if (typeof ext.manifest?.version !== 'string' || !VERSION_RE.test(ext.manifest.version)) {
      errors.push('manifest.version 格式不合法（x.y.z）')
    }
    if (typeof ext.definition?.apply === 'function') {
      try {
        await ext.definition.apply(fakeMainCtx(state))
      } catch (err) {
        warnings.push(`apply 冒烟失败（可能缺核心服务或依赖 Electron）：${err.message}`)
      }
      for (const dispose of [...state.disposers].reverse()) {
        try {
          await dispose()
        } catch (err) {
          warnings.push(`effect dispose 失败：${err.message}`)
        }
      }
    }
  }
  return { errors, warnings, ...state }
}

async function commandTest(args) {
  const dir = args._[1]
  if (!dir) fail('用法：test <插件目录>')
  const root = findRoot(dir)
  if (!root) fail(`没有找到插件根：${dir}`)
  const { errors: staticErrors, warnings, kind } = collectErrors(root)
  const result = kind === 'client' ? await testClient(root) : await testMain(root)
  const errors = [...staticErrors, ...result.errors]
  out({
    ok: errors.length === 0,
    command: 'test',
    root,
    kind,
    errors,
    warnings: [...warnings, ...(result.warnings ?? [])],
    details: {
      registeredIds: result.registeredIds ?? null,
      slots: result.slots ?? null,
      ipc: result.ipc ?? null,
      provides: result.provides ?? null,
    },
  })
}

function copyPlugin(src, dest) {
  cpSync(src, dest, {
    recursive: true,
    filter: (s) => {
      const name = path.basename(s)
      return name !== 'node_modules' && name !== '.git'
    },
  })
}

function commandDeploy(args) {
  const dir = args._[1]
  if (!dir) fail('用法：deploy <插件目录> [--data-dir <dir>]')
  const root = findRoot(dir)
  if (!root) fail(`没有找到插件根：${dir}`)
  const validation = collectErrors(root)
  if (validation.errors.length) fail('静态校验未通过，已拒绝部署', { errors: validation.errors, warnings: validation.warnings })

  const kind = validation.kind
  const meta = validation.meta ?? {}
  const id = String(meta.id || path.basename(root)).replace(/[^\w.-]+/g, '-')
  const version = typeof meta.version === 'string' ? meta.version : null
  const roots = rootsFor(args)
  const targetRoot = kind === 'main' || kind === 'both' ? roots.extensions : roots.plugins
  const target = path.join(targetRoot, id)

  if (!existsSync(target)) {
    mkdirSync(targetRoot, { recursive: true })
    copyPlugin(root, target)
    out({ ok: true, command: 'deploy', action: 'install', id, version, target, kind })
  }

  // 已存在 → 只在版本更高时升级
  const installed = readMeta(target).meta
  const installedVersion = typeof installed.version === 'string' ? installed.version : null
  if (!installedVersion || !version) {
    fail('同名插件已存在，但缺少可比较的 version（plugin.json），无法升级', {
      id,
      installedVersion,
      incomingVersion: version,
    })
  }
  if (compareVersions(version, installedVersion) <= 0) {
    fail(`已安装 ${installedVersion}，部署版本 ${version} 不高于已安装版本，已拒绝`, {
      id,
      installedVersion,
      incomingVersion: version,
    })
  }

  const backupRoot = path.join(roots.data, '.plugin-backup')
  const backup = path.join(backupRoot, `${id}-${Date.now()}`)
  mkdirSync(backupRoot, { recursive: true })
  renameSync(target, backup)
  try {
    copyPlugin(root, target)
    rmSync(backup, { recursive: true, force: true })
  } catch (err) {
    rmSync(target, { recursive: true, force: true })
    renameSync(backup, target)
    fail(`升级失败，已还原旧版本：${err.message}`, { id })
  }
  out({
    ok: true,
    command: 'deploy',
    action: 'upgrade',
    id,
    from: installedVersion,
    to: version,
    target,
    kind,
  })
}

function replaceInTree(dir, from, to) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      replaceInTree(p, from, to)
    } else if (/\.(js|json|md|txt|css|html)$/i.test(entry.name)) {
      const text = readFileSync(p, 'utf8')
      if (text.includes(from)) writeFileSync(p, text.split(from).join(to))
    }
  }
}

function commandNew(args) {
  const example = args._[1]
  const id = args._[2]
  if (!example || !id) fail('用法：new <example> <id> [--dir <父目录>]')
  if (!/^[\w.-]+$/.test(id)) fail(`插件 id 只能包含字母数字与 . _ -：${id}`)
  const src = path.join(EXAMPLES_DIR, example)
  if (!existsSync(src)) fail(`没有这个示例：${example}`, { examples: listExamples() })
  const kind = kindOf(src)
  const roots = rootsFor(args)
  const parent = args.dir
    ? path.resolve(args.dir)
    : kind === 'main' || kind === 'both'
      ? roots.extensions
      : roots.plugins
  const target = path.join(parent, id)
  if (existsSync(target)) fail(`目录已存在：${target}`)
  mkdirSync(parent, { recursive: true })
  cpSync(src, target, { recursive: true })
  replaceInTree(target, '__PLUGIN_ID__', id)
  out({ ok: true, command: 'new', example, id, kind, target })
}

function listExamples() {
  if (!existsSync(EXAMPLES_DIR)) return []
  return readdirSync(EXAMPLES_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = path.join(EXAMPLES_DIR, e.name)
      const { meta } = readMeta(dir)
      return {
        name: e.name,
        kind: kindOf(dir),
        description: typeof meta.description === 'string' ? meta.description : '',
        dir,
      }
    })
}

function commandExamples() {
  out({ ok: true, command: 'examples', examples: listExamples() })
}

const args = parseArgs(process.argv.slice(2))
const command = args._[0]
const handlers = {
  validate: commandValidate,
  test: commandTest,
  deploy: commandDeploy,
  new: commandNew,
  examples: commandExamples,
}
if (!command || !handlers[command]) {
  out({
    ok: false,
    error: `未知命令：${command ?? '(空)'}`,
    usage: ['validate <dir>', 'test <dir>', 'deploy <dir> [--data-dir <dir>]', 'new <example> <id> [--dir <dir>]', 'examples'],
  }, 1)
}
try {
  await handlers[command](args)
} catch (err) {
  fail(err?.message ?? String(err))
}
