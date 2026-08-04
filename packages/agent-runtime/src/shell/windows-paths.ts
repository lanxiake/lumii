/**
 * Windows 路径转换 — posix ↔ win32（主题4 P1）
 *
 * Git Bash 接受 POSIX 风格路径（/d/foo/bar），而 Windows 原生为 D:\foo\bar。
 * 在把 cwd 或路径参数传给不同 shell 时做转换，消灭手工转义试错。
 */

/**
 * Windows 盘符路径 → POSIX 风格（Git Bash 可识别）
 *
 * `D:\foo\bar` → `/d/foo/bar`；`C:/a/b` → `/c/a/b`
 * 非盘符路径（已是 posix 或相对路径）仅做分隔符归一。
 *
 * @param winPath - Windows 路径
 */
export function winToPosix(winPath: string): string {
  const driveMatch = winPath.match(/^([a-zA-Z]):[\\/](.*)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/\\/g, "/");
    return `/${drive}/${rest}`;
  }
  return winPath.replace(/\\/g, "/");
}

/**
 * POSIX 风格 → Windows 盘符路径
 *
 * `/d/foo/bar` → `D:\foo\bar`；非盘符路径仅做分隔符归一。
 *
 * @param posixPath - POSIX 路径
 */
export function posixToWin(posixPath: string): string {
  const driveMatch = posixPath.match(/^\/([a-zA-Z])\/(.*)$/);
  if (driveMatch) {
    const drive = driveMatch[1].toUpperCase();
    const rest = driveMatch[2].replace(/\//g, "\\");
    return `${drive}:\\${rest}`;
  }
  return posixPath.replace(/\//g, "\\");
}
