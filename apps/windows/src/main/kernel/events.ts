/**
 * 主进程事件表。
 *
 * 只登记**已有真实发射点**的事件。没有发射方的事件不要写进来——
 * 那会让扩展订阅一个永远不响的频道，且编译器不会阻止。
 */
export interface MainEvents {
  /** 启动完成、窗口可交互 */
  'app:activated': { at: number }
  /** 进程开始退出（performCleanup 入口） */
  'app:shutdown': { reason: 'quit' | 'restart' }
}
