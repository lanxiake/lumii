/**
 * 遍历工作区时直接剪枝的目录名。
 *
 * 放在核心而不是 vcs 插件里：文件搜索（`system-service`）与 VCS 遍历用的是**同一份**
 * 名单，放在任一侧都会让另一侧反向 import（守卫 ⑪/⑫ 会红）。
 *
 * `.lumii/` 是应用自己的元数据（缩略图缓存、回收站），既不是用户产出也不该被搜索/
 * 版本管理；缓存上限 500MB、文件数可达数万，扫描进去会让每轮快照退化到伪哈希。
 */
export const WORKSPACE_SKIP_DIRS: ReadonlySet<string> = new Set([
  '.git',
  '.mtbot-vcs',
  '.lumii',
  'node_modules',
  '.cache',
  'tmp',
  'temp',
])
