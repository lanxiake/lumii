#!/usr/bin/env node
/**
 * 接线守卫（IPC 配对 + 工具注册）
 *
 * 背景：仓库里存在「写了一半没接上」的代码——main 注册了 handler 但 preload 从不 invoke、
 * preload 暴露了 channel 但 main 没有实现、main 推送事件但无人监听。
 * 这类断线静态类型检查（tsc）和单测都抓不到，只会在运行时静默失败。
 *
 * 为什么不用正则：本仓库的 channel 名有三种非字面量形态，正则会大面积误报——
 *   1. 模板串     ipcRenderer.invoke(`${prefix}:startLogin`)          （channel-api.ts 工厂）
 *   2. 常量表     ipcMain.handle(PET_IPC.switchMode, ...)             （shared/*.ts）
 *   3. 事件总线   createEventListener('updater:state-change', cb)      （preload 封装）
 * 实测：纯正则版本报出 16 个"孤儿 handler" + 21 个"无人监听"，逐条核实后几乎全是假阳性。
 * 因此本脚本走 TypeScript AST + 常量求值。
 *
 * 判定原则：**宁可报「无法解析」，也不报假阳性**。守卫一旦撒谎就没人信了。
 *
 * 用法：
 *   node scripts/check-wiring.mjs            # 报告（退出码 0）
 *   node scripts/check-wiring.mjs --strict   # 有断线则退出 1（清理完存量后再开）
 *   node scripts/check-wiring.mjs --verbose  # 附带列出「无法解析」的调用点
 */
import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..')
const argv = process.argv.slice(2)
const STRICT = argv.includes('--strict')
const VERBOSE = argv.includes('--verbose')
const UPDATE = argv.includes('--update')

if (argv.includes('--help') || argv.includes('-h')) {
  console.log(`接线守卫 — 扫描「写了一半没接上」的代码

用法：
  node scripts/check-wiring.mjs             报告（棘轮：只报新增，退出码 0）
  node scripts/check-wiring.mjs --strict    有新增断线则退出 1（CI 用）
  node scripts/check-wiring.mjs --update    把当前全部断线记为基线（清理后收紧）
  node scripts/check-wiring.mjs --verbose   展开基线内已知项 + 列出无法解析的调用点

判定项：
  ① main 注册了 handler 但 preload 从不引用  ② preload 引用了但 main 没实现
  ③ main 推送事件但无人监听                  ④ 工具导出但没注册进工具数组
  ⑤ 从入口走不到的文件（死代码候选）

判据说明与踩过的坑见文件头注释。`)
  process.exit(0)
}

const SRC = join(ROOT, 'apps/windows/src')
const SCAN_DIRS = [join(SRC, 'main'), join(SRC, 'preload'), join(SRC, 'shared'), join(SRC, 'renderer')]
const SKIP_DIRS = new Set(['node_modules', 'dist', 'out', 'release', '.git', '__tests__'])

const rel = (p) => relative(ROOT, p).replace(/\\/g, '/')
const isMainFile = (p) => rel(p).startsWith('apps/windows/src/main/')
const isRendererSide = (p) => {
  const r = rel(p)
  return r.startsWith('apps/windows/src/preload/') || r.startsWith('apps/windows/src/renderer/')
}

// ---------------------------------------------------------------- 文件遍历

function walk(dir, acc = []) {
  if (!existsSync(dir)) return acc
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(e.name)) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) walk(p, acc)
    else if (
      /\.tsx?$/.test(e.name) &&
      !/\.test\.tsx?$/.test(e.name) &&
      !/\.d\.ts$/.test(e.name) // 类型声明不是 import 目标，收进来只会误报
    ) {
      acc.push(p)
    }
  }
  return acc
}

// ---------------------------------------------------------------- 模块索引

/** absPath -> { sf, imports: Map<local, {module, name}>, consts: Map<name, node> } */
const modules = new Map()

function getModule(absPath) {
  if (modules.has(absPath)) return modules.get(absPath)
  const entry = { sf: null, imports: new Map(), consts: new Map() }
  modules.set(absPath, entry) // 先占位，防循环
  if (!existsSync(absPath)) return entry

  const sf = ts.createSourceFile(absPath, readFileSync(absPath, 'utf8'), ts.ScriptTarget.Latest, true)
  entry.sf = sf

  for (const stmt of sf.statements) {
    // import { A, B as C } from './x'
    if (ts.isImportDeclaration(stmt) && stmt.importClause && ts.isStringLiteral(stmt.moduleSpecifier)) {
      const spec = stmt.moduleSpecifier.text
      const target = resolveModule(absPath, spec)
      const bindings = stmt.importClause.namedBindings
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          entry.imports.set(el.name.text, {
            module: target,
            name: (el.propertyName ?? el.name).text,
          })
        }
      } else if (bindings && ts.isNamespaceImport(bindings)) {
        entry.imports.set(bindings.name.text, { module: target, name: '*' })
      }
      continue
    }
    // const X = ... / export const X = ...
    const decl = ts.isVariableStatement(stmt) ? stmt : null
    if (decl) {
      for (const d of decl.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) entry.consts.set(d.name.text, d.initializer)
      }
    }
  }
  return entry
}

