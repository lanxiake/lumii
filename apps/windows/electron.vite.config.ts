import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import { readFile } from 'fs'
import { resolve, join, normalize, extname } from 'path'
import type { Plugin } from 'vite'

// monorepo 根目录
const ROOT = resolve(__dirname, '../..')

/**
 * Vite/Rollup 插件：修补 Electron 打包产物中的 Node 兼容性问题
 *
 * 1. node:sqlite — undici 的 SqliteCacheStore 会 require('node:sqlite')，
 *    Rollup 将其提升为 chunk 顶层静态 require，Electron asar 加载器无法解析。
 *    → renderChunk 阶段仅替换 undici 打包产物中的 require("node:sqlite") 为 stub IIFE。
 *    → 其他模块（如 local-database.ts）对 node:sqlite 的动态 import 保持 external，
 *      运行时由 Electron 36（Node.js 22.19）内置的 node:sqlite 提供。
 *
 * 2. globalThis.File — undici 的 webidl 模块依赖全局 File 对象，
 *    Electron 主进程环境中 File 未暴露在全局作用域。
 *    → 通过 Rollup banner 在每个 chunk 开头注入 polyfill（仅在 File 未定义时生效）。
 */
function electronCompatPlugin(): Plugin {
  // 仅用于替换 undici 打包产物中的顶层 require("node:sqlite")
  // 不影响 local-database.ts 的动态 import("node:sqlite")（运行时由 Electron 内置提供）
  const SQLITE_STUB = [
    '(() => {',
    '  const _e = () => { throw new Error("node:sqlite is not available in Electron bundled context"); };',
    '  return {',
    '    DatabaseSync: class { constructor() { _e(); } },',
    '    StatementSync: class { constructor() { _e(); } },',
    '    constants: {},',
    '    backup: _e,',
    '  };',
    '})()',
  ].join(' ')

  return {
    name: 'electron-compat',
    enforce: 'pre',
    // CJS require("node:sqlite") 替换（仅针对 undici 打包产物中的顶层静态 require）
    // 不拦截 ESM import，让 node:sqlite 保持 external 由 Electron 运行时提供
    renderChunk(code, chunk) {
      if (!code.includes('node:sqlite')) return null
      // 只替换 undici 相关 chunk 中的 require("node:sqlite")
      // 其他 chunk（如包含 local-database 的）保持不变，运行时使用 Electron 内置 node:sqlite
      const isUndiciChunk = chunk.moduleIds?.some((id: string) => id.includes('undici'))
      if (!isUndiciChunk) return null
      return code.replace(
        /require\(\s*["']node:sqlite["']\s*\)/g,
        SQLITE_STUB,
      )
    },
  }
}

// File polyfill — 注入到每个 main chunk 开头
// Electron 主进程（即使 Node 22）没有 globalThis.File，undici 需要它
const FILE_POLYFILL_BANNER = `\
if(typeof globalThis.File==="undefined"){globalThis.File=class File extends Blob{constructor(b,n,o){super(b,o);this.name=n;this.lastModified=(o&&o.lastModified)||Date.now()}}}`

/**
 * dev 模式静态资源中间件：把 /live2d 和 /pet-models 请求映射到 apps/windows/resources。
 * 宠物窗口在 dev 下从 http://127.0.0.1:5174 加载，需要这两个目录可访问。
 * 打包模式由 electron-builder extraResources + file:// 直接加载，不经此中间件。
 */
function petResourcesDevPlugin(): Plugin {
  const RESOURCES = resolve(__dirname, 'resources')
  return {
    name: 'pet-resources-dev',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = req.url ? decodeURIComponent(req.url.split('?')[0]) : ''
        if (!url.startsWith('/live2d/') && !url.startsWith('/pet-models/')) {
          return next()
        }
        // 阻断路径穿越
        const safeRel = normalize(url).replace(/^(\.\.[/\\])+/, '')
        const filePath = join(RESOURCES, safeRel)
        if (!filePath.startsWith(RESOURCES)) {
          res.statusCode = 403
          return res.end('Forbidden')
        }
        readFile(filePath, (err, data) => {
          if (err) {
            res.statusCode = 404
            return res.end('Not found')
          }
          const ext = extname(filePath).toLowerCase()
          const mime: Record<string, string> = {
            '.js': 'text/javascript',
            '.json': 'application/json',
            '.moc3': 'application/octet-stream',
            '.png': 'image/png',
            '.wasm': 'application/wasm',
          }
          res.setHeader('Content-Type', mime[ext] ?? 'application/octet-stream')
          res.end(data)
        })
      })
    },
  }
}

/**
 * 修补 pptx-preview：
 * 1) slideLayout / slideMaster 缺失时访问 .background 会抛
 * 2) 库用 `import { get, omit } from "lodash"`，CJS lodash 在 Vite 直链 ESM 下无具名导出
 * 库为压缩单行包，不适合用 pnpm patch，改在 Vite 转换阶段替换。
 */
