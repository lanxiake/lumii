/** 版本号比较（`x.y.z` / `x.y.z-tag`），主进程与渲染层共用一份。 */

/** 返回值 >0 表示 a 更新 */
export function compareVersions(a: string, b: string): number {
  const core = (v: string) => v.split(/[-+]/, 1)[0]!.split('.').map((n) => Number(n) || 0)
  const [aCore, bCore] = [core(a), core(b)]
  for (let i = 0; i < 3; i++) {
    const diff = (aCore[i] ?? 0) - (bCore[i] ?? 0)
    if (diff !== 0) return diff
  }
  // 正式版 > 预发布版；同为预发布时按字符串比较（够用且稳定）
  const aPre = /[-+]/.test(a)
  const bPre = /[-+]/.test(b)
  if (aPre !== bPre) return aPre ? -1 : 1
  return a.localeCompare(b)
}

/** latest 是否比 installed 新（任一为空都按「不更新」处理） */
export function isNewerVersion(latest: string | undefined, installed: string | undefined): boolean {
  if (!latest || !installed) return false
  return compareVersions(latest, installed) > 0
}
