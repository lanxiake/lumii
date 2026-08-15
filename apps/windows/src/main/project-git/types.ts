export interface ProjectGitStatusFile {
  /** 相对项目根的路径，POSIX 分隔符 */
  path: string
  /** 索引状态：' '|'M'|'A'|'D'|'R'|'C'|'U'|'?'|'!' */
  index: string
  /** 工作区状态，同上 */
  worktree: string
  /** 新增行数（从 git diff --numstat 获取） */
  insertions?: number
  /** 删除行数（从 git diff --numstat 获取） */
  deletions?: number
}

export interface ProjectGitStatus {
  /** 系统是否安装了 git */
  available: boolean
  /** realPath 下是否有 .git */
  isRepo: boolean
  branch?: string
  ahead?: number
  behind?: number
  remoteUrl?: string
  files: ProjectGitStatusFile[]
}
