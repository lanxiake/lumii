#!/bin/bash
# Lumii deb postrm —— 卸载后清理。
#
# 以 root 身份执行。
#
# 只清理**安装时由应用自己创建**的文件，不碰用户数据：
#   - ~/.lumii/ 保留（与 electron-builder 的 deleteAppDataOnUninstall: false 语义一致）
#   - 用户各自的 ~/.config/autostart/lumii.desktop 属于用户家目录，不同用户的
#     路径在卸载时不可穷举，且它指向已不存在的可执行文件时会失效；
#     由应用自身在检测到目标缺失时清理（见 platform/autostart.ts）。
#
# 因此这里只做系统级缓存刷新。
set -e

if [ -x "$(command -v update-desktop-database)" ]; then
  update-desktop-database -q /usr/share/applications 2>/dev/null || true
fi
if [ -x "$(command -v gtk-update-icon-cache)" ] && [ -d /usr/share/icons/hicolor ]; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
fi

exit 0
