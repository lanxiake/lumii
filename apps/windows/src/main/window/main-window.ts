import { BrowserWindow, Menu, screen, shell } from 'electron'
import { join } from 'path'
import { getAppIconPath } from '../asset-paths'
import { setIpcMainWindow } from '../agent-runtime'
import type { ScreenRecordService } from '../screen-record'

export interface MainWindowLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface MainWindowOptions {
  logger: MainWindowLogger
  setMainWindow: (window: BrowserWindow) => void
  isQuitting: () => boolean
  getScreenRecordService: () => ScreenRecordService | null
}

/**
 * 根据屏幕分辨率动态计算窗口大小
 * 
 * 规则：
 * - 窗口宽度 = 屏幕宽度的 70%（最小 800，最大 1400）
 * - 窗口高度 = 屏幕高度的 80%（最小 600，最大 900）
 * - 使用主显示器的工作区域大小（排除任务栏）
 * 
 * @returns 计算后的窗口宽度和高度
 */
function calculateWindowSize(logger: MainWindowLogger): { width: number; height: number } {
  try {
    const primaryDisplay = screen.getPrimaryDisplay()
    const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize
    
    // 计算窗口宽度：屏幕宽度的 70%，限制在 800-1400 之间
    const calculatedWidth = Math.floor(screenWidth * 0.7)
    const width = Math.min(Math.max(calculatedWidth, 800), 1400)
    
    // 计算窗口高度：屏幕高度的 80%，限制在 600-900 之间
    const calculatedHeight = Math.floor(screenHeight * 0.8)
    const height = Math.min(Math.max(calculatedHeight, 600), 900)
    
    logger.info(`屏幕分辨率: ${screenWidth}x${screenHeight}, 计算窗口大小: ${width}x${height}`)
    
    return { width, height }
  } catch (error) {
    // 如果获取屏幕信息失败，使用默认值
    logger.warn('获取屏幕信息失败，使用默认窗口大小', error)
    return { width: 800, height: 700 }
  }
}

/**
 * 创建主窗口
 */
/**
 * 配置 Content Security Policy
 * 允许连接到配置的 Gateway 地址和 API Server 地址
 */
async function setupContentSecurityPolicy(window: BrowserWindow): Promise<void> {
  // 完全禁用 CSP 检查（用于消除 YouTube、gsap 等外部资源的限制）
  // Electron 应用运行在受信任的环境中，无需 CSP 限制
  window.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const responseHeaders = details.responseHeaders || {}

    // 移除所有 CSP 相关头部
    delete responseHeaders['Content-Security-Policy']
    delete responseHeaders['content-security-policy']
    delete responseHeaders['Content-Security-Policy-Report-Only']
    delete responseHeaders['content-security-policy-report-only']

    callback({ responseHeaders })
  })
}

