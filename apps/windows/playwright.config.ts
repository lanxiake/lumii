import { defineConfig } from '@playwright/test';
import path from 'path';

/**
 * Playwright E2E 测试配置
 * 
 * 用于 Windows 客户端记忆管理页面 E2E 测试
 */
export default defineConfig({
  testDir: './e2e',
  
  // 测试超时 600 秒（含 gateway build + 服务启动时间）
  timeout: 600 * 1000,
  
  // 单 worker（Electron 只能单实例）
  workers: 1,
  fullyParallel: false,
  
  // 不重试（避免重复生成数据）
  retries: 0,
  
  // 报告器
  reporter: [
    ['html', { outputFolder: 'playwright-report' }],
    ['line'],
  ],
  
  use: {
    // 截图：始终截图（方便排查每步状态）
    screenshot: 'on',
    
    // 视频录制：始终录制
    video: 'on',
    
    // 跟踪：始终记录
    trace: 'on',
  },
  
  projects: [
    {
      name: 'electron-windows',
      testMatch: /memory-management\.spec\.ts/,
    },
  ],
  
  // Electron 特定配置
  // @ts-expect-error - Playwright 类型定义可能不包含 electron 字段
  electron: {
    // 启动 Electron 的命令和参数
    launchOptions: {
      executablePath: path.join(__dirname, 'node_modules', '.bin', 'electron'),
      args: [
        path.join(__dirname, '.'),
        '--test-mode', // 测试模式：绕过单实例锁
      ],
    },
  },
});