/**
 * 可达性豁免：不经 import 加载的文件。
 * 目前只有 vite resolve.alias 替换的两个 Node 内置模块 stub——它们是
 * `import 'util'` / `import 'qrcode-terminal'` 的**落点**，源码里永远不会出现指向它们的说明符。
 */
const REACHABILITY_EXEMPT = new Set([
  'apps/windows/src/main/stubs/qrcode-terminal.ts',
  'apps/windows/src/renderer/stubs/util.ts',
])

/** 路径别名（与 electron.vite.config.ts / tsconfig paths 对齐） */
const ALIASES = [
  [/^@renderer\//, join(SRC, 'renderer')],
  [/^@shared\//, join(SRC, 'shared')],
  [/^@app-assets\//, join(SRC, 'assets')],
  [/^@\//, SRC],
]

function tryFile(base) {
  const cands = []
  // TS/ESM 项目用 `.js` 说明符指向 `.ts` 源文件（本仓库 main 进程即如此），必须先映射回来
  if (base.endsWith('.js')) cands.push(base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'))
  cands.push(base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx'))
  for (const cand of cands) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

/** 解析模块说明符到 .ts/.tsx；第三方包返回 null */
function resolveModule(fromFile, spec) {
  if (spec.startsWith('.')) return tryFile(resolve(dirname(fromFile), spec))
  for (const [re, base] of ALIASES) {
    if (re.test(spec)) return tryFile(join(base, spec.replace(re, '')))
  }
  return null
}

// ---------------------------------------------------------------- 求值

/**
 * 把表达式求值为「可能的 channel 字符串集合」。
 * 返回 Set<string>；无法确定时返回 null（**不猜**，交给报告列出来）。
 * scope 是标识符 -> Set<string> 的词法绑定（函数参数 / 局部 const）。
 */
/** 剥掉 as const / satisfies / 括号 / 类型断言，拿到真正的字面量节点 */
function unwrap(node) {
  let n = node
  while (
    n &&
    (ts.isAsExpression(n) ||
      ts.isSatisfiesExpression(n) ||
      ts.isParenthesizedExpression(n) ||
      ts.isTypeAssertionExpression(n))
  ) {
    n = n.expression
  }
  return n
}

function evalExpr(node, file, scope) {
  if (!node) return null

  // 'vcs:commit'
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return new Set([node.text])
  }

  // `a:b` 或 `${prefix}:startLogin`
  if (ts.isTemplateExpression(node)) {
    let acc = new Set([node.head.text])
    for (const span of node.templateSpans) {
      const vals = evalExpr(span.expression, file, scope)
      if (!vals || vals.size === 0) return null
      const next = new Set()
      for (const a of acc) for (const v of vals) next.add(a + v)
      acc = next
      const lit = span.literal.text
      acc = new Set([...acc].map((s) => s + lit))
    }
    return acc
  }

  // (expr) / expr as const / expr satisfies T —— 解包后再求值
  if (ts.isParenthesizedExpression(node)) return evalExpr(node.expression, file, scope)
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return evalExpr(node.expression, file, scope)
  }
  if (ts.isTypeAssertionExpression(node)) return evalExpr(node.expression, file, scope)

  // prefix（作用域绑定 / 模块级 const）
  if (ts.isIdentifier(node)) {
    if (scope && scope.has(node.text)) return scope.get(node.text)
    const mod = getModule(file)
    const init = mod.consts.get(node.text)
    if (init) return evalExpr(init, file, scope)
    // 从别处 import 进来的常量
    const imp = mod.imports.get(node.text)
    if (imp && imp.module) {
      const target = getModule(imp.module)
      const tinit = target.consts.get(imp.name)
      if (tinit) return evalExpr(tinit, imp.module, null)
    }
    return null
  }

  // PET_IPC.switchMode / ns.NAME
  if (ts.isPropertyAccessExpression(node)) {
    const objName = ts.isIdentifier(node.expression) ? node.expression.text : null
    if (objName) {
      const mod = getModule(file)
      const imp = mod.imports.get(objName)
      if (imp && imp.module) {
        const target = getModule(imp.module)
        const objInit = unwrap(target.consts.get(imp.name))
        if (objInit && ts.isObjectLiteralExpression(objInit)) {
          const prop = objInit.properties.find(
            (p) => ts.isPropertyAssignment(p) && p.name && p.name.text === node.name.text,
          )
          if (prop) return evalExpr(prop.initializer, imp.module, null)
        }
        if (imp.name === '*') {
          const direct = target.consts.get(node.name.text)
          if (direct) return evalExpr(direct, imp.module, null)
        }
      }
      // 同文件对象常量
      const localConst = unwrap(mod.consts.get(objName))
      if (localConst && ts.isObjectLiteralExpression(localConst)) {
        const prop = localConst.properties.find(
          (p) => ts.isPropertyAssignment(p) && p.name && p.name.text === node.name.text,
        )
        if (prop) return evalExpr(prop.initializer, file, scope)
      }
    }
    return null
  }

  return null
}

/** 从类型注解提取字符串字面量联合，如 (prefix: 'a' | 'b') -> Set{a,b} */
function literalUnionOf(param) {
  if (!param.type || !ts.isUnionTypeNode(param.type)) return null
  const out = new Set()
  for (const t of param.type.types) {
    if (ts.isLiteralTypeNode(t) && ts.isStringLiteral(t.literal)) out.add(t.literal.text)
    else return null // 有非字面量成员，整体不可信
  }
  return out.size ? out : null
}

// ---------------------------------------------------------------- 扫描

/** 调用点：{ kind, channel|null, at, raw } */
const handlers = [] // main: ipcMain.handle/on
const sends = [] // main: webContents.send
const preloadRefs = [] // preload: ipcRenderer.* / createEventListener
const listeners = [] // preload+renderer: *.on(channel) 监听
const unresolved = []
/**
 * 渲染侧（preload+renderer）出现过的**所有**字符串字面量。
 *
 * 用于「推送无人监听」的保守判定：只要 channel 名在渲染侧任何位置出现过，就不报。
 * 为什么不追求精确：监听注册的形态是开放的（ipcRenderer.on / createXxxEventListener /
 * subscribeMainEvent / channel 名放数组里遍历注册……实测四种，追不完），每漏一种就产出
 * 一批假阳性，而守卫一旦撒谎就没人信了。这里**宁可漏报**。
 */
const rendererLiterals = new Set()

const IPC_MAIN_RE = /^ipcMain$/
const IPC_RENDERER_RE = /^ipcRenderer$/

function calleeName(node) {
  // 支持 x.y(...) 与 独立函数(...)
  if (ts.isPropertyAccessExpression(node)) {
    return {
      obj: ts.isIdentifier(node.expression) ? node.expression.text : null,
      prop: node.name.text,
    }
  }
  if (ts.isIdentifier(node)) return { obj: null, prop: node.text }
  return null
}

function scanFile(absPath) {
  const mod = getModule(absPath)
  const sf = mod.sf
  if (!sf) return

  const visit = (node, scope) => {
    if (ts.isStringLiteral(node) && isRendererSide(absPath)) rendererLiterals.add(node.text)

    // 进入函数时，把「字面量联合类型参数」绑到候选集（模板串展开的关键）
    let nextScope = scope
    const params =
      ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
        ? node.parameters
        : null
    if (params) {
      const bindings = new Map(scope ?? [])
      for (const p of params) {
        if (!ts.isIdentifier(p.name)) continue
        const vals = literalUnionOf(p)
        if (vals) bindings.set(p.name.text, vals)
      }
      nextScope = bindings
    }

    if (ts.isCallExpression(node)) {
      const callee = calleeName(node.expression)
      if (callee) {
        const arg0 = node.arguments[0]
        const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
        const at = `${rel(absPath)}:${line}`
        const ch = arg0 ? evalExpr(arg0, absPath, nextScope) : null
        const raw = arg0 ? arg0.getText(sf).slice(0, 60) : '<无实参>'

        if (callee.obj && IPC_MAIN_RE.test(callee.obj)) {
          if (['handle', 'handleOnce', 'on', 'once', 'removeHandler', 'removeAllListeners'].includes(callee.prop)) {
            const isReg = callee.prop !== 'removeHandler' && callee.prop !== 'removeAllListeners'
            if (isReg) {
              if (ch) for (const c of ch) handlers.push({ channel: c, at, raw })
              else unresolved.push({ at, raw, why: 'main handler channel 无法解析' })
            }
          }
        }

        if (callee.obj && IPC_RENDERER_RE.test(callee.obj)) {
          if (['invoke', 'send', 'sendSync'].includes(callee.prop)) {
            if (ch) for (const c of ch) preloadRefs.push({ channel: c, at, raw })
            else if (!raw.includes('channel')) unresolved.push({ at, raw, why: 'preload 引用 channel 无法解析' })
          } else if (['on', 'once', 'addListener'].includes(callee.prop)) {
            if (ch) for (const c of ch) listeners.push({ channel: c, at, raw })
          }
        }

        // 监听封装（本仓库每个域各有一套同形状封装，名字按域变）：
        //   createEventListener / createPetEventListener / subscribeMainEvent ...
        // 收窄到 "…Event/…Channel" 结尾，否则 subscribeXxx(callback) 这类非 channel 调用会灌满 ⑦
        if (
          callee.prop &&
          (/^create\w*EventListener$/.test(callee.prop) || /^subscribe\w*(Event|Channel)\w*$/.test(callee.prop))
        ) {
          if (ch) for (const c of ch) listeners.push({ channel: c, at, raw })
          else unresolved.push({ at, raw, why: '事件监听 channel 无法解析' })
        }

        // renderer 直连：window.electronAPI.on('ch', cb)
        if (callee.prop === 'on' && /electronAPI/.test(node.expression.getText(sf))) {
          if (ch) for (const c of ch) listeners.push({ channel: c, at, raw })
        }

        // main -> renderer 推送：只认 main 目录里的 webContents.send（renderer 自己的
        // 同名 send 函数不是推送，收进来就是假阳性）
        if (callee.prop === 'send' && isMainFile(absPath) && /webContents\s*\.\s*send$/.test(node.expression.getText(sf))) {
          if (ch) for (const c of ch) sends.push({ channel: c, at, raw })
        }

      }
    }

    ts.forEachChild(node, (child) => visit(child, nextScope))
  }

  visit(sf, new Map())
}

// ---------------------------------------------------------------- 工具注册

function scanToolRegistry(report) {
  const dir = join(ROOT, 'packages/agent-runtime/src/tools/built-in')
  const idx = join(dir, 'index.ts')
  if (!existsSync(idx)) return
  const idxSrc = readFileSync(idx, 'utf8')
  const arrMatch = idxSrc.match(/ALL_BUILT_IN_TOOL_CONFIGS[^=]*=\s*\[([\s\S]*?)\n\]/)
  const registered = new Set((arrMatch ? arrMatch[1] : '').match(/\b\w+ToolConfig\b/g) || [])

  const exported = new Map()
  for (const f of walk(dir)) {
    const src = readFileSync(f, 'utf8')
    const re = /export\s+const\s+(\w+ToolConfig)\b/g
    let m
    while ((m = re.exec(src))) exported.set(m[1], rel(f))
  }
  report.tools = { registered, exported }
}

// ---------------------------------------------------------------- 悬空项分级

/**
 * 悬空引用分两种，危害完全不同：
 *   - renderer 真在调 → 用户点得到，一点就 reject（活 bug）
 *   - 没人调         → 只是 preload 里躺着一段死代码
 * 分级需要把 preload 的 method 映射回 channel，再对 renderer 的
 * `electronAPI.<ns>.<method>` 取交集。
 */
function collectApiMethodChannels(absPath) {
  const sf = getModule(absPath).sf
  if (!sf) return new Map()
  const out = new Map() // 'apiServerHttpApi.queryAuditLogs' -> 'api:queryAuditLogs'
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue
    for (const d of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(d.name)) continue
      const init = unwrap(d.initializer)
      if (!init || !ts.isObjectLiteralExpression(init)) continue
      for (const p of init.properties) {
        if (!ts.isPropertyAssignment(p) || !p.name) continue
        const ch = evalExpr(p.initializer, absPath, new Map())
        if (ch) for (const c of ch) out.set(`${d.name.text}.${p.name.text}`, c)
      }
    }
  }
  return out
}

/** electronAPI 的顶层命名空间装配：ns -> 变量名（`api: apiServerHttpApi`） */
function collectNamespaceMap() {
  const idx = join(SRC, 'preload/index.ts')
  const sf = getModule(idx).sf
  const out = new Map()
  if (!sf) return out
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'electronAPI') {
      const init = unwrap(node.initializer)
      if (init && ts.isObjectLiteralExpression(init)) {
        for (const p of init.properties) {
          if (ts.isPropertyAssignment(p) && p.name && ts.isIdentifier(p.initializer)) {
            out.set(p.name.text, p.initializer.text)
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/** 节点是否指向 `electronAPI` 本体（含 window. 前缀、括号/断言/可选链包裹） */
function isElectronApiRef(n) {
  if (ts.isIdentifier(n)) return n.text === 'electronAPI'
  if (ts.isPropertyAccessExpression(n)) return n.name.text === 'electronAPI'
  if (
    ts.isParenthesizedExpression(n) ||
    ts.isAsExpression(n) ||
    ts.isNonNullExpression(n) ||
    ts.isTypeAssertionExpression(n) ||
    ts.isSatisfiesExpression(n)
  ) {
    return isElectronApiRef(n.expression)
  }
  return false
}

/**
 * renderer 侧对 electronAPI 的使用，走 AST 而非正则。
 *
 * 为什么不能正则：`electronAPI\n  .api\n  .getAgents` 能匹配，但
 * `(window.electronAPI as ElectronAPI).api.getAgents`、判空包裹、属性转存
 * （`const api = window.electronAPI.api` 之后 `api.getAgents()`）都会漏——
 * 而漏检在这里的方向是**误报**（把活的判成死的，让人去删活代码）。
 */
let _rendererUsage = null
function collectRendererUsage() {
  if (_rendererUsage) return _rendererUsage
  const chained = new Map() // 'api.getAgents' -> 调用点文件
  const bare = new Set() // 任意 `.name` 属性访问到的名字（保守豁免用）
  for (const f of walk(join(SRC, 'renderer'))) {
    const sf = getModule(f).sf
    if (!sf) continue
    const visit = (node) => {
      if (ts.isPropertyAccessExpression(node)) {
        bare.add(node.name.text)
        const inner = node.expression
        if (ts.isPropertyAccessExpression(inner) && isElectronApiRef(inner.expression)) {
          const key = `${inner.name.text}.${node.name.text}`
          if (!chained.has(key)) chained.set(key, f)
        }
      }
      ts.forEachChild(node, visit)
    }
    visit(sf)
  }
  _rendererUsage = { chained, bare }
  return _rendererUsage
}

/** renderer 里实际调用到的 `electronAPI.<ns>.<method>`：调用点 -> 文件 */
function collectRendererCalls() {
  return collectRendererUsage().chained
}

/** 对象字面量的属性名（跳过 spread / 计算方法名——那两种取不到静态键） */
function keysOfObjectLiteral(objLit) {
  const out = new Set()
  for (const p of objLit.properties) {
    if (!ts.isPropertyAssignment(p) || !p.name) continue
    const n = p.name
    if (ts.isIdentifier(n) || ts.isStringLiteral(n) || ts.isNumericLiteral(n)) out.add(n.text)
  }
  return out
}

/**
 * preload 暴露给 renderer 的 `ns.method` 全集。
 *
 * electronAPI 的属性值有两种形态：内联对象字面量（`palace: {...}`）和指向别处
 * 定义的标识符（`api: apiServerHttpApi`）。后者要去 preload 目录里找同名
 * `const X = {...}`——**只认名字唯一的那种**；重名、或值是 `{...spread}` 拼的、
 * 或压根解析不出来，整个 ns 就跳过。宁可漏报也不误报。
 */
function collectExposedSurface() {
  const idx = join(SRC, 'preload/index.ts')
  const sf = getModule(idx).sf
  const out = new Map() // 'api.getAgents' -> 声明处
  if (!sf) return out

  const varKeys = new Map()
  const dup = new Set()
  for (const f of walk(join(SRC, 'preload'))) {
    const m = getModule(f)
    if (!m.sf) continue
    for (const stmt of m.sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue
        const init = unwrap(d.initializer)
        if (!init || !ts.isObjectLiteralExpression(init)) continue
        if (varKeys.has(d.name.text)) dup.add(d.name.text)
        varKeys.set(d.name.text, keysOfObjectLiteral(init))
      }
    }
  }

  const visit = (node) => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'electronAPI'
    ) {
      const init = unwrap(node.initializer)
      if (init && ts.isObjectLiteralExpression(init)) {
        for (const p of init.properties) {
          if (!ts.isPropertyAssignment(p) || !p.name) continue
          const n = p.name
          const ns = ts.isIdentifier(n) || ts.isStringLiteral(n) ? n.text : n.getText(sf)
          const val = unwrap(p.initializer)
          if (!val) continue
          let keys = null
          if (ts.isObjectLiteralExpression(val)) keys = keysOfObjectLiteral(val)
          else if (ts.isIdentifier(val) && !dup.has(val.text)) keys = varKeys.get(val.text) ?? null
          if (!keys) continue
          for (const k of keys) out.set(`${ns}.${k}`, idx)
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}

/**
 * 从入口沿静态 import 做可达性遍历。
 *
 * 为什么需要它：`useAuditLog` 这样的模块会被 barrel（index.ts）re-export，
 * 于是"被 import 过"看起来是活的；但没有任何组件真正用它，整条链路是死的。
 * 只查"是否被 import"分不出来，必须从真正的入口走一遍。
 */
function computeReachable() {
  const entries = [
    join(SRC, 'main/index.ts'),
    join(SRC, 'preload/index.ts'),
    join(SRC, 'preload/webview-selection.ts'),
    join(SRC, 'renderer/main.tsx'),
  ].filter(existsSync)

  const reachable = new Set()
  const queue = [...entries]
  const unresolvedSpecs = new Set()
  while (queue.length) {
    const f = queue.pop()
    if (reachable.has(f) || !existsSync(f)) continue
    reachable.add(f)
    const sf = getModule(f).sf
    if (!sf) continue
    // 静态 import/export + 动态 import()（本仓库大量用 await import('./x.js') 做懒加载，
    // 只认静态 import 会把半个 main 进程误判成死代码）
    const specs = []
    const collect = (node) => {
      if (
        (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
        node.moduleSpecifier &&
        ts.isStringLiteral(node.moduleSpecifier)
      ) {
        specs.push(node.moduleSpecifier.text)
      } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const a = node.arguments[0]
        if (a && ts.isStringLiteral(a)) specs.push(a.text)
      }
      ts.forEachChild(node, collect)
    }
    collect(sf)
    for (const spec of specs) {
      const target = resolveModule(f, spec)
      if (target) queue.push(target)
      else if (spec.startsWith('.')) unresolvedSpecs.add(spec)
    }
  }
  return { reachable, unresolvedSpecs, entries }
}

/**
 * 从一个方法实现里抽出它调用的 channel。
 * 方法体通常是箭头函数（`login: (p) => ipcRenderer.invoke('api:login', p)`），
 * channel 藏在函数体里——只对表达式求值是不够的，得进去找 ipcRenderer 调用。
 */
function evalMethodChannel(init, file) {
  const fn = unwrap(init)
  const body = ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) ? fn.body : null
  let found = null
  const visit = (node) => {
    if (found || !node) return
    if (ts.isCallExpression(node)) {
      const c = calleeName(node.expression)
      if (c && c.obj === 'ipcRenderer' && ['invoke', 'send', 'sendSync'].includes(c.prop)) {
        const arg0 = node.arguments[0]
        if (arg0) {
          const ch = evalExpr(arg0, file, new Map())
          if (ch) found = ch
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(body ?? fn)
  return found
}

function gradeDangling(channels, reachable) {
  const nsMap = collectNamespaceMap()
  // 变量名 -> (channel -> 方法名)，一次扫描建表
  const byVar = new Map()
  for (const f of walk(join(SRC, 'preload'))) {
    const sf = getModule(f).sf
    if (!sf) continue
    for (const stmt of sf.statements) {
      if (!ts.isVariableStatement(stmt)) continue
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name)) continue
        const init = unwrap(d.initializer)
        if (!init || !ts.isObjectLiteralExpression(init)) continue
        const m = new Map()
        for (const p of init.properties) {
          if (!ts.isPropertyAssignment(p) || !p.name) continue
          const ch = evalMethodChannel(p.initializer, f)
          if (ch) for (const c of ch) m.set(c, p.name.text)
        }
        if (m.size) byVar.set(d.name.text, m)
      }
    }
  }

  // channel -> 'ns.method'
  const toPath = new Map()
  for (const [ns, varName] of nsMap) {
    const m = byVar.get(varName)
    if (!m) continue
    for (const [ch, method] of m) toPath.set(ch, `${ns}.${method}`)
  }

  const calls = collectRendererCalls()
  const live = []
  const dead = []
  for (const ch of channels) {
    const path = toPath.get(ch)
    const callFile = path ? calls.get(path) : null
    if (callFile && reachable.has(callFile)) {
      live.push({ channel: ch, via: `electronAPI.${path}`, file: callFile })
    } else if (callFile) {
      // 有调用点，但那段 renderer 代码从入口走不到——整条链路是死的，不是活 bug
      dead.push({ channel: ch, via: `electronAPI.${path}  ← ${rel(callFile)} 不可达` })
    } else {
      dead.push({
        channel: ch,
        via: path ? `electronAPI.${path}（renderer 未调用）` : 'renderer 无对应入口',
      })
    }
  }
  return { live, dead }
}

// ---------------------------------------------------------------- 主流程

const t0 = Date.now()
const files = SCAN_DIRS.flatMap((d) => walk(d))
for (const f of files) scanFile(f)

const report = { tools: null }
scanToolRegistry(report)

const reach = computeReachable()
const unreachable = files.filter((f) => !reach.reachable.has(f) && !REACHABILITY_EXEMPT.has(rel(f)))

// ---- 配对
const uniq = (arr) => {
  const m = new Map()
  for (const x of arr) if (!m.has(x.channel)) m.set(x.channel, x)
  return m
}
const hMap = uniq(handlers)
const pMap = uniq(preloadRefs)
const sMap = uniq(sends)
const lMap = uniq(listeners)

const orphanHandlers = [...hMap.keys()].filter((c) => !pMap.has(c)).sort()
const danglingRefs = [...pMap.keys()].filter((c) => !hMap.has(c)).sort()
// 保守判定：channel 名在渲染侧任何位置出现过就不报（见 rendererLiterals 的说明）
const orphanSends = [...sMap.keys()].filter((c) => !lMap.has(c) && !rendererLiterals.has(c)).sort()

const unregisteredTools = [...report.tools.exported.keys()].filter((n) => !report.tools.registered.has(n)).sort()

// ---- ⑥ preload 暴露面 vs renderer 消费
//
// ② 的镜像：② 查「preload 引用了但 main 没实现」，这里查「main 和 preload 都齐了、
// 但 renderer 从不调用」——整条链是通的却永远不跑，tsc 和单测都看不见。
// 判定刻意保守（见 collectRendererUsage 的说明）：代价是通用名会被漏掉，
// 换的是不误报——把活的判成死的会让人直接去删活代码。
const exposed = collectExposedSurface()
const usage = collectRendererUsage()
const unconsumedMethods = [...exposed.keys()]
  .filter((k) => !usage.chained.has(k) && !usage.bare.has(k.slice(k.indexOf('.') + 1)))
  .sort()

// ---- 基线（棘轮）
//
// 仓库有 100+ 处存量断线，一次性清完不现实；但"修完没有门禁"正是上一轮重构失败的根因。
// 因此与 scripts/check-large-files.mjs 同策略：**只禁止新增**。清理后跑 --update 收紧。
const BASELINE_PATH = join(ROOT, 'scripts', 'wiring-baseline.json')

function loadBaseline() {
  if (!existsSync(BASELINE_PATH)) return null
  try {
    return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'))
  } catch {
    return null
  }
}

const baseline = UPDATE ? null : loadBaseline()
const baselineHas = (key) => new Set(baseline && Array.isArray(baseline[key]) ? baseline[key] : [])
/** 拆成「本次新增」与「基线内已知」；无基线时一律算已知（首次运行不该满屏红） */
function splitNew(items, key) {
  if (!baseline) return { fresh: [], known: items }
  const known = baselineHas(key)
  return { fresh: items.filter((x) => !known.has(x)), known: items.filter((x) => known.has(x)) }
}

if (UPDATE) {
  const out = {
    _comment:
      '接线守卫基线（棘轮）：这里的断线是已知存量，守卫只报新增。清理后跑 node scripts/check-wiring.mjs --update 收紧。',
    _updated: new Date().toISOString().slice(0, 10),
    orphanHandlers,
    danglingRefs,
    orphanSends,
    unregisteredTools,
    unreachable: unreachable.map(rel).sort(),
    unconsumedMethods,
  }
  writeFileSync(BASELINE_PATH, JSON.stringify(out, null, 2) + '\n', 'utf8')
  console.log(`已写入基线 ${rel(BASELINE_PATH)}：`)
  console.log(
    `  孤儿 handler ${orphanHandlers.length}｜悬空引用 ${danglingRefs.length}｜` +
      `无人监听 ${orphanSends.length}｜未注册工具 ${unregisteredTools.length}｜` +
      `不可达文件 ${unreachable.length}｜无消费者 ${unconsumedMethods.length}`,
  )
  process.exit(0)
}

// ---- 输出
const B = (s) => `\x1b[1m${s}\x1b[0m`
const RED = (s) => `\x1b[31m${s}\x1b[0m`
const YEL = (s) => `\x1b[33m${s}\x1b[0m`
const GRN = (s) => `\x1b[32m${s}\x1b[0m`
const DIM = (s) => `\x1b[2m${s}\x1b[0m`

const section = (t) => console.log(`\n${B(t)}`)
/** 没有基线（首次运行）或 --verbose 时都展开已知项，否则折叠成一行 */
const expandKnown = VERBOSE || !baseline

console.log(B('接线守卫 — IPC 配对与工具注册（棘轮：只报新增）'))
console.log(
  `扫描 ${files.length} 个文件（main/preload/shared/renderer）｜` +
    `handler ${hMap.size} ｜preload 引用 ${pMap.size} ｜推送 ${sMap.size} ｜监听 ${lMap.size}` +
    (baseline ? `｜基线 ${baseline._updated}` : '｜无基线'),
)

// ①
{
  const { fresh, known } = splitNew(orphanHandlers, 'orphanHandlers')
  section(`① main 注册了 handler，preload 从不引用（renderer 永远调不到）— 新增 ${fresh.length}`)
  for (const c of fresh) console.log(`  ${RED('✗')} ${c}\n      ${hMap.get(c).at}`)
  if (expandKnown) for (const c of known) console.log(`  ${DIM('·')} ${DIM(c)}  ${DIM(hMap.get(c).at)}`)
  else if (known.length) console.log(`  ${DIM(`基线内已知 ${known.length} 处（--verbose 展开）`)}`)
}

// ②
const graded = gradeDangling(danglingRefs, reach.reachable)
{
  const { fresh } = splitNew(danglingRefs, 'danglingRefs')
  const freshSet = new Set(fresh)
  section(
    `② preload 引用了，main 没有实现（调用必然 reject）— 新增 ${fresh.length} / 已知 ${danglingRefs.length - fresh.length}`,
  )
  const part = (list, isFresh) =>
    isFresh ? list.filter((x) => freshSet.has(x.channel)) : list.filter((x) => !freshSet.has(x.channel))

  for (const [list, tag, color, mark] of [
    [part(graded.live, true), '【活 bug·新增】renderer 会调到，用户一点就报错', RED, '✗'],
    [part(graded.dead, true), '【死代码·新增】preload 里躺着，renderer 不调', YEL, '·'],
  ]) {
    if (!list.length) continue
    console.log(`  ${color(tag)}：`)
    for (const x of list) console.log(`    ${color(mark)} ${x.channel}\n        ${pMap.get(x.channel).at}  —  ${x.via}`)
  }

  const oldLive = part(graded.live, false)
  const oldDead = part(graded.dead, false)
  if (oldLive.length) {
    console.log(`  ${DIM(`基线内已知的活 bug ${oldLive.length} 处：${oldLive.map((x) => x.channel).join('、')}`)}`)
  }
  if (expandKnown) {
    for (const x of oldDead) console.log(`  ${DIM('·')} ${DIM(x.channel)}  ${DIM(x.via)}`)
  } else if (oldDead.length) {
    console.log(`  ${DIM(`基线内已知的死代码 ${oldDead.length} 处（--verbose 展开）`)}`)
  }
}

// ③
{
  const { fresh, known } = splitNew(orphanSends, 'orphanSends')
  section(`③ main 推送事件，但无人监听（事件石沉大海）— 新增 ${fresh.length}`)
  for (const c of fresh) console.log(`  ${RED('!')} ${c}\n      ${sMap.get(c).at}`)
  if (expandKnown) for (const c of known) console.log(`  ${DIM('·')} ${DIM(c)}  ${DIM(sMap.get(c).at)}`)
  else if (known.length) console.log(`  ${DIM(`基线内已知 ${known.length} 处（--verbose 展开）`)}`)
}

// ④
{
  const { fresh, known } = splitNew(unregisteredTools, 'unregisteredTools')
  section(`④ 工具导出但未注册进 ALL_BUILT_IN_TOOL_CONFIGS — 新增 ${fresh.length}`)
  for (const n of fresh) console.log(`  ${RED('!')} ${n}\n      ${report.tools.exported.get(n)}`)
  if (expandKnown)
    for (const n of known) console.log(`  ${DIM('·')} ${DIM(n)}  ${DIM(report.tools.exported.get(n))}`)
  else if (known.length) console.log(`  ${DIM(`基线内已知 ${known.length} 处（--verbose 展开）`)}`)
}

// ⑤
{
  const relPaths = unreachable.map(rel).sort()
  const { fresh, known } = splitNew(relPaths, 'unreachable')
  section(`⑤ 从入口走不到的文件（死代码候选）— 新增 ${fresh.length} / 已知 ${known.length}`)
  if (fresh.length || expandKnown) {
    console.log(`  ${DIM(`入口：${reach.entries.map(rel).join('、')}`)}`)
  }
  for (const f of fresh) console.log(`  ${RED('✗')} ${f}`)
  if (expandKnown) for (const f of known) console.log(`  ${DIM('·')} ${DIM(f)}`)
  else if (known.length) console.log(`  ${DIM(`基线内已知 ${known.length} 个（--verbose 展开）`)}`)
  if (fresh.length || expandKnown) {
    console.log(
      `  ${YEL('注：')}只走静态 import + 动态 import()。vite alias 替换的模块、字符串路径加载的文件会误报。`,
    )
  }
}

// ⑥
{
  const { fresh, known } = splitNew(unconsumedMethods, 'unconsumedMethods')
  section(
    `⑥ preload 暴露了，但 renderer 从不调用（链路通却没消费者）— 新增 ${fresh.length} / 已知 ${known.length}`,
  )
  for (const k of fresh) console.log(`  ${RED('·')} electronAPI.${k}`)
  if (expandKnown) for (const k of known) console.log(`  ${DIM('·')} ${DIM(`electronAPI.${k}`)}`)
  else if (known.length) console.log(`  ${DIM(`基线内已知 ${known.length} 处（--verbose 展开）`)}`)
  if (fresh.length || expandKnown) {
    console.log(
      `  ${YEL('注：')}方法名只要在 renderer 里以任何 \`.name\` 出现过就豁免（转存/别名追不到属主），` +
        `报的是连名字都没出现过的那些，通用名会漏。`,
    )
  }
}

if (VERBOSE && reach.unresolvedSpecs.size) {
  // 按扩展名归类：.css / .json / 图片等资源导入解析不到是正常的（它们不是 TS 模块）。
  // **没有扩展名的**才可疑——那多半是别名没覆盖到，会让 ⑤ 漏报。
  const byExt = new Map()
  for (const s of reach.unresolvedSpecs) {
    const m = s.match(/(\.[a-z0-9]+)$/i)
    const k = m ? m[1] : '(无扩展名·可疑)'
    byExt.set(k, (byExt.get(k) ?? 0) + 1)
  }
  section(`⑦ 未能解析的相对说明符（影响 ⑤ 的覆盖面）— ${reach.unresolvedSpecs.size} 种`)
  for (const [ext, n] of [...byExt].sort((a, b) => b[1] - a[1])) {
    console.log(`  ${ext === '(无扩展名·可疑)' ? YEL(ext) : DIM(ext)}  ${n}`)
  }
  const suspicious = [...reach.unresolvedSpecs].filter((s) => !/\.[a-z0-9]+$/i.test(s))
  for (const s of suspicious.slice(0, 20)) console.log(`  ${YEL('?')} ${s}`)
}

if (VERBOSE && unresolved.length) {
  section(`⑧ 无法静态解析的调用点（不计入上面任何判定）— ${unresolved.length}`)
  for (const u of unresolved.slice(0, 60)) console.log(`  ? ${u.at}\n      ${u.raw}  (${u.why})`)
  if (unresolved.length > 60) console.log(`  ... 另有 ${unresolved.length - 60} 处`)
}

// ---- 结论
const freshCount =
  splitNew(orphanHandlers, 'orphanHandlers').fresh.length +
  splitNew(danglingRefs, 'danglingRefs').fresh.length +
  splitNew(orphanSends, 'orphanSends').fresh.length +
  splitNew(unregisteredTools, 'unregisteredTools').fresh.length +
  splitNew(unreachable.map(rel), 'unreachable').fresh.length +
  splitNew(unconsumedMethods, 'unconsumedMethods').fresh.length

console.log(
  `\n${
    freshCount === 0
      ? GRN('通过：没有新增断线')
      : RED(`新增断线 ${freshCount} 处（基线 ${baseline?._updated ?? '无'}）`)
  }｜耗时 ${Date.now() - t0}ms`,
)
if (!baseline) console.log(DIM('提示：这是首次运行（无基线），上面列的是全部存量。跑 --update 建立基线后即只报新增。'))

if (STRICT && freshCount > 0) process.exit(1)
