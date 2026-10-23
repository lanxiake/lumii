#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import prompts from 'prompts'

interface ExtensionOptions {
  id: string
  name: string
  description: string
  author: string
  needsIpc: boolean
  needsEvents: boolean
  needsClient: boolean
}

async function main() {
  console.log('📦 Lumii 扩展脚手架\n')

  const response = await prompts([
    {
      type: 'text',
      name: 'id',
      message: '扩展 ID（格式：com.yourname.extension-name）',
      validate: (v: string) =>
        /^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$/.test(v) || '格式：com.yourname.extension-name',
    },
    {
      type: 'text',
      name: 'name',
      message: '显示名称',
      initial: (prev: string) => prev.split('.').pop()?.replace(/-/g, ' ') || '',
    },
    {
      type: 'text',
      name: 'description',
      message: '描述（一句话）',
    },
    {
      type: 'text',
      name: 'author',
      message: '作者',
      initial: 'Your Name',
    },
    {
      type: 'confirm',
      name: 'needsIpc',
      message: '需要注册 IPC 处理器？',
      initial: false,
    },
    {
      type: 'confirm',
      name: 'needsEvents',
      message: '需要订阅主进程事件？',
      initial: false,
    },
    {
      type: 'confirm',
      name: 'needsClient',
      message: '同时提供渲染层半边（client.js，可往设置页/页面里加 UI）？',
      initial: false,
    },
  ])

  if (!response.id) {
    console.log('取消')
    process.exit(0)
  }

  const opts: ExtensionOptions = response as ExtensionOptions
  const outDir = join(process.cwd(), opts.id.split('.').pop()!)

  await mkdir(outDir, { recursive: true })

  // manifest + definition + README + package.json + tsconfig.json
  await writeFile(join(outDir, 'main.ts'), generateMainTs(opts))
  if (opts.needsClient) await writeFile(join(outDir, 'client.ts'), generateClientTs(opts))
  await writeFile(join(outDir, 'package.json'), generatePackageJson(opts))
  await writeFile(join(outDir, 'tsconfig.json'), generateTsConfig())
  await writeFile(join(outDir, 'README.md'), generateReadme(opts))
  await writeFile(join(outDir, '.gitignore'), 'node_modules\ndist\n*.log\n')

  console.log(`\n✅ 扩展已创建：${outDir}`)
  console.log('\n下一步：')
  console.log(`  cd ${opts.id.split('.').pop()}`)
  console.log('  pnpm install')
  console.log('  pnpm build')
  console.log(`  cp -r . ~/.lumii/extensions/${opts.id}`)
  console.log('\n开发模式：改完代码后 pnpm build && cp main.js ~/.lumii/extensions/${opts.id}/')
  if (opts.needsClient) {
    console.log(`  cp client.js ~/.lumii/extensions/${opts.id}/   # 渲染层半边`)
  }
  console.log('Lumii 会在 1 秒内自动重载扩展。\n')
}

/**
 * 渲染层半边模板。
 *
 * 宿主会注入 React 与注册 API（内置插件直接 import，外部插件靠注入），
 * 契约与内置插件的 `RendererPlugin` 同一形状：`setup(api)` 返回清理函数。
 */
function generateClientTs(opts: ExtensionOptions): string {
  return `/**
 * ${opts.name} 的渲染层半边。
 *
 * 宿主注入并调用的形状（与内置插件的 RendererPlugin 同一契约）：
 *   { id, setup(api) → 清理函数 }
 * api 提供：registerSlot / registerCard / React / ReactDOM / Page / format / storage
 *
 * 能做的事：注册槽位（app.view 整页 / dashboard.* 卡片 / settings.section 设置分区）。
 * 要调主进程：通道由 main.ts 的 ctx.registerIpc 提供，这里用 window.electronAPI 访问。
 */
export default {
  id: '${opts.id}',
  setup(api) {
    // 例：往设置页「扩展」分区下半加一块
    // return api.registerSlot('settings.section', { id: '${opts.id}.about', component: About })

    // 没有 UI 时也必须返回清理函数（可为空）
    return () => {}
  },
}
`
}

function generateMainTs(opts: ExtensionOptions): string {
  const ipcExample = opts.needsIpc
    ? `
  // 注册 IPC 处理器（通道名约定：ext:<id>:* 避免冲突）
  ctx.registerIpc?.('ext:${opts.id}:hello', async (event, name: string) => {
    ctx.log.info(\`收到来自渲染层的问候：\${name}\`)
    return { message: \`Hello, \${name}!\` }
  })
`
    : ''

  const clientField = opts.needsClient ? `    client: { entry: './client.js' },\n` : ''
  const eventsExample = opts.needsEvents
    ? `
  // 订阅主进程事件
  ctx.on('app:window-ready', ({ at }) => {
    ctx.log.info(\`窗口已就绪（\${at}）\`)
  })
`
    : ''

  return `import { definePlugin } from '@mtbot/plugin-core'
import type { MainEvents } from '@lumii/main-events'

export default {
  manifest: {
    id: '${opts.id}',
    name: '${opts.name}',
    version: '0.1.0',
    description: '${opts.description}',
    engines: { lumii: '>=0.1.0' },
    kind: 'code' as const,
    origin: 'user' as const,
    main: './main.js',
${clientField}  },
  definition: definePlugin<MainEvents>({
    id: '${opts.id}',
    provides: [],
    apply(ctx) {
      ctx.log.info('${opts.name} 已激活')
${ipcExample}${eventsExample}
      // 清理：卸载时自动执行
      ctx.effect(() => {
        ctx.log.info('${opts.name} 已卸载')
      })
    },
  }),
}
`
}

function generatePackageJson(opts: ExtensionOptions): string {
  return JSON.stringify(
    {
      name: opts.id,
      version: '0.1.0',
      description: opts.description,
      author: opts.author,
      type: 'module',
      main: './main.js',
      scripts: {
        build: 'tsc',
        dev: 'tsc --watch',
      },
      dependencies: {
        '@mtbot/plugin-core': 'workspace:*',
      },
      devDependencies: {
        typescript: '^5.3.3',
      },
    },
    null,
    2,
  )
}

function generateTsConfig(): string {
  return JSON.stringify(
    {
      compilerOptions: {
        target: 'ES2022',
        module: 'Node16',
        moduleResolution: 'Node16',
        outDir: '.',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        forceConsistentCasingInFileNames: true,
      },
      include: ['*.ts'],
    },
    null,
    2,
  )
}

function generateReadme(opts: ExtensionOptions): string {
  return `# ${opts.name}

${opts.description}

## 开发

\`\`\`bash
pnpm install
pnpm build
\`\`\`

## 部署

\`\`\`bash
cp -r . ~/.lumii/extensions/${opts.id}/
\`\`\`

Lumii 启动时会自动加载，改代码后 1 秒内热重载。

## 日志

扩展日志在 Lumii 主进程日志中，前缀 \`[ext:${opts.id}]\`：

- 开发模式：\`~/.lumii-dev.log\`
- 生产模式：\`~/.lumii/logs/app/mtbot-*.log\`
`
}

main().catch((err) => {
  console.error('失败：', err)
  process.exit(1)
})
