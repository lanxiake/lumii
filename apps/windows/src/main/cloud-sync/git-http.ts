/**
 * isomorphic-git 的 HTTP 客户端（带长连接超时修正）。
 *
 * ## 为什么不能直接用 `isomorphic-git/http/node`
 *
 * 它内部用 `simple-get`，而 Node 的 https Agent 会给每条 socket 设
 * **5 秒空闲超时**（`_tls_wrap.js` 的 `socket.setTimeout(5000)`）。simple-get 在
 * `req.on('timeout')` 里直接 `abort()` 并抛 `Request timed out`。
 *
 * sync 仓库达 GB 级后，GitCode 端准备 pack 的停顿常超过 5 秒（实测 fetch 拉到一半
 * 就断，日志里连续多日全是 `同步失败: Request timed out`），于是**每次同步都死在
 * fetch**，与「仓库过大」叠加成死结。
 *
 * 修法：自定义 Agent 关掉 socket 级超时（`timeout: 0`），把超时控制权交还给
 * 调用方的墙钟超时（`FETCH_TIMEOUT_MS` 等），后者对「网络黑洞」仍有兜底。
 *
 * ⚠️ 保持 `keepAlive: false`：复用连接会把上一个请求的 socket 超时设置带过来，
 * 而 git 的 bulk 操作本来也不适合长连接。
 */
import { Agent } from 'node:https'
import baseHttp from 'isomorphic-git/http/node'

/** 关闭空闲超时的 https Agent（每次请求新建连接，超时交给上层墙钟） */
const agent = new Agent({ keepAlive: false, timeout: 0 })

/** 传给 isomorphic-git 的 `http` 参数：与官方客户端同形，只多挂一个 Agent */
export const gitHttp = {
  request(args: Parameters<typeof baseHttp.request>[0]) {
    return baseHttp.request({ ...args, agent })
  },
}
