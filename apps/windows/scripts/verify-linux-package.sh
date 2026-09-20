#!/usr/bin/env bash
#
# Linux 产物验收：把 T7 里几条「原以为只能人工看」的判据变成可自动断言的观测。
#
# 存在理由：计划文档记录了这些验收结论，但如果没有可重跑的脚本，
# 换台机器/换次打包就得从头再写一遍，结论也无法复核。
#
# 子命令：
#   tray          托盘注册 + 菜单布局（读 D-Bus，不需要人看面板）
#   appimage-env  AppImage 运行时是否设置 APPIMAGE（设计 §6.3 点名的关键约束）
#   silk          SILK 解码往返（编码用工作区副本、解码用 asar 内副本，交叉验证）
#   deb           deb 桌面条目/图标/postinst（除 sudo dpkg -i 外均可验）
#   all          除 deb 外全跑（deb 需要先产出 .deb）
#
# 用法：
#   bash apps/windows/scripts/verify-linux-package.sh tray
#   bash apps/windows/scripts/verify-linux-package.sh all
#
# 前置：
#   - 已跑过 `pnpm package:linux`（或 --target dir）产出 release/linux-unpacked
#   - 图形会话（tray 需要）；X11 下 DISPLAY 已设
#   - Node 22 在 PATH（见 AGENTS.md）
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WIN_ROOT="$(cd "$HERE/.." && pwd)"
RELEASE="$WIN_ROOT/release"
UNPACKED="$RELEASE/linux-unpacked"
APP="$UNPACKED/lumii"
ASAR="$UNPACKED/resources/app.asar"
APPIMAGE=$(ls "$RELEASE"/*.AppImage 2>/dev/null | head -1)
DEB=$(ls "$RELEASE"/*.deb 2>/dev/null | head -1)
WORK="${TMPDIR:-/tmp}/lumii-verify"
mkdir -p "$WORK"

red()  { printf '\033[31m%s\033[0m\n' "$*"; }
grn()  { printf '\033[32m%s\033[0m\n' "$*"; }
ylw()  { printf '\033[33m%s\033[0m\n' "$*"; }
step() { printf '\n\033[36m== %s ==\033[0m\n' "$*"; }

need_unpacked() {
  [ -x "$APP" ] || { red "缺少 $APP —— 先跑 pnpm package:linux --target dir"; exit 1; }
}

# 确保没有残留实例（单实例锁会让新实例直接退出，表现为「启动失败」的假象）
prepare_run() {
  pkill -f "linux-unpacked/lumii" 2>/dev/null
  pkill -f "appimage_extracted.*/lumii" 2>/dev/null
  rm -f "$HOME/.config/lumii-windows/Singleton"* 2>/dev/null
  sleep 1
}

# 未聚焦的窗口在 --no-sandbox 下也能跑；sandbox 需要 chrome-sandbox 属主为 root，
# 未安装的目录里属主是当前用户，故统一关掉。被测对象与渲染沙箱无关。
SANDBOX_FLAG="--no-sandbox"

