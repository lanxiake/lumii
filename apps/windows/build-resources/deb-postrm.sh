#!/bin/bash
# Lumii deb postrm —— 卸载后清理。
#
# 以 root 身份执行。
#
# 只清理**安装时由应用自己创建**的文件，不碰用户数据：
#   - ~/.lumii/ 保留（与 electron-builder 的 deleteAppDataOnUninstall: false 语义一致）
#   - 用户各自的 ~/.config/autostart/lumii.desktop 属于用户家目录，不同用户的
#     路径在卸载时不可穷举，因此**本期不清理**。
#
#     勘误（2026-09-20）：这里原先写「由应用自身在检测到目标缺失时清理
#     （见 platform/autostart.ts）」，但该逻辑并不存在——
#     `isLinuxAutostartEnabled()` 就是 `fs.existsSync`，不校验 Exec 目标。
#     设计 §6.3 已同步勘误，且 §4.1 原本就写明「第二期随 autostart 一起补」。
#
#     用户可见后果：AppImage 用户开启自启后若删掉 AppImage 文件，
#     .desktop 会残留并指向失效目标（静默失败，不影响其它应用）。
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
