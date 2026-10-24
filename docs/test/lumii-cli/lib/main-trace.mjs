/**
 * 主进程业务链路追踪（Node Inspector 断点）
 *
 * 用途：验证「设计里写的调用顺序」在真实运行时是否成立。
 * 做法：在主 bundle 的关键函数行上设断点，每次命中记录调用栈，随后立即继续。
 * 不引入任何生产调试钩子，不改行为。
 */
const PORT = Number(process.env.INSPECT_PORT || 5860)
const MAIN_URL_PART = 'out/main/index.js'

export async function connectMain() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
  const target = list.find((t) => t.webSocketDebuggerUrl)
  if (!target) throw new Error(`主进程 Inspector :${PORT} 没有可用 target（启动时加 -Inspect 5860）`)

  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = () => rej(new Error('Inspector WebSocket 连接失败'))
  })

  let id = 0
  const pending = new Map()
  const listeners = new Set()
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result)
      return
    }
    for (const fn of listeners) fn(msg)
  })

  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const myId = ++id
      pending.set(myId, { resolve, reject })
      ws.send(JSON.stringify({ id: myId, method, params }))
    })

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      includeCommandLineAPI: true,
    })
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text)
    }
    return r.result.value
  }

  return { send, evaluate, on: (fn) => listeners.add(fn), close: () => ws.close() }
}

/**
 * 从「命中行」往下挨个试，直到 V8 接受为止。
 *
 * 方法声明行（`pushActivitySnapshot(rootSessionKey) {`）本身没有可执行语句，
 * V8 会回 "Could not resolve breakpoint"；只有函数体第一条真实语句才下得上。
 * 不用文本启发式猜——直接让 V8 判定（它接受后会回 actualLocation）。
 */
async function placeBreakpoint(client, scriptId, lines, foundLine) {
  for (let i = foundLine; i < Math.min(lines.length, foundLine + 15); i++) {
    const text = lines[i].trim()
    if (!text || text.startsWith('//') || text.startsWith('*') || text.startsWith('/*')) continue
    try {
      const bp = await client.send('Debugger.setBreakpoint', { location: { scriptId, lineNumber: i } })
      if (bp.breakpointId) return { breakpointId: bp.breakpointId, lineNumber: bp.actualLocation?.lineNumber ?? i }
    } catch {
      // 这一行不可下断点，继续往下找
    }
  }
  return null
}

/** 等主 bundle 的 scriptParsed，返回 scriptId */
async function findMainScript(client) {
  const seen = []
  client.on((m) => {
    if (m.method === 'Debugger.scriptParsed' && String(m.params.url).includes(MAIN_URL_PART)) {
      seen.push(m.params.scriptId)
    }
  })
  await client.send('Debugger.enable')
  await new Promise((r) => setTimeout(r, 900))
  if (seen.length === 0) throw new Error('主进程脚本里找不到 out/main/index.js')
  return seen[seen.length - 1]
}

/**
 * 在 bundle 里按唯一文本设断点，命中即记录「调用栈 + 指定表达式」，然后自动继续。
 *
 * @param {object} client   connectMain() 的返回值
 * @param {{label:string, needle:string, expr?:string}[]} probes
 * @param {() => Promise<void>|void} trigger  触发业务动作
 * @param {number} timeoutMs
 * @returns {Promise<{events:{label:string,line:number,at:number,value?:any,stack:{fn:string,line:number}[]}[], unresolved:string[]}>}
 */
export async function traceFlow(client, probes, trigger, timeoutMs = 30_000) {
  const scriptId = await findMainScript(client)
  const { scriptSource } = await client.send('Debugger.getScriptSource', { scriptId })
  const lines = scriptSource.split('\n')

  const byBpId = new Map()
  const unresolved = []
  for (const probe of probes) {
    const idx = scriptSource.indexOf(probe.needle)
    if (idx < 0) {
      unresolved.push(probe.label)
      continue
    }
    const foundLine = scriptSource.slice(0, idx).split('\n').length - 1
    const placed = await placeBreakpoint(client, scriptId, lines, foundLine)
    if (!placed) {
      unresolved.push(`${probe.label}(无法下断点)`)
      continue
    }
    byBpId.set(placed.breakpointId, { ...probe, lineNumber: placed.lineNumber })
  }

  const events = []
  let paused = 0
  const maxHits = 400
  /** 命中回调串行化：多个断点同时命中时并发 resume 会把调试器状态搞乱 */
  let queue = Promise.resolve()
  const onMsg = (msg) => {
    if (msg.method !== 'Debugger.paused') return
    queue = queue.then(async () => {
      const hitIds = msg.params.hitBreakpoints || []
      const matched = hitIds.map((id) => byBpId.get(id)).find(Boolean)
      if (!matched) {
        await client.send('Debugger.resume').catch(() => {})
        return
      }
      const top = msg.params.callFrames[0]
      let value
      if (matched.expr) {
        try {
          const r = await client.send('Debugger.evaluateOnCallFrame', {
            callFrameId: top.callFrameId,
            expression: matched.expr,
            returnByValue: true,
            awaitPromise: false,
          })
          value = r.exceptionDetails
            ? { error: r.exceptionDetails.exception?.description || r.exceptionDetails.text }
            : r.result?.value
        } catch (err) {
          value = { error: String(err) }
        }
      }
      const stack = msg.params.callFrames.slice(0, 7).map((f) => ({
        fn: f.functionName || '(anonymous)',
        line: f.location.lineNumber + 1,
      }))
      events.push({ label: matched.label, line: matched.lineNumber + 1, at: Date.now(), value, stack })
      paused += 1
      await client.send('Debugger.resume').catch(() => {})
      if (paused >= maxHits) await client.send('Debugger.disable').catch(() => {})
    })
  }
  client.on(onMsg)

  const triggerPromise = Promise.resolve().then(trigger)
  await triggerPromise.catch(() => {})

  // 等业务跑完：调用方给的 trigger 通常只负责「发出去」，这里靠超时收尾
  await new Promise((r) => setTimeout(r, timeoutMs))
  await queue

  for (const bpId of byBpId.keys()) {
    await client.send('Debugger.removeBreakpoint', { breakpointId: bpId }).catch(() => {})
  }
  await client.send('Debugger.disable').catch(() => {})

  return { events, unresolved, lineCount: lines.length }
}
