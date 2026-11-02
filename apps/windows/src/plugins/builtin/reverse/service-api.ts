/**
 * `com.lumii.reverse` 对核心暴露的服务。
 *
 * 插件停用后 `S.reverse` 从容器里消失——技能与 UI 据此走降级路径，而不是
 * 「工具还在、只是跑不动」。
 */
export interface ReverseService {
  /**
   * 当前可用的探针后端。`null` = 本机没装对应工具链。
   *
   * 判据是**文件存在**，不是「上次跑成功过」：Ghidra 目录被人挪走时要立刻反映出来，
   * 否则工具会列出来、一调就崩。
   */
  backends(): ReverseBackendStatus[]
  /** 探针脚本所在目录（插件资产，不与技能目录混放） */
  scriptsDir(): string
}

export interface ReverseBackendStatus {
  /** `ghidra` | `jadx`（后续） */
  id: string
  /** 人话名，直接进工具描述 */
  label: string
  /** 找到的安装路径；没找到就是 null */
  path: string | null
  /** 支持的目标类型，明确到扩展/幻数层 */
  targets: readonly string[]
  /** 没找到时给用户看的下一步（不自动安装） */
  hint: string
}