export function createMainWindow(
  options: MainWindowOptions,
  isTestMode: boolean = false,
  startHidden: boolean = false,
): Promise<void> {
  const { logger, setMainWindow, isQuitting, getScreenRecordService } = options
  logger.info('创建主窗口', { isTestMode, startHidden })

  // 动态计算窗口大小
  const { width, height } = calculateWindowSize(logger)

  const extraArgs = [
    ...(isTestMode ? ['--test-mode'] : []),
    // 托盘静默启动时跳过主窗口内开机画面
    ...(startHidden ? ['--skip-splash'] : []),
  ]

  const window = new BrowserWindow({
    width,
    height,
    minWidth: 700,
    minHeight: 600,
    frame: false, // 无边框窗口
    transparent: false,
    resizable: true,
    show: false, // 初始不显示，等待 ready-to-show（此时 early-splash 已在绘海报/视频）
    backgroundColor: '#e8f2fa', // 与开机画面柔和冰蓝白底色一致，避免出窗瞬间闪深色
    icon: getAppIconPath(), // 窗口 / 任务栏圆形图标（与产品 Logo 一致）
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: false, // 需要关闭 sandbox 以支持 node 模块
      webviewTag: true, // 允许 <webview> 用于 HTML 文件沙箱预览
      // 录屏合成依赖定时器持续绘帧，窗口最小化时不能被节流
      backgroundThrottling: false,
      // 开机动画带声自动播放
      autoplayPolicy: 'no-user-gesture-required',
      additionalArguments: extraArgs,
    },
  })
  setMainWindow(window)

  const readyToShow = new Promise<void>((resolve) => {
    window!.once('ready-to-show', () => {
      logger.info('主窗口 ready-to-show')
      resolve()
    })
  })

  // 窗口显示时确保 webContents 获得焦点（修复无边框窗口输入问题）
  window.on('show', () => {
    setTimeout(() => {
      if (window && !window.isDestroyed()) {
        window.focus()
        window.webContents.focus()
      }
    }, 100)
  })

  // 关闭窗口时隐藏而不是退出
  window.on('close', (event) => {
    if (!isQuitting()) {
      event.preventDefault()
      window?.hide()
      logger.info('窗口已隐藏到托盘')
    }
  })
  window.on('closed', () => {
    setIpcMainWindow(null)
  })

  // 配置 Content Security Policy，允许连接到 Gateway
  setupContentSecurityPolicy(window)
  // 将主窗口引用注入 ACP 事件推送层
  setIpcMainWindow(window)

  /**
   * 拦截 target=_blank / window.open：外链一律用系统浏览器打开，
   * 避免弹出无标题栏、无法关闭的内嵌窗口（如 Markdown 预览里点资讯原文链接）。
   */
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) {
      void shell.openExternal(url)
    }
    return { action: 'deny' }
  })

  /**
   * 兜底：渲染进程内未拦截的 <a href> 整页导航也改走系统浏览器，防止主窗口被外链替换。
   */
  window.webContents.on('will-navigate', (event, targetUrl) => {
    if (!/^https?:\/\//i.test(targetUrl)) return
    const devOrigin = process.env.ELECTRON_RENDERER_URL
    if (devOrigin && targetUrl.startsWith(devOrigin)) return
    event.preventDefault()
    void shell.openExternal(targetUrl)
  })

  // 渲染进程诊断：把渲染层 console / 崩溃 / 加载失败转写到文件日志。
  // 生产环境默认无 DevTools，渲染层报错原本不可见（表现为黑屏），此处使其可追踪。
  window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
    const tag = `[Renderer:console] ${message}`
    if (level >= 3) logger.error(tag, `(${sourceId}:${line})`)
    else if (level === 2) logger.warn(tag)
    else logger.info(tag)
  })
  window.webContents.on('render-process-gone', (_event, details) => {
    logger.error(`[Renderer] 渲染进程崩溃 reason=${details.reason} exitCode=${details.exitCode}`)
    void getScreenRecordService()?.handleRendererGone()
  })
  window.webContents.on('destroyed', () => {
    void getScreenRecordService()?.handleRendererGone()
  })
  window.webContents.on('preload-error', (_event, preloadPath, error) => {
    logger.error(`[Renderer] preload 脚本错误 path=${preloadPath} error=${error?.message}`)
  })
  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    logger.error(`[Renderer] 页面加载失败 code=${errorCode} desc=${errorDescription} url=${validatedURL}`)
  })

  /**
   * 原生右键菜单：对选中文本提供"复制"，输入框内额外提供剪切/粘贴/全选。
   * 覆盖文件预览、聊天记录、输入框等所有可选文本区域，复制走系统级最可靠。
   */
  window.webContents.on('context-menu', (_event, params) => {
    const hasSelection = params.selectionText.trim().length > 0
    const isEditable = params.isEditable
    if (!hasSelection && !isEditable) return

    const template: Electron.MenuItemConstructorOptions[] = []
    if (isEditable && params.editFlags.canCut) {
      template.push({ label: '剪切', role: 'cut' })
    }
    if (hasSelection && params.editFlags.canCopy) {
      template.push({ label: '复制', role: 'copy' })
    }
    if (isEditable && params.editFlags.canPaste) {
      template.push({ label: '粘贴', role: 'paste' })
    }
    if (isEditable && params.editFlags.canSelectAll) {
      if (template.length > 0) template.push({ type: 'separator' })
      template.push({ label: '全选', role: 'selectAll' })
    }
    if (template.length === 0) return
    Menu.buildFromTemplate(template).popup({ window: window! })
  })

  // 加载渲染进程页面（与开机画面并行）
  if (process.env.ELECTRON_RENDERER_URL) {
    const rendererUrl = process.env.ELECTRON_RENDERER_URL

    // dev 模式：renderer dev server 可能还没完全 ready，加载失败时自动重试
    let retryCount = 0
    const maxRetries = 10
    window.webContents.on('did-fail-load', (_event, errorCode, _errorDesc) => {
      if (retryCount < maxRetries && errorCode === -102) { // ERR_CONNECTION_REFUSED
        retryCount++
        logger.info(`等待 renderer dev server 就绪... (${retryCount}/${maxRetries})`)
        setTimeout(() => {
          window?.loadURL(rendererUrl)
        }, 1000)
      }
    })
    window.loadURL(rendererUrl)
    window.webContents.openDevTools({ mode: 'detach' })
  } else {
    if (isTestMode) {
      // 测试模式：添加查询参数到URL
      const htmlPath = join(__dirname, '../renderer/index.html')
      window.loadURL(`file://${htmlPath}?test-mode=true`)
    } else {
      window.loadFile(join(__dirname, '../renderer/index.html'))
    }
  }

  return (async () => {
    if (startHidden) {
      await readyToShow
      logger.info('开机启动模式：窗口已就绪，隐藏到托盘（不显示）')
      return
    }

    await readyToShow
    logger.info('窗口准备就绪，显示并聚焦（开机画面在主窗口内全屏播放）')
    if (window && !window.isDestroyed()) {
      window.show()
      window.focus()
    }
  })()
}
