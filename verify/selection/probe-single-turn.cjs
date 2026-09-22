/**
 * single 通道选型探针 —— 量真实端点上的首字延迟与 abort 生效性。
 *
 * 为什么要有这个文件：P1 的「就地气泡」要不要做流式、abort 能不能真掐断，
 * 靠数说话，不靠推理。设计 §八.1 / 计划 §八 的结论回填自这里。
 *
 * 跑法（**必须 electron**：apiKey 是 safeStorage/DPAPI 密文，独立 node 解不开）：
 *   npx electron verify/selection/probe-single-turn.cjs
 *
 * 请求形状刻意对齐「辅助调用」那条路（router / 生图意图分级，见
 * bridge.ts::buildAuxiliaryChatStream）：**不传 reasoning 参数** —— qwen 类端点
 * 会据此显式关思考。这正是划词动作该有的形状：短输出、不烧思考预算。
 *
 * 只打印耗时，绝不打印密钥。
 */

const { app, safeStorage } = require('electron')
const fs = require('fs')
const os = require('os')
const path = require('path')

const CFG_PATH = path.join(
  process.env.USERPROFILE || process.env.HOME || '',
  '.lumii',
  'config',
  'provider.json',
)

/**
 * 把 userData 指到一份**只读拷贝**。
 *
 * Windows 上 Chromium 的 OSCrypt 把解密钥放在 `<userData>/Local State` 里，
 * 而裸跑 electron 脚本时 userData 是 `AppData/Roaming/Electron`，与应用的
 * `lumii-windows` 不是一个 —— 于是 decryptString 必然失败。
 *
 * 直接指向应用目录是不行的：Chromium 会回写 `Local State`，一旦重写，
 * 用户已存的 API Key 就再也解不开了。所以只拷那一个文件到临时目录。
 * 必须在 app ready 之前调用。
 */
function pointUserDataAtAppKey() {
  const roaming = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming')
  const candidates = ['lumii-windows', 'Lumii']
  for (const name of candidates) {
    const src = path.join(roaming, name, 'Local State')
    if (!fs.existsSync(src)) continue
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'lumii-probe-ud-'))
    fs.copyFileSync(src, path.join(scratch, 'Local State'))
    app.setPath('userData', scratch)
    return { from: name, scratch }
  }
  return null
}

const userDataInfo = pointUserDataAtAppKey()

function loadChatSlot() {
  const raw = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
  const slot = raw.slots && raw.slots.chat
  if (!slot) throw new Error('provider.json 里没有 chat 槽')
  if (!slot.enabled) throw new Error('chat 槽未启用')

  const enc = slot.apiKeyEnc || ''
  if (!enc) throw new Error('chat 槽没有 apiKeyEnc')
  const apiKey = enc.startsWith('plain:')
    ? enc.slice('plain:'.length)
    : safeStorage.decryptString(Buffer.from(enc, 'base64'))

  // 与 ensureProviderBaseUrl 同构：openai 系要补 /v1
  let baseUrl = (slot.baseUrl || '').trim().replace(/\/+$/, '')
  if (!/\/v1$/i.test(baseUrl)) baseUrl += '/v1'

  return { apiKey, baseUrl, model: slot.modelId }
}

/**
 * 单轮流式调用，记录三段时刻：
 *   firstByteMs  —— 收到第一个响应体分片（请求已被接受）
 *   firstTextMs  —— 收到第一个**非空文本增量**（气泡上能看见字的时刻）
 *   totalMs      —— 流结束
 */
