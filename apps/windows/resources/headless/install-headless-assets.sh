#!/bin/bash
# Lumii 无头部署资产安装 —— 写入两样东西：
#
#   1. <bin>/lumii-ui                      CLI 启动器（终端里的用户引导全靠它）
#   2. <unit>/lumii-headless.service       systemd **用户**服务（默认不启用，用户自行 enable）
#
# 本文件随安装包分发到 <应用目录>/resources/headless/，安装时由 deb-postinst.sh 调用；
# AppImage / 手工解包的用户也可以直接跑：
#
#   sudo squashfs-root/resources/headless/install-headless-assets.sh /path/to/squashfs-root
#   # 或者只生成到临时目录里看看内容：
#   resources/headless/install-headless-assets.sh /opt/Lumii /tmp/bin /tmp/units
#
# 用法: install-headless-assets.sh [应用目录] [bin 目录] [systemd 用户单元目录]
#
# 为什么不把这两个文件直接打进安装包（fpm/electron-builder 的 deb 选项里没有
# 「额外放进包内的文件」这一项，只有 afterInstall / afterRemove 两个钩子）：
# `ExecStart` 必须指向真实的应用目录，而目录名由 electron-builder 的
# sanitizedProductName 决定（当前是 /opt/Lumii，大写）。写死在配置里，
# 改个产品名就会变成指向不存在文件的**静默失效**——
# 与 deb-postinst.sh 里用 glob 找 chrome-sandbox 是同一套思路。
set -e

APP_DIR="${1:-}"
BIN_DIR="${2:-/usr/bin}"
UNIT_DIR="${3:-/usr/lib/systemd/user}"

# 自动探测应用目录：找可执行文件，而不是猜目录名
if [ -z "$APP_DIR" ]; then
  for CANDIDATE in /opt/*/lumii; do
    if [ -x "$CANDIDATE" ]; then
      APP_DIR="$(dirname "$CANDIDATE")"
      break
    fi
  done
fi

if [ -z "$APP_DIR" ] || [ ! -x "$APP_DIR/lumii" ]; then
  echo "install-headless-assets: 没找到应用可执行文件（\$APP_DIR/lumii），跳过无头资产安装" >&2
  # 不返回非零：无头资产是附加能力，装不上不该让整个 dpkg 安装失败
  exit 0
fi

# 归一成绝对路径：手工传相对路径时，生成的文件里若留相对路径，
# 换个工作目录就找不到应用了（启动器/单元文件里的路径都是给别人用的）
APP_DIR="$(cd "$APP_DIR" && pwd)"

CLI_JS="$APP_DIR/resources/app-ui-cli/lumii-ui.mjs"
if [ ! -f "$CLI_JS" ]; then
  echo "install-headless-assets: 包里没有 $CLI_JS，跳过 CLI 启动器" >&2
fi

# ── 1. CLI 启动器 ──────────────────────────────────────────────────────────
if [ -f "$CLI_JS" ]; then
  mkdir -p "$BIN_DIR"
  cat > "$BIN_DIR/lumii-ui" <<EOF
#!/bin/sh
# Lumii 控制 CLI（由 Lumii 的安装脚本生成，重装会覆盖；不要手改）。
#
# 用**应用自带的 Electron**以 node 模式运行 CLI，因此不要求系统装 node：
#   ELECTRON_RUN_AS_NODE=1 → Electron 不启动 GUI，按 node 跑脚本
# 数据目录默认 ~/.lumii，可用 LUMII_CLIENT_DATA_DIR 覆盖（多实例/测试时用）。
export ELECTRON_RUN_AS_NODE=1
exec "$APP_DIR/lumii" "$CLI_JS" "\$@"
EOF
  chmod 755 "$BIN_DIR/lumii-ui"
  echo "install-headless-assets: 已写入 $BIN_DIR/lumii-ui"
fi

# ── 2. systemd 用户服务 ────────────────────────────────────────────────────
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/lumii-headless.service" <<EOF
[Unit]
Description=Lumii 灵栖（无头模式：终端引导 + 渠道接入）
Documentation=file:$APP_DIR/resources/app-ui-cli/lumii-ui.mjs
After=default.target
# 起崩循环兜底：5 分钟内超过 5 次就停下（否则 Restart=on-failure 会一直重试）
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
ExecStart=$APP_DIR/lumii --headless
# 无头模式不创建窗口，也用不到图形会话；显式清空，避免从会话环境继承 DISPLAY 后
# 被能力矩阵误判成「有图形」（录屏/桌宠会显示为可用，点进去却静默失败）
Environment=DISPLAY=
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
chmod 644 "$UNIT_DIR/lumii-headless.service"
echo "install-headless-assets: 已写入 $UNIT_DIR/lumii-headless.service（默认未启用）"
echo "  启用: systemctl --user daemon-reload && systemctl --user enable --now lumii-headless"
echo "  日志: journalctl --user -u lumii-headless -f"

exit 0
