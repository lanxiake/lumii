/**
 * 主进程事件表。
 *
 * 只登记**已有真实发射点**的事件。没有发射方的事件不要写进来——
 * 那会让扩展订阅一个永远不响的频道，且编译器不会阻止。
 */
export interface MainEvents {
  /**
   * 主窗口已创建（`createWindow` 返回后立刻发）。
   *
   * 需要窗口引用的扩展（录屏、桌宠）靠它决定「什么时候真正开始干活」，
   * 而不是让宿主把激活点推迟——那样所有扩展都被拖慢。
   */
  'app:window-ready': { at: number }
  /** 启动完成、窗口可交互 */
  'app:activated': { at: number }
  /** 进程开始退出（performCleanup 入口） */
  'app:shutdown': { reason: 'quit' | 'restart' }
}
