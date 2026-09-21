/**
 * onnxruntime-web 的**占位包**。
 *
 * ## 为什么要顶掉真的包（2026-09-21）
 *
 * 桌面端从不用它：`@xenova/transformers` 在 Node 下走 `onnxruntime-node`
 * （`src/backends/onnx.js` 里 `process.release.name === 'node'` 分支），web 那份
 * 只在浏览器分支用。但它的 `backends/onnx.js` 是**顶层静态 import**：
 *
 *     import * as ONNX_NODE from 'onnxruntime-node';
 *     import * as ONNX_WEB  from 'onnxruntime-web';
 *
 * 两个包必须都能解析，否则 `require('@xenova/transformers')` 直接抛
 * ERR_MODULE_NOT_FOUND —— 而应用对此是**静默降级**（回退 `bigram-hash` 嵌入，
 * 检索质量明显下降且不报错，见 wiki-transformers-embedder.ts 的 warn 分支）。
 *
 * 真实包 66 MB（4 个 wasm 36.7 MB + JS 与 sourcemap ~26 MB），全部用不上。
 * 所以打包时用本占位包顶替它：静态 import 能解析，Node 分支根本不会碰它。
 *
 * ## 如果哪天真的被调用
 *
 * 这里会**明确抛错**（而不是给个空对象让上层莫名其妙地崩在别处）。
 * 报错信息里带着撤销方式：删掉 `electron-builder.json` 里
 * `!node_modules/onnxruntime-web/**` 那条排除 + 本目录的 files 映射即可。
 */

function unavailable(what) {
  throw new Error(
    `onnxruntime-web 占位包被调用了（${what}）：桌面端不应使用 onnxruntime-web。` +
      '若确需使用，请删除 apps/windows/electron-builder.json 中 files 段对本包的排除与占位映射。',
  )
}

/** 只提供形状，不提供实现——被真正使用时会抛错 */
module.exports = {
  env: {
    wasm: {},
    versions: {},
    flags: {},
  },
  InferenceSession: {
    create: () => unavailable('InferenceSession.create'),
  },
  Tensor: class Tensor {
    constructor() {
      unavailable('new Tensor')
    }
  },
  default: undefined,
}