# ---------------------------------------------------------------- tray
cmd_tray() {
  need_unpacked
  local LOG="$WORK/tray.log" DATA="$WORK/data-tray"
  rm -f "$LOG"; mkdir -p "$DATA/config"
  prepare_run

  snap() {
    gdbus call --session --dest org.kde.StatusNotifierWatcher \
      --object-path /StatusNotifierWatcher \
      --method org.freedesktop.DBus.Properties.GetAll org.kde.StatusNotifierWatcher 2>/dev/null \
      | tr ',' '\n' | grep -oE "':?[0-9.:]+@/StatusNotifierItem'" | tr -d "':" | sort -u
  }

  step "托盘：启动前快照"
  local BEFORE AFTER NEW SVC PID
  BEFORE=$(snap); echo "已注册 $(echo "$BEFORE" | grep -c .) 项"

  LUMII_CLIENT_DATA_DIR="$DATA" DISPLAY="${DISPLAY:-:0}" "$APP" $SANDBOX_FLAG > "$LOG" 2>&1 &
  local waited=0
  until grep -q "创建系统托盘" "$LOG" 2>/dev/null; do
    sleep 1; waited=$((waited+1))
    [ $waited -ge 90 ] && { red "90s 未见「创建系统托盘」"; tail -20 "$LOG"; return 1; }
  done
  echo "托盘初始化完成（${waited}s）"; sleep 3

  AFTER=$(snap); NEW=$(comm -13 <(echo "$BEFORE") <(echo "$AFTER") | head -1)
  if [ -z "$NEW" ]; then red "✗ 未发现新增 StatusNotifierItem"; kill %1 2>/dev/null; return 1; fi
  grn "✓ 新增托盘项: $NEW"

  # 按 PID 确认这一项确实是本应用的（多个 Electron 应用都用 chrome_status_icon_1，不能只看 Id）
  # 注意不能锚尾（`lumii$`）——cmdline 是 ".../lumii --no-sandbox"，锚尾匹配不到，PID 会是空的
  PID=$(pgrep -f "linux-unpacked/lumii --no-sandbox" | head -1)
  SVC=":$NEW"; SVC="${SVC%@*}"
  local owner
  owner=$(busctl --user list 2>/dev/null | awk -v n="$SVC" '$1==n {print $3}')
  if [ "$owner" = "lumii" ]; then grn "✓ 归属确认: $SVC -> $owner"; else ylw "! 归属为 $owner（预期 lumii），请核对"; fi

  step "托盘：菜单布局（com.canonical.dbusmenu）"
  # 递归深度用正数：gdbus 会把 -1 当选项解析（打印用法而非报错）
  local layout
  layout=$(busctl --user call "$SVC" /com/canonical/dbusmenu \
    com.canonical.dbusmenu GetLayout iias 0 10 0 2>&1) || true
  # 把 label/enabled 逐项摘出来，便于人眼对照 D13/D14
  # 不吞 stderr：解码器自己出错时必须看得见（先前 `2>/dev/null` 让它静默失败过一轮）
  echo "$layout" | python3 -c '
import sys, re
raw = sys.stdin.read()
raw = re.sub(r"\\([0-7]{3})", lambda m: chr(int(m.group(1), 8)), raw)
# 八进制转义还原出来的是 UTF-8 的**字节值**（被当成 latin-1 码点），
# 必须再按 latin-1 编回字节、再按 UTF-8 解码，否则中文全是乱码
raw = raw.encode("latin-1", errors="ignore").decode("utf-8", errors="replace")
for m in re.finditer(r"\(ia\{sv\}av\) (\d+)(.*?)(?=\(ia\{sv\}av\)|\Z)", raw, re.S):
    seg = m.group(2)
    lab = re.search(r"\"label\" s \"(.*?)\"", seg, re.S)
    en = re.search(r"\"enabled\" b (\w+)", seg)
    # 先算成变量再插值：f-string 表达式里不能出现反斜杠转义（PEP 701 也不允许 \" 这种写法）
    en_s = en.group(1) if en else "-"
    if lab:
        print("  id=%3s  enabled=%5s  %s" % (m.group(1), en_s, lab.group(1)))
'
  if [ -z "$layout" ]; then ylw "! 未取到菜单布局（该 SNI 可能未实现 dbusmenu）"; fi

  kill -TERM "$PID" 2>/dev/null
  # 等进程真正退出再快照——退出清理本身最长 8s，固定 sleep 2 会误判「未注销」
  waited=0
  while kill -0 "$PID" 2>/dev/null; do
    sleep 1; waited=$((waited+1)); [ $waited -ge 40 ] && break
  done
  sleep 2
  local AFTER2 GONE
  AFTER2=$(snap); GONE=$(comm -23 <(echo "$AFTER") <(echo "$AFTER2") | head -1)
  if [ -n "$GONE" ]; then grn "✓ 退出后已注销: $GONE（等待 ${waited}s）"; else ylw "! 退出后未见注销"; fi
}

