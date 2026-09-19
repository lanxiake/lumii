#!/bin/bash
# Lumii deb postinst —— 安装后配置。
#
# 以 root 身份执行。两件事：
#
# 1. 修正 chrome-sandbox 权限（root:root + 4755）
#
#    Ubuntu 24.04 默认 kernel.apparmor_restrict_unprivileged_userns=1，Chromium
#    只能走 setuid sandbox；而打包产物里 chrome-sandbox 通常是 0755，
#    会导致应用启动即 abort：
#      FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:163
#
#    afterPack 钩子已改过模式位，但 dpkg 重新展开文件后权限会被重置，
#    且 chown root 只能在 root 下做，所以这里必须再修一次。
#
# 2. 更新桌面与图标缓存（可选，失败不影响安装）
set -e

# 安装目录由 electron-builder 的 installPrefix(/opt) + sanitizedProductName 决定。
# 用 glob 而非硬编码，避免 productName 调整后此处静默失效。
for SANDBOX in /opt/*/chrome-sandbox; do
  [ -f "$SANDBOX" ] || continue
  chown root:root "$SANDBOX" 2>/dev/null || true
  chmod 4755 "$SANDBOX" 2>/dev/null || true
done

# 图标与桌面数据库更新；容器/最小系统中这两个命令可能不存在
if [ -x "$(command -v update-desktop-database)" ]; then
  update-desktop-database -q /usr/share/applications 2>/dev/null || true
fi
if [ -x "$(command -v gtk-update-icon-cache)" ] && [ -d /usr/share/icons/hicolor ]; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
fi

exit 0
