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
# 因此这里做两件事：清掉安装时由 postinst 装的无头资产，刷新系统级缓存。
#
# 无头资产（/usr/bin/lumii-ui、/usr/lib/systemd/user/lumii-headless.service）
# 不是 dpkg 记录的文件（postinst 运行时生成，deb 的 fpm 选项里没有「额外文件」这一项），
# 所以必须在这里显式删，否则卸载后留下指向已删除应用的启动器与单元。
#
# **不碰** `systemctl --user`：postrm 以 root 跑，删用户的 enable 符号链接需要知道
# 是哪个用户启用的（多用户机器上无法穷举）。用户侧残留是一个指向已删单元的
# enable 链接，systemd 会在下次 daemon-reload 时报「unit not found」而不会造成别的后果；
# 文档里给出了 `systemctl --user disable --now lumii-headless` 的清理步骤。
set -e

rm -f /usr/bin/lumii-ui
rm -f /usr/lib/systemd/user/lumii-headless.service

if [ -x "$(command -v update-desktop-database)" ]; then
  update-desktop-database -q /usr/share/applications 2>/dev/null || true
fi
if [ -x "$(command -v gtk-update-icon-cache)" ] && [ -d /usr/share/icons/hicolor ]; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor 2>/dev/null || true
fi

exit 0
