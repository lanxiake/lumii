import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'

/**
 * 三种来源合成一张表：内置 / 外部扩展走 IPC，客户端插件走渲染层快照。
 * 这里只验证「同一张表、同一套开关」——排布细节留给真机。
 */
const mocks = vi.hoisted(() => ({
  clients: [] as Array<Record<string, unknown>>,
  list: vi.fn(),
  setEnabled: vi.fn(),
  setClientEnabled: vi.fn(),
  importZip: vi.fn(),
  importFolder: vi.fn(),
  closeHub: vi.fn(),
}))

vi.mock('../../plugins/client-plugin-host', () => ({
  subscribeClientPlugins: () => () => {},
  getClientPluginStates: () => mocks.clients,
}))

vi.mock('../SettingsHub/SettingsHubContext', () => ({
  useSettingsHub: () => ({ closeHub: mocks.closeHub, setTab: vi.fn() }),
}))

vi.mock('../../contexts/PluginsContext/PluginsContext', () => ({
  usePluginsContext: () => ({
    statuses: {},
    install: vi.fn(async () => {}),
    uninstall: vi.fn(async () => {}),
    cancel: vi.fn(),
    refreshAll: vi.fn(async () => {}),
  }),
}))

import { ExtensionsPanel } from './ExtensionsPanel'

beforeEach(() => {
  mocks.clients.length = 0
  mocks.clients.push({
    id: 'client-plug',
    name: 'Client Plug',
    version: '0.2.0',
    dir: 'C:/fake/plugins/client-plug',
    enabled: true,
    origin: 'user',
    state: 'loaded',
  })
  mocks.list.mockReset()
  mocks.list.mockResolvedValue([
    {
      id: 'com.test.builtin',
      name: 'Alpha',
      version: '1.0.0',
      kind: 'builtin',
      origin: 'builtin',
      enabled: true,
      state: 'active',
      pendingRestart: false,
    },
    {
      id: 'com.test.ext',
      name: 'Ext',
      version: '0.1.0',
      kind: 'external',
      origin: 'official',
      dir: 'C:/fake/ext',
      enabled: true,
      state: 'active',
      pendingRestart: false,
    },
  ])
  mocks.setEnabled.mockReset()
  mocks.setEnabled.mockResolvedValue({ ok: true, restartRequired: false })
  mocks.setClientEnabled.mockReset()
  mocks.setClientEnabled.mockResolvedValue({ ok: true })

  ;(window as unknown as { electronAPI: unknown }).electronAPI = {
    extensions: {
      list: mocks.list,
      setEnabled: mocks.setEnabled,
      setClientEnabled: mocks.setClientEnabled,
      openDir: vi.fn(async () => ({ ok: true })),
      remove: vi.fn(async () => ({ ok: true, dir: 'C:/fake' })),
      createSample: vi.fn(async () => ({ ok: true, dir: 'C:/fake/new' })),
      importZip: mocks.importZip,
      importFolder: mocks.importFolder,
      restart: vi.fn(async () => ({ ok: true })),
    },
    plugins: { list: vi.fn(async () => ({})) },
  }
})