function patchPptxPreviewPlugin(): Plugin {
  const OLD =
    'var n=t.background;if("none"===n.type&&(n=t.slideLayout.background),"none"===n.type&&(n=t.slideMaster.background)'
  const NEW =
    'var n=t.background||{type:"none"};if((!n||"none"===n.type)&&(n=(null==t.slideLayout?void 0:t.slideLayout.background)||{type:"none"}),"none"===n.type&&(n=(null==t.slideMaster?void 0:t.slideMaster.background)||{type:"none"})'
  // UMD 构建使用变量名 i
  const OLD_UMD =
    'var i=t.background;if("none"===i.type&&(i=t.slideLayout.background),"none"===i.type&&(i=t.slideMaster.background)'
  const NEW_UMD =
    'var i=t.background||{type:"none"};if((!i||"none"===i.type)&&(i=(null==t.slideLayout?void 0:t.slideLayout.background)||{type:"none"}),"none"===i.type&&(i=(null==t.slideMaster?void 0:t.slideMaster.background)||{type:"none"})'

  /** 将 lodash CJS 具名导入改为 lodash-es（真 ESM），避免 Vite /@fs 直链无 export */
  const LODASH_NAMED =
    /import\s*\{\s*get\s+as\s+(\w+)\s*,\s*omit\s+as\s+(\w+)\s*\}\s*from\s*["']lodash["']\s*;/
  const LODASH_NAMED_ALT =
    /import\s*\{\s*omit\s+as\s+(\w+)\s*,\s*get\s+as\s+(\w+)\s*\}\s*from\s*["']lodash["']\s*;/
  /** 兼容上一版误改成的 default import */
  const LODASH_DEFAULT =
    /import\s+lodash\s+from\s*["']lodash["']\s*;\s*var\s+(\w+)\s*=\s*lodash\.get\s*,\s*(\w+)\s*=\s*lodash\.omit\s*;/

  return {
    name: 'patch-pptx-preview-background',
    enforce: 'pre',
    transform(code, id) {
      const norm = id.replace(/\\/g, '/')
      if (!norm.includes('pptx-preview')) return null
      let next = code
      if (next.includes('slideLayout.background')) {
        if (next.includes(OLD)) next = next.replace(OLD, NEW)
        if (next.includes(OLD_UMD)) next = next.replace(OLD_UMD, NEW_UMD)
      }
      let patchedLodash = false
      const afterDefault = next.replace(
        LODASH_DEFAULT,
        'import{get as $1,omit as $2}from"lodash-es";',
      )
      if (afterDefault !== next) {
        next = afterDefault
        patchedLodash = true
      }
      if (!patchedLodash) {
        const afterNamed = next.replace(
          LODASH_NAMED,
          'import{get as $1,omit as $2}from"lodash-es";',
        )
        if (afterNamed !== next) {
          next = afterNamed
          patchedLodash = true
        }
      }
      if (!patchedLodash) {
        const afterAlt = next.replace(
          LODASH_NAMED_ALT,
          'import{get as $2,omit as $1}from"lodash-es";',
        )
        if (afterAlt !== next) next = afterAlt
      }
      if (next === code) return null
      return { code: next, map: null }
    },
  }
}

export default defineConfig({
  main: {
    plugins: [
      electronCompatPlugin(),
      externalizeDepsPlugin({
        // 只外部化 electron，其他依赖（electron-updater, ws）内联打包
        // 这样可以避免 pnpm 的传递依赖（如 fs-extra）无法被 electron-builder 正确打包的问题
        // bufferutil / utf-8-validate 是 ws 的可选原生模块，必须外部化（无法被 bundler 打包）
        // iconv-lite 用于 Windows 命令行输出编码转换，必须外部化
        // @mtbot/* workspace 包入口为 .ts 源码，若外部化进 node_modules，
        // Electron 运行时 Node 无法对 node_modules 内文件做 TS type stripping（ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING）
        // playwright-core 及其依赖（chromium-bidi）是 CommonJS 库，需要外部化避免警告
        // 不把 playwright-core / chromium-bidi 打进 bundle：Vite 会留下深层 require，
        // 运行时从 apps/windows/node_modules 解析（与 playwright 官方建议一致）。
        exclude: [
          'electron-updater', 'ws', 'bufferutil', 'utf-8-validate', 'iconv-lite',
          '@mtbot/agent-runtime', '@mtbot/browser-control', '@mtbot/protocol', '@mtbot/client-sdk',
          '@mariozechner/pi-agent-core', '@mariozechner/pi-ai',
          '@sinclair/typebox',
        ]
      }),
    ],
    build: {
      outDir: 'out/main',
      commonjsOptions: {
        // 忽略 CommonJS 警告（chromium-bidi 等库使用 CJS 格式）
        ignoreTryCatch: false,
      },
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/main/index.ts')
        },
        output: {
          banner: FILE_POLYFILL_BANNER,
        },
        // node:sqlite 保持 external，运行时由 Electron 36（Node.js 22.19）内置提供
        // better-sqlite3 保持 external 作为备选，但 Electron 环境优先使用 node:sqlite
        // pi-ai 顶层 re-export 了 anthropic / google / amazon-bedrock 等 provider，
        // 它们的 SDK（@anthropic-ai/sdk、@google/genai、@aws-sdk/*）未安装且在本客户端中永不调用
        // （只使用 openai-completions / openai-responses 走 OpenAI 兼容端点），因此标记为
        // external 让 Rollup 跳过解析，避免构建期 import 解析失败。
        external: [
          'bufferutil', 'utf-8-validate', 'iconv-lite', 'better-sqlite3', 'node:sqlite', 'isolated-vm',
          '@anthropic-ai/sdk',
          '@google/genai',
          '@aws-sdk/client-bedrock-runtime',
        ]
      }
    },
    // 排除 workspace 包，避免 Vite 预构建时无法解析
    optimizeDeps: {
      exclude: [
        '@mtbot/agent-runtime', '@mtbot/browser-control', '@mtbot/protocol', '@mtbot/client-sdk',
        '@mariozechner/pi-agent-core', '@mariozechner/pi-ai',
      ]
    },
    resolve: {
      alias: {
        '@main': resolve(__dirname, 'src/main'),
        '@shared': resolve(__dirname, 'src/shared'),
        // monorepo workspace 包 - 指向源码确保 Vite 能正确解析
        '@mtbot/agent-runtime/browser': resolve(ROOT, 'packages/agent-runtime/src/browser.ts'),
        '@mtbot/agent-runtime': resolve(ROOT, 'packages/agent-runtime/src/index.ts'),
        '@mtbot/browser-control': resolve(ROOT, 'packages/browser-control/src/index.ts'),
        '@mtbot/protocol': resolve(ROOT, 'packages/protocol/src/index.ts'),
        '@mtbot/client-sdk': resolve(ROOT, 'packages/client-sdk/src/index.ts'),
        // src/browser/ 依赖的网关内部模块 → Windows 客户端 stubs
        // 使用绝对路径 alias 确保 Vite 能正确解析跨包引用
        [resolve(ROOT, 'src/logging/subsystem.js')]: resolve(__dirname, 'src/main/stubs/logging-subsystem.ts'),
        [resolve(ROOT, 'src/infra/ports.js')]: resolve(__dirname, 'src/main/stubs/infra-ports.ts'),
        [resolve(ROOT, 'src/utils.js')]: resolve(__dirname, 'src/main/stubs/utils.ts'),
        [resolve(ROOT, 'src/process/exec.js')]: resolve(__dirname, 'src/main/stubs/process-exec.ts'),
      },
      // 确保能正确解析 pnpm workspace 中的 TypeScript 源码包
      conditions: ['module', 'jsnext:main', 'jsnext', 'main'],
      mainFields: ['module', 'jsnext:main', 'jsnext', 'main'],
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      outDir: 'out/preload',
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts')
        }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // Live2D 模型资产类型，确保 Vite 不当作未知文件报错
    assetsInclude: ['**/*.moc3', '**/*.model3.json', '**/*.motion3.json', '**/*.physics3.json', '**/*.cdi3.json', '**/*.exp3.json'],
    server: {
      port: 5174,
      host: '127.0.0.1', // 确保监听 IPv4，避免 Electron 在 Windows 上无法连接 IPv6-only 的 Vite
      fs: {
        // 允许从 apps/windows/assets 导入产品 logo 等静态资源
        allow: [resolve(__dirname)],
      },
    },
    build: {
      outDir: resolve(__dirname, 'out/renderer'),
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html')
        }
      }
    },
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src/renderer'),
        '@renderer': resolve(__dirname, 'src/renderer'),
        '@shared': resolve(__dirname, 'src/shared'),
        '@app-assets': resolve(__dirname, 'assets'),
        // Node built-in stub: renderer 无 nodeIntegration，object-inspect 等库顶层访问
        // util.inspect.custom 会导致模块初始化崩溃（白屏）。提供最小 stub 解决。
        'util': resolve(__dirname, 'src/renderer/stubs/util.ts'),
        // 仅允许 browser 子路径进入 renderer；主入口含 tools/sqlite 等 Node 代码
        '@mtbot/agent-runtime/browser': resolve(ROOT, 'packages/agent-runtime/src/browser.ts'),
      },
      // 明确指定模块查找路径
      mainFields: ['module', 'jsnext:main', 'jsnext', 'main']
    },
    plugins: [react(), petResourcesDevPlugin(), patchPptxPreviewPlugin()],
    // 解决 @uiw/react-md-editor 依赖解析失败
    // 将 renderer 依赖包含在预构建中，确保 Vite 能正确解析 pnpm 符号链接
    optimizeDeps: {
      // 必须走 transform 补丁，不能进 esbuild 预构建缓存
      exclude: ['pptx-preview'],
      include: [
        '@uiw/react-md-editor', 'react-markdown', 'remark-gfm', 'rehype-highlight',
        'remark-math', 'rehype-katex', 'katex',
        'pdfjs-dist',
        'pixi.js', 'pixi-live2d-display/cubism4',
        'lodash-es',
      ]
    }
  }
})
