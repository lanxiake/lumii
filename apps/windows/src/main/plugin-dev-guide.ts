import path from 'node:path'

import { resolveClientPluginsDir } from './client-plugin-protocol'
import { resolveExtensionsDir } from './extension-loader'
import { resolveClientStateDir } from './paths'
import { KNOWN_SLOTS } from './plugin-dev-check'

/**
 * `plugin_dev guide` 的返回体：Agent 自举开发时需要的**全部可执行事实**。
 *
 * 这里刻意不复制人看的规范全文（`docs/standards/plugin-development-standards.md`），
 * 只放「写成什么、放哪里、怎么验证」——文档里的踩坑解释由人去读。
 */

export interface PluginDevRoots {
  /** 渲染层客户端插件根目录 */
  client: string
  /** 主进程外部扩展根目录 */
  main: string
  /** 插件持久化数据约定目录（主进程扩展用；客户端插件用 api.storage） */
  data: string
}

export function resolvePluginDevRoots(): PluginDevRoots {
  return {
    client: resolveClientPluginsDir(),
    main: resolveExtensionsDir(),
    data: path.join(resolveClientStateDir(), 'plugin-data'),
  }
}

const CLIENT_EXAMPLE = `// ~/.lumii/plugins/my-plugin/client.js
// 一个文件、一次注册。保存后约 0.3 秒生效，没有构建步骤。
__LUMII_REGISTER_PLUGIN__('my-plugin', (api) => {
  const h = api.React.createElement

  // 整页：app.view 的条目 id 就是导航目标 plugin:<条目 id>
  api.registerSlot('app.view', {
    id: 'my-plugin.page',
    component: ({ onViewChange }) =>
      h(
        api.Page,
        { title: '我的插件', subtitle: '一个可直接运行的例子' },
        h('p', null, '文件大小示例：' + api.format.bytes(1536)),
        h('button', { onClick: () => onViewChange('dashboard') }, '回概览'),
      ),
  })

  // 侧栏入口：classNames 由宿主给，跟着内置导航走
  api.registerSlot('app.nav', {
    id: 'my-plugin.nav',
    component: ({ activeView, onViewChange, collapsed, classNames }) => {
      const active = activeView === 'plugin:my-plugin.page'
      return h(
        'button',
        {
          className: [classNames.item, active ? classNames.active : ''].join(' '),
          onClick: () => onViewChange('plugin:my-plugin.page'),
        },
        h('span', { className: classNames.icon }, '🧩'),
        !collapsed && h('span', { className: classNames.label }, '我的插件'),
      )
    },
  })

  // 持久化：按插件 id 命名空间隔离，不会和别的插件串 key
  api.storage.set('lastOpenedAt', Date.now())

  return () => {} // 可选：卸载时清理（定时器/订阅请在 effect 清理里）
})
`

const MAIN_EXAMPLE = `// ~/.lumii/extensions/my-extension/main.js（ESM，保存后 ≤1 秒热重载）
export default {
  manifest: {
    id: 'my-extension',
    name: '我的扩展',
    version: '0.1.0',
    engines: { lumii: '>=0.1.0' },
    kind: 'code',
    main: './main.js',
  },
  definition: {
    id: 'my-extension',
    apply(ctx) {
      const runtime = ctx.get('agentRuntime') // LateRef：每次现取，.get() 才拿实例
      ctx.effect(() => {
        // 注册的副作用写这里；卸载时按逆序执行
      })
      void runtime
    },
  },
}
`