async function streamOnce(apiKey, baseUrl, model, prompt, opts = {}) {
  const { abortAfterMs = 0, abortOnFirstText = false } = opts
  const t0 = Date.now()
  const ac = new AbortController()
  let abortFiredAt = null
  if (abortAfterMs > 0) {
    setTimeout(() => {
      abortFiredAt = Date.now() - t0
      ac.abort()
    }, abortAfterMs)
  }

  let firstByteMs = null
  let firstTextMs = null
  let deltas = 0
  let chars = 0
  let aborted = false
  let error = null

  try {
    const res = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        stream: true,
        temperature: 0.1,
        max_tokens: 800,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: ac.signal,
    })

    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`HTTP ${res.status} ${res.statusText} ${body.slice(0, 200)}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''

    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (firstByteMs === null) firstByteMs = Date.now() - t0

      buf += decoder.decode(value, { stream: true })
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line.startsWith('data:')) continue
        const payload = line.slice('data:'.length).trim()
        if (!payload || payload === '[DONE]') continue
        let json
        try {
          json = JSON.parse(payload)
        } catch {
          continue
        }
        const delta = json.choices && json.choices[0] && json.choices[0].delta
        const text = delta && typeof delta.content === 'string' ? delta.content : ''
        if (text.length > 0) {
          if (firstTextMs === null) {
            firstTextMs = Date.now() - t0
            if (abortOnFirstText) {
              abortFiredAt = firstTextMs
              ac.abort()
            }
          }
          deltas += 1
          chars += text.length
        }
      }
    }
  } catch (err) {
    const msg = err && err.message ? err.message : String(err)
    if ((err && err.name === 'AbortError') || /abort/i.test(msg)) aborted = true
    else error = msg
  }

  return {
    firstByteMs,
    firstTextMs,
    totalMs: Date.now() - t0,
    deltas,
    chars,
    aborted,
    abortFiredAt,
    error,
  }
}

/** 造一段长度可控的中文，避免手写一坨假内容 */
function zhText(n) {
  const unit = '划词功能要在选区上方浮出一条操作栏，点引用就把原文以 Markdown 引用块塞进草稿。'
  let s = ''
  while (s.length < n) s += unit
  return s.slice(0, n)
}

function row(name, r) {
  const v = (x) => (x === null || x === undefined ? '  -  ' : `${x}ms`)
  console.log(
    `${name.padEnd(26)} 首字节=${v(r.firstByteMs).padStart(7)} 首字=${v(r.firstTextMs).padStart(7)} ` +
      `总=${v(r.totalMs).padStart(7)} 增量=${String(r.deltas).padStart(4)} 字数=${String(r.chars).padStart(5)}` +
      (r.aborted ? `  [已 abort @${r.abortFiredAt}ms]` : '') +
      (r.error ? `  [错误 ${r.error.slice(0, 80)}]` : ''),
  )
}

app
  .whenReady()
  .then(async () => {
    if (!safeStorage.isEncryptionAvailable()) {
      console.error('safeStorage 不可用，解不开 apiKey —— 换个能解密的会话跑')
      app.exit(2)
      return
    }

    // 自检：本进程的 safeStorage 能不能自洽round-trip。过不了说明是环境问题
    // （Chromium OSCrypt 在 Windows 上把密钥放在 userData/Local State 里，
    //  进程的 userData 路径必须与写密文时那个进程一致），不是密文坏了。
    try {
      const probe = 'lumii-probe-roundtrip'
      const back = safeStorage.decryptString(safeStorage.encryptString(probe))
      console.log(
        `safeStorage 自检: ${back === probe ? '通过' : '异常'}  userData=${app.getPath('userData')}` +
          (userDataInfo ? `（密钥拷自 ${userDataInfo.from}）` : '（未找到应用的 Local State）'),
      )
    } catch (err) {
      console.log(`safeStorage 自检: 失败 (${err && err.message})  userData=${app.getPath('userData')}`)
    }

    const { apiKey, baseUrl, model } = loadChatSlot()
    console.log(`端点 ${baseUrl}  模型 ${model}`)
    console.log('（辅助调用形状：不传 reasoning，temperature=0.1，max_tokens=800）\n')

    // 1) 短 prompt：划词翻译 / 解释的量级
    row(
      '短(~150字) 直接回答',
      await streamOnce(apiKey, baseUrl, model, `只回一句话，不要解释：${zhText(120)} 这段话在讲什么？`),
    )

    // 2) 中 prompt：带选中长文的量级
    row(
      '中(~1200字) 概括',
      await streamOnce(
        apiKey,
        baseUrl,
        model,
        `用三句话概括下面这段，不要复述原文：\n\n${zhText(1150)}`,
      ),
    )

    // 3) abort 生效性：收到第一个文本增量就掐
    row(
      'abort（首字即掐）',
      await streamOnce(apiKey, baseUrl, model, `详细说明：${zhText(300)}`, {
        abortOnFirstText: true,
      }),
    )

    // 4) abort 生效性：还没出字就掐（模拟用户立刻关掉气泡）
    row(
      'abort（300ms 硬掐）',
      await streamOnce(apiKey, baseUrl, model, `详细说明：${zhText(1200)}`, { abortAfterMs: 300 }),
    )

    app.exit(0)
  })
  .catch((err) => {
    console.error('探针失败:', err && err.message ? err.message : err)
    app.exit(1)
  })
