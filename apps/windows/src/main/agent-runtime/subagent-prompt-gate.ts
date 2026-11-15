/**
 * 子 Agent 提示词分支的判定。
 *
 * 抽成纯函数是因为这条判据**会改变全部子 Agent 的输出**：放在 `createInstance` 里
 * 只能靠真机观察，抽出来才能钉住三条边界（非子实例、不在灰度名单、名单为空）。
 */
export function shouldUseSubAgentPrompt(opts: {
  /** 这次创建是不是某个父实例派生的 */
  readonly hasParent: boolean
  /** 子实例用的 Agent 定义 id */
  readonly definitionId: string
  /** 灰度名单；空/缺省 = 全部维持主 Agent 提示词 */
  readonly grayList: readonly string[] | undefined
}): boolean {
  if (!opts.hasParent) return false
  return (opts.grayList ?? []).includes(opts.definitionId)
}