export function buildPluginDevGuide(): Record<string, unknown> {
  const roots = resolvePluginDevRoots()

  return {
    roots: {
      client: roots.client,
      main: roots.main,
      data: roots.data,
      note: '`~/.lumii` 已在文件工具的写入白名单内：用 file_write / file_edit 写绝对路径即可；不需要 plugin_dev 代写。',
    },

    reload: {
      client: '保存 client.js 后约 0.3 秒生效；语法错误时旧版本继续服务',
      main: '保存 main.js 后 ≤1 秒热重载；激活失败会回滚到上一版',
      no_build: '没有打包步骤。两类插件都是单个 JS 文件，直接写盘就是部署。',
    },

    workflow: [
      '1. 用 file_write 写 <client>/<id>/client.js（以及可选的 plugin.json）',
      '2. 调 plugin_dev check（kind=client, id=<id>）做静态体检',
      '3. 调 plugin_dev status 看渲染层是否加载成功、错误是什么',
      '4. 改文件保存即可，不需要重启；只有主进程扩展开关的启用/禁用才需要重启',
      '5. 交给用户的成品是 ~/.lumii 下的文件，重启客户端后仍然存在',
    ],

    client: {
      files: {
        'client.js': '必需。经典脚本（<script> 注入），不能用 import/require。',
        'plugin.json': '可选。{ id, name, version }；缺省 id = 目录名。id 必须全局唯一。',
      },
      contract: '一个插件 = 一个 id = 一次 __LUMII_REGISTER_PLUGIN__(id, (api) => void | cleanup)。',
      example: CLIENT_EXAMPLE,
      api: {
        React: '宿主那份 React（不要自带第二份，两份会让 hooks 抛错）',
        ReactDOM: '宿主那份 react-dom',
        jsx: 'react/jsx-runtime',
        registerSlot: '(slot, entry) => dispose；entry = { id, component, order? }',
        registerCard: '(type, renderer) => dispose；新增 A2UI 卡片类型',
        Page: '整页外壳：{ title?, subtitle?, actions?, children }；与内置页同口径（令牌 + 主内容区 20px 内边距，不要自己再加 padding）',
        format: 'format.number / percent / currency / bytes / date / dateTime / relative',
        storage: 'storage.get/set/remove/keys/clear；按插件 id 命名空间隔离的 localStorage',
      },
      slots: KNOWN_SLOTS,
      rules: [
        '同一槽位里条目 id 唯一；建议以 `<插件 id>.` 开头',
        'app.view 的条目 id 必须与导航里的 plugin:<条目 id> 一致',
        '定时器 / 订阅 / requestAnimationFrame 放在 effect 清理或返回的 cleanup 里，否则禁用插件后仍在跑',
        '数据用 window.electronAPI.*（与页面同一 JS 上下文，不做沙箱）',
        '样式只用设计令牌：var(--color-*) / var(--spacing-*) / var(--radius-*)，不要写十六进制颜色',
      ],
      data_channel: {
        usage: 'window.electronAPI.usage.query({ from, to, groupBy })',
        extensions: 'window.electronAPI.extensions.list()',
        note: 'preload 暴露的所有 API 都可直接用；没有额外宿主包装。',
      },
    },

    main: {
      files: { 'main.js': '必需。ESM：export default { manifest, definition }，两个 id 必须一致。' },
      contract: 'definition.apply(ctx) 里用 ctx.get(key) 取服务；ctx.effect(fn) 注册可逆副作用。',
      example: MAIN_EXAMPLE,
      services: [
        "agentRuntime → LateRef<AgentRuntimeBridge>（.get()）",
        'perf / cloudSync / mainWindow / tray / mcp 等，见 kernel/services.ts',
        '注意：provide(key, () => x) 会缓存工厂结果；用 LateRef 取每次现取',
      ],
      persistence: `写 ${path.join(roots.data, '<插件 id>')}/ 下的文件（~/.lumii 已在可写白名单内）。`,
    },

    verify: {
      static: 'plugin_dev check 覆盖：文件形状、client.js 语法、注册次数/id、槽位名、明显违规写法',
      runtime: 'plugin_dev status 返回主进程扩展的 state/error 与渲染层上报的客户端插件 state/error',
      limit: 'main.js 是 ESM，无法在静态检查里编译；它的语法错误由加载器在 ≤1 秒内作为运行时错误返回。',
    },
  }
}