# ------------------------------------------------------- appimage-env
cmd_appimage_env() {
  [ -n "$APPIMAGE" ] || { red "未找到 .AppImage —— 先跑 pnpm package:linux"; return 1; }
  local LOG="$WORK/appimage.log" DATA="$WORK/data-ai"
  mkdir -p "$DATA/config"; prepare_run

  step "启动 AppImage（extract-and-run）"
  echo "文件: $APPIMAGE"
  LUMII_CLIENT_DATA_DIR="$DATA" DISPLAY="${DISPLAY:-:0}" "$APPIMAGE" --appimage-extract-and-run $SANDBOX_FLAG > "$LOG" 2>&1 &
  local LAUNCH=$! PID="" waited=0
  while [ -z "$PID" ]; do
    # 不能用 /lumii$ 锚定：其后还有 --no-sandbox，锚尾会匹配不到
    PID=$(pgrep -f "appimage_extracted.*lumii --no-sandbox" 2>/dev/null | head -1)
    if [ -z "$PID" ]; then
      kill -0 "$LAUNCH" 2>/dev/null || { red "启动进程已退出"; tail -15 "$LOG"; return 1; }
      sleep 2; waited=$((waited+2))
      [ $waited -ge 180 ] && { red "180s 未找到 lumii 进程"; tail -15 "$LOG"; return 1; }
    fi
  done
  echo "进程 pid=$PID（${waited}s）"; sleep 2

  local ENVF="/proc/$PID/environ"
  [ -r "$ENVF" ] || { red "读不到 $ENVF"; return 1; }
  local AI APPDIR EXE
  AI=$(tr '\0' '\n' < "$ENVF" | sed -n 's/^APPIMAGE=//p')
  APPDIR=$(tr '\0' '\n' < "$ENVF" | sed -n 's/^APPDIR=//p')
  EXE=$(readlink -f "/proc/$PID/exe" 2>/dev/null)

  step "判据"
  echo "  APPIMAGE = ${AI:-<未设置>}"
  echo "  APPDIR   = ${APPDIR:-<未设置>}"
  echo "  exe      = ${EXE:-<读不到>}"
  local rc=0
  if [ -z "$AI" ]; then
    red "✗ APPIMAGE 未设置 —— resolveAutostartExecPath() 会退回 execPath（临时目录），自启必失效"; rc=1
  elif [ ! -e "$AI" ]; then
    red "✗ APPIMAGE=$AI 指向的文件不存在"; rc=1
  else
    grn "✓ APPIMAGE 已设置且指向真实文件（$(( $(stat -c %s "$AI") / 1048576 ))MB）"
  fi
  case "$EXE" in
    /tmp/*) grn "✓ execPath 落在 /tmp —— 证实设计「必须用 APPIMAGE」的前提" ;;
    *)      ylw "· execPath 不在 /tmp（$EXE）" ;;
  esac

  kill -TERM "$PID" 2>/dev/null; sleep 2
  pkill -f "appimage_extracted.*/lumii" 2>/dev/null
  return $rc
}

# ---------------------------------------------------------------- silk
cmd_silk() {
  need_unpacked
  [ -f "$ASAR" ] || { red "缺少 $ASAR"; return 1; }

  # 找到工作区里的 silk-wasm（asar 外的独立副本，用于交叉验证）
  local WS_NM
  WS_NM=$(ls -d "$WIN_ROOT"/../../node_modules/.pnpm/silk-wasm@*/node_modules 2>/dev/null | head -1)
  [ -n "$WS_NM" ] || { red "工作区未找到 silk-wasm（pnpm install 了吗）"; return 1; }

  local JS="$WORK/verify-silk.js"
  cat > "$JS" <<'JS'
const path = require('node:path')
const ASAR = process.argv[2], WS_NM = process.argv[3]
const SR = 16000, HZ = 440, DUR = 0.5
function sine() {
  const n = Math.floor(SR * DUR), p = new Int16Array(n)
  for (let i = 0; i < n; i++) p[i] = Math.round(Math.sin(2 * Math.PI * HZ * i / SR) * 16000)
  return p
}
function estHz(s, sr) {
  let c = 0
  for (let i = 1; i < s.length; i++) if ((s[i-1] < 0) !== (s[i] < 0)) c++
  return c / 2 / (s.length / sr)
}
;(async () => {
  const R = []
  const ck = (n, ok, d) => { R.push(ok); console.log(`${ok ? '✓' : '✗'} ${n}${d ? ` — ${d}` : ''}`) }
  const enc = require(path.join(WS_NM, 'silk-wasm'))
  ck('工作区 silk-wasm 可加载', typeof enc.encode === 'function')
  let dec
  try { dec = require(path.join(ASAR, 'node_modules', 'silk-wasm')); ck('asar 内 silk-wasm 可加载', typeof dec.decode === 'function') }
  catch (e) { ck('asar 内 silk-wasm 可加载', false, String(e && e.message)); process.exit(1) }
  const en = await enc.encode(sine(), SR)
  const silk = Buffer.from(en.data)
  ck('编码产出非空', silk.length > 0, `${silk.length} 字节`)
  ck('时长接近 0.5s', Math.abs(en.duration - 500) < 120, `${en.duration}ms`)
  const head = silk.subarray(0, 16).toString('latin1')
  ck('前 16 字节含 #!SILK（isSilkAudio 判据）', head.includes('#!SILK'), JSON.stringify(head))
  const de = await dec.decode(silk, SR)
  ck('解码产出非空', de.data.length > 0, `${de.data.length} 字节 PCM`)
  ck('时长接近 0.5s', Math.abs(de.duration - 500) < 150, `${de.duration}ms`)
  const out = new Int16Array(de.data.buffer, de.data.byteOffset, de.data.byteLength / 2)
  const peak = out.reduce((m, v) => Math.max(m, Math.abs(v)), 0)
  ck('峰值非零（确实有波形）', peak > 1000, `peak=${peak}`)
  const hz = estHz(out, SR)
  ck('主频接近 440Hz', hz > 300 && hz < 600, `估计 ${hz.toFixed(1)}Hz`)
  process.exit(R.every(Boolean) ? 0 : 1)
})().catch(e => { console.error('异常:', e); process.exit(1) })
JS

  step "SILK 往返（编码=工作区副本，解码=asar 内副本）"
  # asar 里的文件普通 Node 读不到（asar 是 Electron 打的 fs 补丁），必须用打包好的 Electron 跑
  ELECTRON_RUN_AS_NODE=1 "$APP" "$JS" "$ASAR" "$WS_NM"
}

