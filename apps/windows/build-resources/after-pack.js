/**
 * electron-builder afterPack 钩子。
 *
 * 修正 Linux 产物的 chrome-sandbox 权限。
 *
 * ## 为什么需要
 *
 * Ubuntu 24.04 默认 `kernel.apparmor_restrict_unprivileged_userns=1`，非特权用户的
 * user namespace 被 AppArmor 限制，Chromium 因此只能走 setuid sandbox。若
 * `chrome-sandbox` 不是 `root:root` + `4755`，Electron 直接 abort：
 *
 *   FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:163
 *   The SUID sandbox helper binary was found, but is not configured correctly.
 *
 * 而 electron 的下载产物里该文件是 `0755`（实测 npm 镜像 v36.9.5 确认），所以必须补。
 * deb 的 `postinst` 会再修一次（覆盖安装后 dpkg 会重新展开文件、重置权限），
 * 此处修的是 AppImage 与 unpacked 目录 —— 尤其是 AppImage：它**必须**在打包时就
 * 带上正确的权限位，挂载后无法补救。
 *
 * ## 注意
 *
 * - 只对 Linux 生效，win32/darwin 直接返回。
 * - 打包在普通用户下执行，这里只能改**模式位**；`chown root` 由 deb 的 postinst
 *   以 root 身份完成。AppImage 没有安装步骤，靠模式位 + 用户自身 userns 配置兜底。
 *
 * @param {import('electron-builder').AfterPackContext} context
 */
const fs = require('node:fs')
const path = require('node:path')

/** chrome-sandbox 在解包产物中的相对路径 */
const SANDBOX_REL_PATH = 'chrome-sandbox'

/** setuid + rwxr-xr-x */
const SANDBOX_MODE = 0o4755

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return

  const sandboxPath = path.join(context.appOutDir, SANDBOX_REL_PATH)
  if (!fs.existsSync(sandboxPath)) {
    // 不该发生：Electron 的 Linux 产物必然带 chrome-sandbox。缺失说明产物形态变了，
    // 静默跳过会让用户装完启动即 abort 且无线索，不如让打包直接失败。
    throw new Error(
      `[after-pack] Linux 产物缺少 ${SANDBOX_REL_PATH}：${sandboxPath}\n` +
        'Electron 产物形态可能已变更，请检查 electron-builder 版本与下载产物。',
    )
  }

  const before = fs.statSync(sandboxPath).mode & 0o7777
  fs.chmodSync(sandboxPath, SANDBOX_MODE)
  const after = fs.statSync(sandboxPath).mode & 0o7777

  console.log(
    `[after-pack] chrome-sandbox 权限已修正：0${before.toString(8)} → 0${after.toString(8)}`,
  )
}
