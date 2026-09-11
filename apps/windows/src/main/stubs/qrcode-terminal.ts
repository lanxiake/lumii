/**
 * Stub for qrcode-terminal
 *
 * qrcode-terminal 是 @tencent-connect/qqbot-connector（QQ 扫码绑定）的传递依赖，
 * 仅用于把二维码打印到终端。客户端始终以 displayQrCodeToConsole: false 调用
 * startQrConnect，二维码走 onQrDisplayed 回调交给渲染进程画，generate 永不触发。
 *
 * 之所以要 stub 而不是让它进 bundle：qrcode-terminal 用了 Rollup 无法静态解析的
 * CJS require 形式（`require('./../vendor/QRCode/QRErrorCorrectLevel')`），
 * 直接内联会构建失败；而把 connector 整体外部化同样不可行 —— 它的 dist/cjs
 * 缺少 {"type":"commonjs"} 标记，在 "type":"module" 之下会被 Node 当 ESM 解析，
 * require() 直接抛 MODULE_NOT_FOUND。故内联 connector 的 ESM 产物 + stub 掉它。
 */

/** 与 qrcode-terminal 的签名保持一致，被调用即说明配置出错 */
function generate(_input: string, _opts?: unknown, cb?: (output: string) => void): void {
  console.warn('[qrcode-terminal stub] generate() 被调用，客户端不应向终端打印二维码')
  cb?.('')
}

export default { generate }