describe('ExtensionsPanel — 分组列表', () => {
  it('外部插件在上、内置插件在下；独立运行时组件归入外部组', async () => {
    render(<ExtensionsPanel />)

    expect(await screen.findByText('Alpha')).toBeTruthy()
    expect(screen.getByText('Ext')).toBeTruthy()
    expect(screen.getByText('Client Plug')).toBeTruthy()
    // 独立组件（反检测浏览器）按外部插件展示；
    // 「微信本机助手」是 MCP，不归插件中心管（2026-10-25 MCP 与插件解耦），插件页不该出现它
    expect(screen.getByText('反检测浏览器')).toBeTruthy()
    expect(screen.queryByText('微信本机助手')).toBeNull()

    // 两组标题与计数：外部 = Ext + Client + 1 个组件；内置 = Alpha
    expect(screen.getByText('外部插件')).toBeTruthy()
    expect(screen.getByText('内置插件')).toBeTruthy()
    expect(screen.getByText('3/3')).toBeTruthy()
    expect(screen.getByText('1/1')).toBeTruthy()

    const externalSection = screen.getByText('外部插件').closest('section')!
    const builtinSection = screen.getByText('内置插件').closest('section')!
    expect(within(externalSection).getByText('Client Plug')).toBeTruthy()
    expect(within(builtinSection).getByText('Alpha')).toBeTruthy()
    expect(within(builtinSection).queryByText('Client Plug')).toBeNull()
  })

  it('「新建插件」在主工具栏，不占页脚', async () => {
    render(<ExtensionsPanel />)
    await screen.findByText('Alpha')

    const create = screen.getByRole('button', { name: '新建插件' })
    expect(create).toBeTruthy()
    // 与搜索框同属工具栏（第一个 .toolbar 容器）
    const toolbar = create.closest('div')!
    expect(within(toolbar).getByLabelText('搜索插件')).toBeTruthy()
    expect(within(toolbar).getByRole('button', { name: '导入插件' })).toBeTruthy()
  })

  it('新建插件弹窗：AI 创建会开新会话并带上插件开发技能', async () => {
    const drafts: Array<Record<string, unknown>> = []
    const onDraft = (e: Event) => drafts.push((e as CustomEvent).detail)
    window.addEventListener('mtbot:chat-draft-request', onDraft)
    const onViewChange = vi.fn()
    render(<ExtensionsPanel onViewChange={onViewChange} />)
    await screen.findByText('Alpha')

    fireEvent.click(screen.getByRole('button', { name: '新建插件' }))
    expect(await screen.findByRole('button', { name: '生成示例插件' })).toBeTruthy()
    const textarea = screen.getByLabelText('这个插件要做什么？')
    fireEvent.change(textarea, { target: { value: '在概览加一张喝水卡片' } })
    fireEvent.click(screen.getByRole('button', { name: '让 AI 创建' }))

    expect(drafts).toHaveLength(1)
    expect(drafts[0]!.newSession).toBe(true)
    expect(String(drafts[0]!.text)).toContain('plugin-development')
    expect(String(drafts[0]!.text)).toContain('在概览加一张喝水卡片')
    expect(mocks.closeHub).toHaveBeenCalled()
    expect(onViewChange).toHaveBeenCalledWith('chat')
    window.removeEventListener('mtbot:chat-draft-request', onDraft)
  })

  it('导入插件弹窗：压缩包与文件夹两个入口', async () => {
    mocks.importZip.mockResolvedValue({ ok: true, id: 'demo', dir: 'C:/fake/demo', kind: 'client' })
    render(<ExtensionsPanel />)
    await screen.findByText('Alpha')

    fireEvent.click(screen.getByRole('button', { name: '导入插件' }))
    expect(await screen.findByRole('button', { name: '选择文件夹' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '选择压缩包 (.zip)' }))
    await waitFor(() => expect(mocks.importZip).toHaveBeenCalledTimes(1))
  })

  it('客户端插件行走 setClientEnabled，主进程行走 setEnabled', async () => {
    render(<ExtensionsPanel />)
    await screen.findByText('Client Plug')

    const clientCard = screen.getByText('Client Plug').closest('article')!
    fireEvent.click(within(clientCard).getByRole('button', { name: '禁用' }))
    await waitFor(() => expect(mocks.setClientEnabled).toHaveBeenCalledWith('client-plug', false))
    expect(mocks.setEnabled).not.toHaveBeenCalled()

    const extCard = screen.getByText('Ext').closest('article')!
    fireEvent.click(within(extCard).getByRole('button', { name: '禁用' }))
    await waitFor(() => expect(mocks.setEnabled).toHaveBeenCalledWith('com.test.ext', false))
  })

  it('客户端插件行也有打开目录 / 删除', async () => {
    render(<ExtensionsPanel />)
    await screen.findByText('Client Plug')

    const clientCard = screen.getByText('Client Plug').closest('article')!
    expect(within(clientCard).getByRole('button', { name: '打开目录' })).toBeTruthy()
    expect(within(clientCard).getByRole('button', { name: '删除' })).toBeTruthy()
  })
})
