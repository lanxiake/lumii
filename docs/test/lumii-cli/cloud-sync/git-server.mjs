/**
 * 测试用本地 smart-HTTP Git 服务器。
 *
 * 云同步需要一个真实可 fetch/push 的远程仓库，但测试不该依赖 GitCode/GitHub
 * （需要真 token、污染真实数据）。这里把请求转给 `git http-backend`（CGI），
 * 客户端侧完全无感 —— 它仍然走 isomorphic-git 的真实 HTTP 路径。
 *
 * 额外提供两个异常注入开关，用于验证网络与鉴权失败路径：
 *  - requireAuth：校验 Basic 认证，不匹配返回 401
 *  - failNextRequests / failAll：直接返回 5xx，模拟服务端故障
 */
import http from 'node:http'
import { spawn } from 'node:child_process'

/**
 * @param {object} opts
 * @param {string} opts.root           裸仓库的父目录（GIT_PROJECT_ROOT）
 * @param {boolean} [opts.requireAuth] 是否校验 Basic 认证
 * @param {string} [opts.username]     认证用户名（默认 oauth2，同 gitcode-provider）
 * @param {string} [opts.password]     认证口令
 * @param {boolean} [opts.verbose]     打印每个请求（方法 + 路径 + 状态），排查挂起用
 */
export function createGitServer(opts) {
  const {
    root,
    requireAuth = false,
    username = 'oauth2',
    password = '',
    verbose = false,
  } = opts

  const state = {
    /** 为真时所有请求直接 5xx（模拟服务端/网络故障） */
    failAll: false,
    /** 剩余需要失败的请求数；递减到 0 后恢复正常 */
    failCount: 0,
    /** 最近一次请求的 Authorization 头（供断言） */
    lastAuthHeader: null,
    /** 请求计数（fetch/push 都会计入） */
    requestCount: 0,
    /** 请求轨迹 [{ method, path, status }] */
    requests: [],
  }

  const expectedAuth =
    'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64')

  const server = http.createServer((req, res) => {
    state.requestCount += 1
    state.lastAuthHeader = req.headers.authorization ?? null

    if (state.failAll || state.failCount > 0) {
      if (state.failCount > 0) state.failCount -= 1
      res.writeHead(503, { 'Content-Type': 'text/plain' })
      res.end('simulated git server failure')
      return
    }

    if (requireAuth && req.headers.authorization !== expectedAuth) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="lumii-test"' })
      res.end('Unauthorized')
      return
    }

    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const entry = { method: req.method, path: url.pathname, status: 0 }
    state.requests.push(entry)
    if (verbose) console.log(`[git-server] ${req.method} ${url.pathname}${url.search}`)

    const child = spawn('git', ['http-backend'], {
      env: {
        ...process.env,
        GIT_PROJECT_ROOT: root,
        GIT_HTTP_EXPORT_ALL: '1',
        PATH_INFO: url.pathname,
        QUERY_STRING: url.search.startsWith('?') ? url.search.slice(1) : url.search,
        REQUEST_METHOD: req.method ?? 'GET',
        CONTENT_TYPE: req.headers['content-type'] ?? '',
        CONTENT_LENGTH: req.headers['content-length'] ?? '',
        REMOTE_USER: username,
        HTTP_GIT_PROTOCOL: req.headers['git-protocol'] ?? '',
      },
    })

    // CGI 输出先是一段头，再是正文；需要拆出来转成真正的 HTTP 响应
    let pending = Buffer.alloc(0)
    let headersSent = false

    child.stdout.on('data', (chunk) => {
      if (headersSent) {
        res.write(chunk)
        return
      }
      pending = Buffer.concat([pending, chunk])
      const sep = pending.indexOf('\r\n\r\n')
      if (sep === -1) return

      const rawHead = pending.subarray(0, sep).toString('utf8')
      const body = pending.subarray(sep + 4)
      const headers = {}
      let status = 200
      for (const line of rawHead.split('\r\n')) {
        const i = line.indexOf(':')
        if (i === -1) continue
        const key = line.slice(0, i).trim()
        const value = line.slice(i + 1).trim()
        if (key.toLowerCase() === 'status') status = Number.parseInt(value, 10) || 200
        else headers[key] = value
      }
      res.writeHead(status, headers)
      entry.status = status
      headersSent = true
      if (body.length > 0) res.write(body)
    })

    child.stdout.on('end', () => {
      if (!headersSent) {
        res.writeHead(500, { 'Content-Type': 'text/plain' })
        res.end('git http-backend produced no output')
        return
      }
      res.end()
    })

    child.on('error', (err) => {
      if (!headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end(`git http-backend spawn failed: ${err.message}`)
    })

    child.stderr.on('data', (chunk) => {
      const text = chunk.toString('utf8').trim()
      if (text) console.error('[git-server][stderr]', text)
    })

    req.pipe(child.stdin)
    req.on('aborted', () => child.kill())
  })

  return {
    state,
    /** 启动并返回监听端口 */
    async listen() {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', resolve)
      })
      return server.address().port
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
  }
}
