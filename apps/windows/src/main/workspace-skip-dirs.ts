/**
 * 遍历工作区时直接剪枝的目录名。
 *
 * 放在核心而不是 vcs 插件里：文件搜索（`system-service`）与 VCS 遍历用的是**同一份**
 * 名单，放在任一侧都会让另一侧反向 import（守卫 ⑪/⑫ 会红）。
 */
export const WORKSPACE_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.mtbot-vcs',
  'node_modules',
  '.cache',
  'tmp',
  'temp',
])