# ----------------------------------------------------------------- deb
cmd_deb() {
  [ -n "$DEB" ] || { red "未找到 .deb —— 先跑 pnpm package:linux"; return 1; }
  local R="$WORK/deb-root"
  rm -rf "$R"; mkdir -p "$R"
  step "解包 $(basename "$DEB")"
  dpkg-deb -x "$DEB" "$R" || return 1
  dpkg-deb -e "$DEB" "$WORK/deb-control" 2>/dev/null || true

  local D
  D=$(find "$R" -name "*.desktop" -path "*applications*" | head -1)
  [ -n "$D" ] || { red "✗ 包内无 applications/*.desktop"; return 1; }
  grn "✓ 桌面条目: ${D#"$R"}"
  sed 's/^/    /' "$D"

  step "desktop-file-validate"
  if command -v desktop-file-validate >/dev/null; then
    local out; out=$(desktop-file-validate "$D" 2>&1)
    if [ -z "$out" ]; then grn "✓ 无警告/错误"
    else echo "$out" | sed 's/^/    /'
         echo "$out" | grep -qi error && red "✗ 有错误" || ylw "! 仅警告"
    fi
  else ylw "· 无 desktop-file-validate，跳过"; fi

  step "Exec / Icon 落位"
  local EXEC ICON
  EXEC=$(grep -m1 '^Exec=' "$D" | sed 's/^Exec=//' | awk '{print $1}' | tr -d '"')
  echo "  Exec = $EXEC"
  if [ -e "$R$EXEC" ]; then
    grn "✓ 包内存在"; [ -x "$R$EXEC" ] && grn "✓ 带可执行位" || red "✗ 缺可执行位"
  else red "✗ 包内不存在 $EXEC"; fi

  ICON=$(grep -m1 '^Icon=' "$D" | cut -d= -f2)
  local IP; IP=$(find "$R/usr/share/icons" -name "${ICON}.*" 2>/dev/null | head -1)
  if [ -n "$IP" ]; then
    grn "✓ 图标: ${IP#"$R"}"
    python3 - "$IP" <<'PY'
import struct, sys
with open(sys.argv[1], 'rb') as f: h = f.read(24)
if h[:8] != b'\x89PNG\r\n\x1a\n': print("    ! 非 PNG"); sys.exit()
w, ht = struct.unpack('>II', h[16:24])
print(f"    PNG {w}x{ht}" + ("  ✓ ≥512" if w >= 512 and ht >= 512 else "  ! 小于 512"))
PY
  else red "✗ 未找到图标文件"; fi

  step "维护者脚本"
  for S in postinst postrm; do
    if [ -f "$WORK/deb-control/$S" ]; then
      grn "✓ $S"
      [ "$S" = postinst ] && { grep -q "chrome-sandbox" "$WORK/deb-control/$S" \
        && grn "  ✓ 含 chrome-sandbox 处置" || red "  ✗ 未处理 chrome-sandbox"; }
    else ylw "· 无 $S"; fi
  done

  ylw "· 「sudo dpkg -i 真实安装」需 root，未在此脚本内验证"
}

case "${1:-}" in
  tray)          cmd_tray ;;
  appimage-env)  cmd_appimage_env ;;
  silk)          cmd_silk ;;
  deb)           cmd_deb ;;
  all)           cmd_tray; cmd_appimage_env; cmd_silk
                 [ -n "$DEB" ] && cmd_deb || ylw "· 无 .deb，跳过 deb 子项" ;;
  *) sed -n '3,25p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; exit 1 ;;
esac
