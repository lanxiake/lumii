# Lumii 客户端 Linux 与无头环境部署 — 调查分析

> 日期：2026-09-12
> 状态：**现状调查与可行性分析**（本文只描述现状与「需要改什么」，不含任何代码改动）
> 调查对象：`apps/windows/`、`packages/agent-runtime`、`packages/browser-control`、`packages/pet-core`、`scripts/`
> 参考：`AGENTS.md`、`docs/standards/`

---

## 0. 结论摘要

| 问题 | 结论 |
|------|------|
| 能否打包成 Ubuntu 可运行客户端 | **能。** Electron 36 支持 linux-x64，electron-builder 26.15.3 已内置 AppImage/deb/rpm/snap 目标，缺的只是配置与脚本入口 |
| 能否部署到无图形界面的终端 | **能，且基础比预期好。**`packages/agent-runtime/src` 中 **零 `electron` 导入**（已 grep 验证）；控制面已是 `127.0.0.1` HTTP + Bearer token（`app-ui-control/server.ts:42,561`），配套 `lumii-ui` 零依赖 CLI 已存在 |
| 最大工作量 | 不是打包，而是 **① 运行时对 Windows 工具链（PowerShell / taskkill / WMI / PATHEXT）的依赖**、**② 桌宠悬浮窗的穿透交互机制在 Linux 上失效** |
| 最大技术风险 | 桌宠窗依赖 `setIgnoreMouseEvents(ignore, { forward: true })`，而 `forward` 是 **darwin/win32 专属**（`electron.d.ts:20601-20609`）。Linux 下必须改用「主进程光标轮询 + 区域命中」重写 |
| Wayland 怎么办 | 首版 **强制 X11**（`--ozone-platform=x11`，Ubuntu 默认带 XWayland）；Wayland 原生会话下透明窗/全局置顶/全局光标坐标均受限，桌宠需屏蔽 |
| 无头模式的最大缺口 | **扫码登录无出口**：微信/QQ 登录二维码当前只发往渲染进程（`index.ts:1505` `mainWindow?.webContents.send('qbot:qrcode')`），无窗口时静默丢失 |
| 渠道功能是否需要重写 | **不需要。** 微信/QQ/飞书/企微均为网络桥接，无 wxauto/UIAutomation 类客户端自动化；`wecom-login-service.ts:29` 已映射 linux=3 |
| 浏览器控制是否需要重写 | **基本不需要。** `chrome.executables.ts:217-227,574-591,686-695` 的 Linux 探测分支已实现 |
| 原生产物 | `better-sqlite3` / `sharp` / `onnxruntime-node` / `@napi-rs/canvas` 均有 linux-x64 产物，只需按平台声明依赖并打包对应二进制 |
| 处置原则 | 不支持的功能**直接屏蔽入口**，不做静默失败；核心（对话 / 记忆 / 渠道 / 定时任务 / 技能）必须可用 |

**粗估**：桌面形态达到「能启动 + 桌宠可用 + 核心功能可用」约 2-3 周；无头形态在其之上再加约 1-2 周（主要是启动路径分叉与扫码登录出口）。

---

## 1. 调查范围与方法

- **代码事实核查**：逐项 grep/read 确认，文中每条结论均附 `文件:行号`。
- **平台能力核查**：直接读取本地安装的 Electron 36.9.5 类型定义（`node_modules/.pnpm/electron@36.9.5/node_modules/electron/electron.d.ts`），以官方 `@platform` 标注为准，而非经验判断。
- **未做的部分**：本文不含实测。所有标注「需实测」的条目必须在真实 Ubuntu 环境验证后才能作为结论使用（见 §10、§11）。

---

## 2. 两种目标形态

| 维度 | 形态 A：桌面客户端 | 形态 B：无头终端 |
|------|------------------|----------------|
| 场景 | Ubuntu 22.04/24.04 桌面，用户可视化交互 | 服务器/容器/无显示器的终端，长期驻留 |
| 主要交互入口 | 主窗口 + 桌宠 + 托盘 | `lumii-ui` CLI + 渠道消息（微信/QQ/飞书/企微） |
| 形态约束 | 透明窗、置顶、穿透、托盘、通知 | **无显示服务器**，或仅 `xvfb` 虚拟显示 |
| 会话类型 | X11 / XWayland（Wayland 需降级） | 不适用 |
| 产物 | AppImage + deb | deb（或 tar + systemd user service） |
| 与形态 A 的关系 | — | **共享 P0 打包与 P1 平台层的全部工作**，额外需要启动路径分叉与入口替代 |

**关键判断**：两种形态不是二选一，而是同一份代码的两种启动配置。无头形态**不是**「桌面版去掉界面」，而是要保证「所有服务在无窗口时仍能正确初始化」，这需要专门的改造（§6）。

---

## 3. 现状盘点

### 3.1 已有的跨平台资产（可直接复用，不重写）

| 资产 | 位置 | 可复用度 |
|------|------|---------|
| Shell Provider 接口（bash/powershell/cmd） | `packages/agent-runtime/src/shell/shell-provider.ts:13-40` | 高，`BashProvider` 非 Windows 返回 `/bin/bash`（`bash-provider.ts:30-33`） |
| `resolveShell()` 兜底 | `resolve-shell.ts:97-104` | 高，已有 `/bin/bash` 终极回退 |
| 浏览器可执行文件探测（三平台） | `packages/browser-control/src/browser/chrome.executables.ts:217-227,574-591,686-695` | 高，Linux 候选路径与 X_OK 检查齐备 |
| 端口检查 unix 分支 | `packages/browser-control/src/lib/ports-inspect.ts:64,85,199`、`ports-lsof.ts:4-7` | 高 |
| 磁盘信息非 Windows 分支（`fs.statfs`） | `apps/windows/src/main/screen-record/disk-space.ts:46-58` | 高 |
| Python venv 布局分支（`bin/python`） | `apps/windows/src/main/python-runner.ts:240-243` | 中，缺解释器获取链路 |
| 技能脚本 `.sh/.bash` 分支 | `apps/windows/src/main/shell-runner.ts:46-67`、`skill-external-loader.ts:135` | 中 |
| 数据根可覆盖（`LUMII_CLIENT_DATA_DIR`） | `apps/windows/src/main/paths.ts:39-65` | 高，默认 `~/.lumii` 在 Linux 天然可用 |
| 渠道层 | `apps/windows/src/main/channel/` | 高，纯网络桥接 |
| `packages/pet-core` | 全包 | 高，强制纯 TypeScript |
| **`packages/agent-runtime` 整体** | 全包 | **高**，已 grep 验证：src 下零 `electron` 导入 |
| **本机 HTTP 控制面** | `apps/windows/src/main/app-ui-control/server.ts:42,561,591,595` | **高**，`127.0.0.1` + Bearer token，无头可直接复用 |
| **`lumii-ui` CLI** | `apps/windows/resources/app-ui-cli/lumii-ui.mjs`（零依赖） | **高**，通过 HTTP 驱动，天然跨平台 |
| 内置技能 | `apps/windows/bundled-skills/` | 高，**已盘点：482 个跟踪文件中零 `.ps1/.bat/.cmd`**，全部是 Markdown 提示词 |

### 3.2 平台耦合统计

| 类别 | 数量 | 代表位置 |
|------|------|---------|
| 独立 `taskkill` 调用点 | 8 | `shell-runner.ts:282`、`python-runner.ts:277`、`ts-runner.ts:253`、`local-bash.ts:28`、`browser-service.ts:122`、`system-service.ts:784`、`vendor/ports-inspect.ts`、`server-context.ts:530` |
| PowerShell 调用点（非测试） | ~84 处引用 | `system-service.ts:696,745`、`coding-dev-cli-install.ts:213`、`uv-installer.ts:71`、`dialog-clipboard-ipc.ts:81`、`disk-space.ts:29`、`python-env.ts:294` |
| 含 `process.platform` 的主进程文件 | 21 | — |
| `windowsHide` 调用点 | 40+ | 无害，可保留 |
| 仅 Windows 实现的功能模块 | 6 | 内嵌 Python 运行时、uv 自动安装、Coding CLI 安装、录屏系统音频、WGC 捕获、开机自启 |

**重复实现**（移植期收敛的主要收益点）：

- `forceKillProcess` 有 **5 份近乎逐字重复的实现**（`shell-runner.ts:266-296`、`python-runner.ts:264-287`、`ts-runner.ts:248-261`、`local-bash.ts:15-38`），另有 3 处直接调用 `taskkill`。
- **非 win32 分支只调 `child.kill('SIGTERM')`——只杀 shell 本身，孙进程变孤儿**。`local-bash.ts:15-38` 的注释已指出该问题，但只对 Windows 做了修复。
- **2 份重复的数据根实现**：`paths.ts:39-65` 与 `client-data-root.ts:39-52`，语义完全相同。
- **2 套并行的 shell 解析**：`packages/agent-runtime/src/shell/resolve-shell.ts`（Provider 抽象，跨平台）与 `apps/windows/src/main/shell-runner.ts:39-73`（按扩展名分派，PowerShell/cmd 硬编码）。

### 3.3 三个硬约束（Electron 官方标注，非经验判断）

| 约束 | 证据 | 后果 |
|------|------|------|
| `IgnoreMouseEventsOptions.forward` 是 `@platform darwin,win32` | `electron.d.ts:20601-20609` | 桌宠 hover→解除穿透闭环在 Linux 完全失效 |
| `setLoginItemSettings` 是 `@platform darwin,win32` | `electron.d.ts:1642` | 开机自启需改走 XDG autostart |
| `setShape` 是 `@experimental`，`@platform win32,linux` | `electron.d.ts:3255` | 本可作为穿透替代方案，但代码已明确弃用（见 §5.3） |

---

## 4. 阻塞项与优先级

> **P0** = 不改则无法产出可安装产物；**P1** = 产物能启动但作为「桌面伙伴」不可用；**P2** = 功能不对等；**P3** = 发行与打磨。

| 优先级 | 主题 | 影响面 | 预估 | 形态 |
|--------|------|--------|------|------|
| **P0** | 打包与构建链路 | 配置 + 打包脚本 + 原生依赖声明 + 图标 | 2 天 | A + B |
| **P1** | 平台抽象层 | 进程树 kill、Shell、系统信息、安全策略、数据目录、Shim | 4-6 天 | A + B |
| **P1** | 桌宠悬浮窗与桌面集成 | 穿透交互重写；托盘/通知/自启 | 4-6 天 | 仅 A |
| **P1'** | 无头启动路径 | 启动分叉、扫码登录出口、依赖 `mainWindow` 的路径 | 3-5 天 | 仅 B |
| **P2** | 运行时与功能对等 | Python、语音、ffmpeg/录屏、Coding CLI/uv | 15-20 天 | A + B |
| **P3** | 发行与打磨 | 自动更新、desktop 集成、平台文案、存量缺陷、CI | 5 天 | A + B |

**依赖关系**：P0 是全部工作的前置；P1 两项与 P1' 可并行（不同文件域）；P2 各项彼此独立；P3 只需 P1 完成即可启动。

---

## 5. 桌面形态逐项分析

### 5.1 P0：打包与构建链路

**现状**：`electron-builder.json` 只有 `win`/`nsis`/`portable` 三段，**无 `linux` 段**（grep `linux|appimage|deb|rpm|snap` 零命中）。所有构建入口硬编码 `--win`（`apps/windows/package.json:20-28`、`scripts/package-windows.js:422`、根 `package.json:13`）。

| 需要改什么 | 位置 | 说明 |
|-----------|------|------|
| 新增 `linux` / `deb` 段 | `electron-builder.json` | 目标 `AppImage` + `deb`，x64；`icon` 需 ≥512 PNG（现只有 `assets/icon.ico`） |
| 原生包按平台并列声明 | `electron-builder.json:16-19,110` | 白名单追加 `@img/sharp-linux-x64`、`sherpa-onnx-linux-x64`；不存在者匹配为空即跳过，无需条件表达式 |
| 清理死条目 | `electron-builder.json:21` | `node_modules/silk-sdk/**/*` 指向**已不存在的包**（commit 5a37adc 迁移为 `silk-wasm`） |
| 依赖平台化 | `apps/windows/package.json:48,87-88` | `@img/sharp-win32-x64` 从 `dependencies` 移入 `optionalDependencies`；补 linux 平台包 |
| 打包脚本跨平台化 | `apps/windows/scripts/package-windows.js`（569 行） | 已是 Node 脚本，改造为 `package-app.js` + `--platform`；收敛 4 处 Windows 专属点：`stepVerify`（强制 `icon.ico`+`installer.nsh`）、`killLockedAppProcesses`（`:169-190`）、EPERM 重试（`:438-465`）、产物扩展名过滤（`:470-485` 只认 `.exe/.zip/.7z`） |
| 图标生成 | `scripts/generate-icon.cjs:147-159` | 现只输出 `icon.ico` 与 32px `tray-icon.png`，需追加 512px PNG |
| ffmpeg 打包 | `electron-builder.json:11-41` | `@ffmpeg-installer/**` 在 `asarUnpack` 中但**不在 `files` 白名单**；是否实际打包平台二进制存疑（见 §9 缺陷 3）。建议改为「extraResources 内置 → `@ffmpeg-installer` → 系统 PATH」三级解析 |
| 构建方式 | — | **在 Ubuntu 上原生构建**，不做 Windows→Linux 交叉打包（原生模块必须在目标平台 rebuild；pnpm 无 `supportedArchitectures`，自动安装宿主平台 optional 包） |

**打包流程现状**（`package-windows.js` 控制流）：
`parseArgs → stepClean → stepInstall → stepVerify → killLockedAppProcesses → draw 配置检查 → stepBuild → stepPackage → 产物列表`

**好消息**：`.npmrc` 的 `shamefully-hoist=true`、npmmirror 镜像、`pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 均平台无关，无需修改；`apps/windows/package.json:43-44` 的 `postinstall`（`@electron/rebuild --only better-sqlite3,sharp`）在 Linux 上同样成立。

### 5.2 P1：平台抽象层

**目标**：把散落在主进程的 Windows 工具链调用收敛为一组按平台分派的原语，使 Linux 分支成为实现细节而非调用方负担。

**建议的模块划分**（新增 `apps/windows/src/main/platform/`）：

```
platform/
├── index.ts              # 统一导出
├── process-kill.ts       # killProcessTree / spawnChildInGroup
├── shell-env.ts          # 按平台构造子进程环境变量白名单
├── system-info.ts        # 磁盘 / 进程列表 / 结束进程
├── security-policy.ts    # 按平台的允许根、禁止模式、命令白名单、路径长度上限
├── cli-paths.ts          # 第三方 CLI 候选安装路径
└── autostart.ts          # 开机自启（XDG autostart）
```

> 不建议新建 `packages/platform`：这些原语依赖 Electron/主进程上下文，放进 `packages/agent-runtime` 会违反 `AGENTS.md:9` 的边界约定。`packages/browser-control` 内的平台码已是自洽的跨平台实现，保持原地。

**① 进程树终止（8 处收敛为 1 处）**

```ts
// 设计示意
export function spawnChildInGroup(command, args, options): ChildProcess   // POSIX: detached=true 使其成为进程组长
export function killProcessTree(child, signal = 'SIGTERM'): void
  // win32: taskkill /pid <pid> /T /F          （SIGTERM 对 cmd/powershell 子进程树无效）
  // posix: process.kill(-pid, signal) → 2s → SIGKILL；进程组不可用时回退单进程 kill
export function killPidTree(pid: number): void                            // 外部进程（浏览器残留等）
```

**行为变更提示**：POSIX 下需以 `detached: true` 启动，否则进程组不存在；随之需要在应用退出钩子统一清理子进程，避免残留。

**② Shell 与环境变量**

- `shell-runner.ts:39-73` 的扩展名分派：`.ps1` → `pwsh`（已跨平台回退）；`.bat/.cmd` → **非 win32 明确报错**并提示改用 `.sh`；`.sh/.bash` → `bash -c`（已有）。
- `shell-runner.ts:113-144` 的环境白名单：POSIX 侧需补 `TMPDIR`、`LANG/LC_*`、`SHELL`、`XDG_*`、`DISPLAY/WAYLAND_DISPLAY/XAUTHORITY`、`DBUS_SESSION_BUS_ADDRESS`。后四项是**有意的边界放宽**（技能可能需要拉起 GUI 或发通知），需在注释中说明，而非默认放开整个 `process.env`。

**③ 系统信息**（`system-service.ts:683-771`）

| 数据 | Windows（现状） | Linux 建议 |
|------|----------------|-----------|
| 磁盘 | `Get-WmiObject Win32_LogicalDisk` | `df -kP -x tmpfs -x devtmpfs -x squashfs` |
| 进程 | `Get-Process \| ConvertTo-Json` | `ps -eo pid=,comm=,pcpu=,rss=`（单次调用取全量） |
| 结束进程 | `taskkill /PID x /F` | 复用 `killPidTree` |

`SystemInfo`（platform/arch/hostname/…）已由 `os` 模块提供（`system-service.ts:658`），无需改动。

**④ 安全策略**（`security-utils.ts:38-68`）

现状把两套平台规则混在一起，`allowedCommands: ['powershell','cmd','tasklist','taskkill','systeminfo','wmic']` 是 Windows 命令，路径黑名单也混了 `/etc`、`/var` 与 `C:\Windows`，长度上限硬编码 260。

设计要点：
- 按平台返回完整策略对象（允许根 / 禁止模式 / 命令白名单 / 最大长度 / 最大深度）；
- **允许根优先于禁止模式**：命中 `allowedBasePaths` 即通过，避免 `os.tmpdir()` 的平台差异被 `/^\/var/i` 误伤；
- POSIX 侧移除过宽的 `/^\/var/i`，改为 `/^\/var\/lib`、`/^\/var\/spool`；补齐 `/usr`、`/boot`、`/proc`、`/sys`、`/dev`、`/root`；
- **不因为移植而放宽 Windows 侧的策略**——这是越权防护，直接删除会引入安全回归。

**⑤ 数据目录与 Shim**

| 项 | 现状 | 处置 |
|----|------|------|
| 数据根 | `paths.ts:39-65` 与 `client-data-root.ts:39-52` 重复 | 合并为一份，行为不变（`LUMII_CLIENT_DATA_DIR` → `~/.lumii`） |
| 目录树 | `~/.lumii/{config,cache,logs,temp,runtimes,voice,workspace,...}` | 不改。**不迁移到 XDG**：`~/.lumii` 已是 Linux 惯用形态，迁移会造成跨平台数据分裂 |
| Shim 生成 | `runtime-env.ts:95-133` 已同时写 POSIX `sh`（`mode: 0o755`）与 `.cmd` | POSIX 侧基本可用 |
| **PATH 键名缺陷** | `runtime-env.ts:181-186` 复用大写 `Path` 键 | **Linux 下 `process.env.Path` 不存在 → shim 目录不进 PATH**，`lumii-ui` 等命令不可用。这是会导致功能静默失效的具体缺陷 |

**⑥ CLI 路径探测**：`cli-user-path.ts:21-29` 与 `coding-dev-cli-detect.ts:179-189` 需补 Linux 候选（`~/.local/bin`、`~/.cargo/bin`、`~/.npm-global/bin`、`/usr/local/bin`、`~/.bun/bin`）。注意 `~/.local/bin` 已在 `cli-user-path.ts:17-20` 无条件包含，属已就绪部分。`where.exe`/`which` 分支已存在（`coding-dev-cli-detect.ts:197,233`）。

**⑦ 剪贴板**：`ipc/dialog-clipboard-ipc.ts:61-87` 的 win32 走 PowerShell 写 CF_HDROP、darwin 走 `osascript`，Linux 落到 Electron clipboard。Linux 的等价物是 X11 `text/uri-list` 目标，首版可只复制路径文本。

### 5.3 P1：桌宠悬浮窗（最大技术风险）

**窗口构造**（`pet-window-manager.ts:170-209`）：`frame:false` + `transparent:true` + `skipTaskbar:true` + `alwaysOnTop`，覆盖所有显示器 `workArea` 的并集外接矩形，`setAlwaysOnTop(true,'screen-saver')`、`setVisibleOnAllWorkspaces`、`setIgnoreMouseEvents(true, { forward: true })`。

**交互闭环（依赖 `forward`）**：

```
渲染层 mousemove → 组件 hover 判定 → pet:reportHover
  → PetWindowManager.reportHover()          (:381-390)
  → hoveringComponents 集合增删
  → applyMouseIgnoreState()                 (:409-425)
      uiHover || bodyHover ? setIgnoreMouseEvents(false)
                           : setIgnoreMouseEvents(true, { forward: true })
```

**关键因果**：窗口处于「忽略鼠标」时，渲染层之所以还能收到 `mousemove` 并判定 hover，**完全依赖 `forward: true`**。Linux 下 `forward` 不生效 → 一旦忽略就收不到任何事件 → `hoveringComponents` 永远为空 → 始终走 `else` 分支 → **宠物永久穿透，既点不动也拖不动**。这不是体验降级，是功能完全失效。

**两条退路均已被否决**：

| 方案 | 结论 |
|------|------|
| `setShape()` 裁出可交互区域 | **不可用**。代码已明确弃用（`:207` 注释「会裁剪绘制区域导致 Live2D 不可见」，`:392-406` `updateClickRegion` 已改为 no-op） |
| Linux 下始终不穿透 | **不可接受**。宠物窗覆盖全部工作区，不穿透会让整个桌面无法点击 |

**设计方向**：引入穿透策略抽象，两个实现共用既有的 `applyMouseIgnoreState()` 判定逻辑：

| 实现 | 平台 | 机制 |
|------|------|------|
| `ForwardMouseStrategy` | win32 / darwin | 保持现状（`forward: true` + 渲染层 hover 上报） |
| `PollingHitTestStrategy` | linux | 主进程按 ~60ms 轮询 `screen.getCursorScreenPoint()`，对渲染层上报的「可交互区域矩形」做命中测试，直接计算 `hoveringComponents` |

**可行性依据**：`isCursorInReservedArea()`（`:155-167`）已在主进程用 `screen.getCursorScreenPoint()` 做判定 → 主进程轮询光标已被验证可行，本设计只是把它从「次保险」提升为「主机制」。

**设计要点**：
1. 新增 `pet:set-interactive-regions` 通道，渲染层上报 `componentId → 矩形`（客户区 CSS px，≤3 个），主进程换算为屏幕 DIP；
2. 区域随模型加载 / 待机动作（250ms 采样）/ 布局变化更新；
3. 光标未移动时提前返回，跳过命中测试与 `setIgnoreMouseEvents` 调用（后者是窗口系统调用，有实际开销）；
4. 仅在宠物模式且窗口可见时轮询，`timer.unref()` 避免阻塞退出；
5. **已知取舍**：`live2d-model` 用包围盒近似，包围盒内但模型透明的区域会吞掉点击。缓解手段是极小 padding（4px），必要时可升级为「主进程粗筛 + 向渲染层请求精确 alpha 命中」。

**X11 / Wayland 策略**：首版强制 `--ozone-platform=x11`（Ubuntu 默认带 XWayland），提供 `LUMII_OZONE_PLATFORM` 逃生口。

| 能力 | X11 / XWayland | Wayland 原生 |
|------|----------------|-------------|
| 透明无边框窗 | 需合成器，常规可用 | 可用 |
| 全局置顶 | `_NET_WM_STATE_ABOVE` 生效 | 合成器可忽略 |
| 任意屏幕坐标定位 | 支持 | **协议不提供** |
| `screen.getCursorScreenPoint()` | 支持 | **协议受限** |
| 跨工作区可见 | `_NET_WM_DESKTOP` sticky | 不支持 |

→ Wayland 原生会话下核心机制与形态都不成立，**宠物模式需屏蔽入口**并提示用户登录时选择「Ubuntu on Xorg」。

### 5.4 P1：桌面集成（托盘 / 通知 / 自启）

| 项 | 位置 | 现状 | 处置 |
|----|------|------|------|
| 托盘创建 | `tray-manager.ts` | Electron 在 Linux 走 StatusNotifierItem，需 `libayatana-appindicator3-1` + Shell 支持 | **创建必须 try/catch**，失败仅 warn，不影响启动；GNOME 默认无托盘 → **不把托盘作为唯一入口**，主窗口保留「退出/切换模式」 |
| 托盘气泡 | `tray-manager.ts:214-225` | `displayBalloon` 是 Windows 专属 | 加 win32 守卫，非 Windows no-op |
| 窗口闪烁 | `tray-manager.ts:230-239` | `flashFrame` | X11 映射为 urgency hint 可用；Wayland 无效；包 try/catch |
| 托盘点击 | `tray-manager.ts:66-91` | 按 Windows 16px 处理 | Linux 用 22/24px；`tray.on('click')` 在部分 Shell 不可靠 → **菜单必须自足** |
| 系统通知 | `desktop-notify.ts` | Electron `Notification` 主路径 + 托盘气球回退 | 主路径在 Linux 可用（libnotify/DBus）；回退加平台守卫；建议 `app.setDesktopName('lumii.desktop')` 使通知归属显示为「灵栖 Lumii」 |
| 开机自启 | `ipc/api-ipc.ts:239-257` | `app.setLoginItemSettings`（**Linux 无实现**） | 改走 `~/.config/autostart/lumii.desktop`；**AppImage 场景必须用 `process.env.APPIMAGE`**（`process.execPath` 指向挂载点内临时路径，重启后失效）；`--startup-launched` 参数语义与 Windows 一致，`index.ts:1192` 的检测逻辑无需改动 |

### 5.5 P2：运行时与功能对等

**① Python 运行时**

现状：`python-env.ts:41-54` 下载 `python-3.11.9-embed-amd64.zip`、期望 `python.exe`、用 `powershell Expand-Archive` 解压（`:294-324`）；`:39` 钉版 `onnxruntime==1.20.1`（为规避 Win10 `LoadLibrary` 1114）。安装目录 `~/.lumii/runtimes/python-embed`。

处置：Linux 改为**系统 `python3`（≥3.10）+ venv**（`~/.lumii/runtimes/python-venv`），缺失时提示 `sudo apt install python3 python3-venv python3-pip`；`onnxruntime` 钉版改为仅 win32 生效；`runtime-env.ts:141-165` 的 shim 指向 venv，运行时缺失则**不生成 shim**（避免误导），改由 `getScriptRuntimeStatus()` 暴露状态。

备选（首版不采用）：python-build-standalone（+60MB，但不依赖系统包）。

影响面：MemPalace 插件（`ipc/plugin-ipc.ts:174,182`）、Python 技能（`python-runner.ts`）、Qwen3 TTS sidecar（`voice/qwen3-tts-client.ts:79-86`）、ModelScope 下载器。

**② 语音**

| 组件 | 平台耦合 | 处置 |
|------|---------|------|
| sherpa-onnx 加载 | `require('sherpa-onnx-node')`，其 loader 按 `sherpa-onnx-${platform}-${arch}` 找包（`addon.js:8-22`） | 补 `sherpa-onnx-linux-x64`（lockfile 已有该条目）；**需实测 asar 打包下 `.so` 能否被找到**，必要时设 `LD_LIBRARY_PATH` |
| 模型下载 | 平台无关（ModelScope / hf-mirror / GitHub 代理） | 保留 |
| PyTorch | `model-manager.ts:98-99` 硬编码 `torch-2.5.1+cu121-cp311-cp311-win_amd64.whl` | 换 `linux_x86_64` wheel；首版建议 CPU 版（~800MB，无 CUDA 依赖），GPU 作为显式开关并校验 `nvidia-smi` |
| tar 解压 | `model-manager.ts:1129` win32 用 `C:\Windows\System32\tar.exe`，否则 `tar` | 已有分支 ✓ |
| Edge TTS | `msedge-tts`，网络服务 | 平台无关 ✓ |
| SILK 解码 | WASM（`channel/media-pipeline.ts:92`） | 平台无关 ✓ |

**必须保证「至少一条 TTS 链路可用」**：本地 sherpa(MeloTTS) → 在线 Edge → 语音克隆，逐级回退，否则语音回复完全失效。

**③ ffmpeg 与屏幕录制**

| 能力 | Windows | Linux |
|------|---------|-------|
| ffmpeg 解析 | `ffmpeg-runner.ts:24` | 建议三级解析：extraResources 内置 → `@ffmpeg-installer` → 系统 `ffmpeg`（deb `recommends: ffmpeg`） |
| 窗口捕获开关 | `index.ts:1127-1132` WGC（可捕获被遮挡窗口） | 该开关不需要；X11 下 `desktopCapturer` 走 XComposite |
| 捕获源 | `real-deps.ts:87-114` | 相同 API；X11 下 `window` 源可用 |
| **系统音频回环** | WASAPI loopback | **不支持**。需要虚拟 sink + monitor source，复杂度与稳定性都不适合自动化 → **屏蔽该开关** |
| 磁盘空间 | PowerShell | 已有 `fs.statfs` 分支 ✓ |
| 烧录字体 | `narrate-service.ts:52-57` 硬编码 `C:\Windows\Fonts\msyh.ttc` | 优先 `fc-match -f '%{file}' "Noto Sans CJK SC"`，候选列表兜底；deb `depends` 加 `fonts-noto-cjk` |
| ffmpeg 路径转义 | `narrate-service.ts:43-44,69` 假定盘符 `:` 与反斜杠 | Linux 仅需转义 `\`、`'`、`[`、`]` |

**④ Coding CLI 与 uv**

| 项 | 现状 | 处置 |
|----|------|------|
| 安装配方 | `coding-dev-cli-install.ts:81-99` `irm ... \| iex` | Linux 用 `curl -fsSL ... \| sh`；执行改走 `ShellRunner` 而非直接 `spawn('powershell.exe', ...)`（`:213-220`） |
| 自动模式守卫 | `:281,376,442` 非 win32 只给手动指引 | 放开 Linux 自动安装 |
| 卸载 | `:147-176` `Remove-Item $env:USERPROFILE\...` | Linux 用 `rm -f` 或官方卸载脚本 |
| 检测 | `coding-dev-cli-detect.ts:179-189` | 候选路径平台化；**直接检查文件存在而非依赖 PATH**（应用菜单启动时 PATH 常不含 `~/.local/bin`） |
| uv | `uv-installer.ts:133-139` **直接拒绝非 Windows** | 增加 `curl -LsSf https://astral.sh/uv/install.sh \| sh`；保持「用户确认后才安装」 |

**⑤ 浏览器控制**：这是本仓库跨平台做得最好的模块——Linux/macOS 探测（`chrome.executables.ts:217-227,574-591,686-695`）、unix 端口检查（`ports-inspect.ts:64,85,199`）、非 win32 进程清理（`server-context.ts:519-548`）、CloakBrowser 三平台资源矩阵（`cloak-browser-downloader.ts:233-243`）均已实现。剩余工作仅是验证与两处小改（`vendor/ports-inspect.ts` 在 Linux 改调包版本；确认 CloakBrowser 解压后的 `chrome` 具备可执行权限）。

### 5.6 P3：发行与打磨

| 项 | 分析与处置 |
|----|-----------|
| 自动更新 | `updater-service.ts` 用 `electron-updater`，**无平台守卫**。AppImage 支持自动更新（需 `APPIMAGE` 环境变量 + `latest-linux.yml`，由 electron-builder 自动产出）；**deb 不支持** → 仅提示 + 打开下载页。不建议应用内 `pkexec dpkg -i`（提权执行下载内容有安全风险） |
| desktop 集成 | `.desktop` 与图标由 electron-builder 从 `linux.desktop` 配置自动生成。`Name` 含中文在 deb 中合法，若排序/搜索异常改用 `Name=lumii` + `Name[zh_CN]=灵栖 Lumii` |
| deb 元数据 | 包名需小写 `lumii`；`depends` 只列 22.04/24.04 都存在的包（`libasound2` 在 24.04 更名 `libasound2t64`，故不列）；`libayatana-appindicator3-1` 与 `ffmpeg` 放 `recommends`（缺失不阻塞安装） |
| 卸载清理 | 自动启的 `~/.config/autostart/lumii.desktop` 需 deb 的 `prerm`/`postrm` 删除；`~/.lumii/` 用户数据**保留**（与 `deleteAppDataOnUninstall: false` 语义一致） |
| **平台文案** | `runtime-section.ts:31-38` 在 `channel === 'windows-agent-runtime'` 或 host 匹配 `/MtBot Windows/i` 时，向模型注入「You are running inside the **MtBot Windows desktop client**」——**Linux 上会向模型谎报平台**，且品牌名仍是旧的 MtBot。应改为按 `params.osInfo`（已由 `bridge-instance-factory.ts:624` 传入 `${process.platform} ${process.arch}`）动态拼接 |
| 命名 | 建议**保留** `apps/windows` 与 `lumii-windows`：改名会波及 workspace filter、lockfile、`AGENTS.md` 命令示例、所有文档路径，收益仅为语义。若改，应作为独立的机械提交 |
| CI | 仓库**当前无任何 CI**（无 `.github/`、`.gitlab-ci.yml`、`Jenkinsfile`）。建议在 `ubuntu-22.04` 上构建（glibc 2.35，向后兼容 24.04） |

---

## 6. 无头形态专项分析

### 6.1 有利基础（超出预期）

| 基础 | 证据 | 意义 |
|------|------|------|
| **agent-runtime 零 Electron 依赖** | grep `packages/agent-runtime/src` 中 `from 'electron'` / `require('electron')` → **零命中** | 核心 Agent 逻辑可脱离 Electron 运行，无头化不需要重写业务层 |
| **控制面已是 HTTP** | `app-ui-control/server.ts:2,42,561,591,595` — `127.0.0.1` + Bearer token + `http.createServer` | 交互入口与 GUI 解耦，无头模式天然可用 |
| **CLI 已存在且零依赖** | `resources/app-ui-cli/lumii-ui.mjs`，读取 `~/.lumii/runtime/app-ui.json` 获取 port/token | 无头模式的主要人机入口**已经写好**，无需新造 |
| **CLI 命令覆盖面广** | `app-ui-cli/commands.mjs` 已注册 45+ 命令 | 见 §6.5 |
| 通道设计 | `index.ts:1542-1545` `window-all-closed` **不退出应用**（托盘驻留模型） | 与无头「无窗口长期驻留」的模型天然一致 |

### 6.2 无头必须绕开的组件

| 组件 | 位置 | 无窗口时的行为 |
|------|------|---------------|
| 主窗口创建 | `index.ts:1535` `void createWindow()`、`window/main-window.ts:77` | 需跳过 |
| 桌面宠物 | `pet/pet-window-manager.ts`（依赖 `screen` 模块与透明窗） | 需屏蔽 |
| 托盘 | `tray-manager.ts` | 需屏蔽 |
| 系统通知 | `desktop-notify.ts`（`getMainWindow` / `flashUnfocusedFrame`） | 需降级为日志 + 渠道推送 |
| 录屏 | `screen-record/*`（依赖 `desktopCapturer`） | 需屏蔽 |
| 剪贴板文件 | `ipc/dialog-clipboard-ipc.ts` | 需屏蔽 |
| **扫码登录二维码** | `index.ts:1505` `mainWindow?.webContents.send('qbot:qrcode', dataUrl)`；微信/企微同类 | **静默丢失 → 无法登录渠道**（见 §6.4） |

### 6.3 显示服务器：两条路线

| | 路线 A：`xvfb-run` 包裹 Electron | 路线 B：纯 Node 化（去 Electron） |
|---|---|---|
| 做法 | 保留完整主进程，仅跳过窗口创建；用虚拟显示满足 GTK 初始化 | 以 `ELECTRON_RUN_AS_NODE=1` 或独立入口启动，不使用任何 Electron API |
| 改动量 | **小**（启动分叉 + 屏蔽列表） | **大**（需替换 `app`/`ipcMain`/`safeStorage`/`protocol`/`Notification` 等所有 Electron API 调用点） |
| 依赖 | 需安装 `xvfb` | 无 |
| 资源占用 | Electron 全家桶（含 GPU 进程）常驻 | 仅 Node 进程 |
| 适用 | 有 X11 库的常规服务器 | 最小容器镜像、资源受限环境 |
| 风险 | 无显示时 Electron 启动失败（`Missing X server or $DISPLAY`） | agent-runtime 虽零 Electron 依赖，但主进程装配层（`index.ts` 约 1500 行）重度依赖 Electron |

**建议**：首版走**路线 A**，理由是改动可控且复用全部现有服务装配逻辑；路线 B 作为后续优化项（其可行性已由「agent-runtime 零 Electron 依赖」这一事实支撑）。

### 6.4 无头下的具体缺口

| 缺口 | 说明 | 可能的方向 |
|------|------|-----------|
| **扫码登录无出口** | 微信/QQ/企微登录二维码当前只发往渲染进程 | 复用已是传递依赖的 `qrcode-terminal`（现被 stub，见 `main/stubs/qrcode-terminal.ts`）打印到终端；或经 HTTP 返回二维码，由 `lumii-ui` 渲染为 ASCII/图片 |
| 依赖 `mainWindow` 的代码路径 | 大量 `mainWindow?.webContents.send(...)` 散落（如 `index.ts:1505-1509`） | `?.` 已保证不崩溃，但需系统排查「静默不生效」的功能点，转为 CLI/日志出口 |
| UI 控制类命令失效 | `lumii-ui` 的 `screenshot` / `goto` / `click` / `act` / `pet mode` 依赖渲染进程 | 无头下在 CLI 层直接报「当前无界面」并返回非零退出码 |
| 首启动配置 | 模型/渠道/技能的初始配置依赖设置页 | 已由 `settings set` / `model set` / `skill enable` 等 CLI 命令覆盖 ✓ |
| 开机自启语义 | 桌面用 XDG autostart，无头应是 **systemd user service** | 平台/形态分派 |

### 6.5 保留能力清单

**无头可用（CLI 已覆盖，45+ 命令，节选）**：`settings get/set`、`model set`、`tools list/toggle`、`cron list/run`、`skill list/enable/disable`、`memory list/search/stats/provenance/archive-cold/unarchive/rebuild-index`、`wiki inbox/*`、`wiki folder/*`、`wiki search`、`wiki search hybrid`、`wiki graph`、`wiki export`、`context usage`、`context compact`。

**无头不可用（依赖渲染进程或显示）**：`screenshot`、`goto`、`click`、`act`、`pet mode`、`pet modes`。

**无头天然可用（不依赖 GUI）**：Agent 对话与工具调用、记忆/Wiki 全链路、渠道收发（微信/QQ/飞书/企微，**无头下这是主要入口**）、定时任务与心跳、自主进化、Markdown 技能、浏览器控制（Chrome headless 本身可用）、Python 技能（依赖系统 Python）。

### 6.6 部署形态建议

- `deb` 安装 + **systemd user service**（`~/.config/systemd/user/lumii.service`，`WantedBy=default.target`），配合 `loginctl enable-linger` 实现注销后仍运行；
- 日志沿用 `~/.lumii/logs/`（`file-logger.ts` 已实现文件日志，与是否有窗口无关）；
- 数据目录仍为 `~/.lumii`，可用 `LUMII_CLIENT_DATA_DIR` 覆盖；
- 容器场景需 `xvfb`（路线 A）或等待路线 B。

---

## 7. 功能处置矩阵

> 三档处置：**保留**（功能完整）/ **降级**（可用但明确弱于 Windows）/ **屏蔽**（入口关闭 + 文案说明，禁止静默失败）。

| 功能 | 桌面（X11） | 桌面（Wayland） | 无头 | 处置 |
|------|------------|----------------|------|------|
| 主对话 / Agent / 工具 | ✅ | ✅ | ✅ | 保留 |
| 记忆 / Wiki / 知识库 | ✅ | ✅ | ✅ | 保留 |
| 渠道（微信/QQ/飞书/企微） | ✅ | ✅ | ✅（需补扫码出口） | 保留 |
| 定时任务 / 心跳 / 自主进化 | ✅ | ✅ | ✅ | 保留 |
| Markdown 技能 | ✅ | ✅ | ✅ | 保留 |
| Python 技能 / MemPalace | ⚠️ 依赖系统 Python | ⚠️ | ⚠️ | 保留，缺失时**屏蔽入口**并给 apt 提示 |
| 浏览器控制 / 反检测浏览器 | ✅ | ✅ | ✅ | 保留 |
| 桌宠模式 | ✅（交互需重写） | ❌ | ❌ | X11 保留；Wayland/无头**屏蔽入口** |
| 托盘 | ⚠️ 依赖 AppIndicator | ⚠️ | ❌ | 创建失败即不创建，主窗口/CLI 保留入口 |
| 系统通知 | ✅ | ✅ | ❌ | 无头降级为日志 + 渠道推送 |
| 录屏（屏幕+麦克风） | ✅ | ⚠️ | ❌ | X11 保留；无头屏蔽 |
| 录屏系统音频 | ❌ | ❌ | ❌ | **屏蔽开关** + 替代方案说明 |
| 开机自启 | ✅ XDG | ✅ XDG | ✅ systemd | 按形态分派 |
| 自动更新 | ✅ AppImage | ✅ | ⚠️ | deb 仅提示；无头建议手动/CI |
| 剪贴板文件复制 | ⚠️ 仅路径文本 | ⚠️ | ❌ | 降级并提示 |
| `.ps1/.bat/.cmd` 技能脚本 | ❌ | ❌ | ❌ | 执行时明确报错 + 提示改用 `.sh` |
| 微信/QQ 扫码登录 | ✅ | ✅ | ❌（待补） | 桌面保留；无头需补终端出口 |

---

## 8. 改动清点（汇总，按优先级）

> 本节只列出「需要改什么」，不含实施。

### P0 · 打包与构建链路

| 文件 | 改动 |
|------|------|
| `apps/windows/electron-builder.json` | 新增 `linux`（AppImage+deb，x64，`icon` 512px PNG）与 `deb`（`depends`/`recommends`）段；`files`/`asarUnpack` 并列追加 linux 平台包；`silk-sdk` → `silk-wasm` |
| `apps/windows/scripts/package-windows.js` | 重命名为 `package-app.js`，新增 `--platform`；平台化 `stepVerify`、`killLockedAppProcesses`、EPERM 重试、产物扩展名过滤 |
| `apps/windows/scripts/generate-icon.cjs` | 追加输出 512px PNG |
| `apps/windows/package.json` | 脚本重命名 + 新增 `package:linux`；`@img/sharp-win32-x64` 移入 optionalDependencies；补 linux 平台包 |
| `package.json`（根） | `dist` 平台化 + 新增 `dist:linux` |
| `scripts/package-win.ps1`、`apps/windows/scripts/build.ps1` | 调用点更新 |

### P1 · 平台抽象层

| 文件 | 改动 |
|------|------|
| `src/main/platform/*`（新增 6 文件 + 测试） | §5.2 的模块划分 |
| `shell-runner.ts` | 删本地 `forceKillProcess`；改 `spawnChildInGroup` / `buildSafeShellEnv`；`.bat/.cmd` 非 win32 明确报错 |
| `python-runner.ts`、`ts-runner.ts`、`local-bash.ts` | 同上 |
| `browser-service.ts`、`system-service.ts:776-790` | 改调 `killPidTree` |
| `system-service.ts:683-771` | 拆为 `platform/system-info.ts` |
| `security-utils.ts:38-68,102,289-296` | 策略按平台返回；长度/深度从策略读取 |
| `paths.ts` / `client-data-root.ts` | 合并重复实现 |
| `runtime-env.ts:95-133,175-232` | **修复 `Path` 键名**；`.cmd` 写入条件；Python 来源 |
| `cli-user-path.ts`、`coding-dev-cli-detect.ts` | 追加 Linux 候选路径 |
| `vendor/ports-inspect.ts` | Linux 改调包版本 |
| `ipc/dialog-clipboard-ipc.ts:61-87` | Linux 分支明确化 |

### P1 · 桌宠与桌面集成

| 文件 | 改动 |
|------|------|
| `src/main/pet/pointer-strategy.ts`（新增） | `PetPointerStrategy` + `ForwardMouseStrategy` + `PollingHitTestStrategy` |
| `pet/pet-window-manager.ts` | 策略化；`:209` 改 `strategy.start()`；`applyMouseIgnoreState` 抽为共享 |
| `shared/pet-mode.ts`、`pet/pet-mode-ipc.ts`、`src/preload/` | 新增 `InteractiveRegion` 类型与 `pet:set-interactive-regions` 通道（按 `AGENTS.md:11` 同步三层） |
| `src/renderer/pet/**` | 上报可交互区域包围盒 |
| `src/main/index.ts` | `--ozone-platform` 决策；Wayland 降级标志 |
| `tray-manager.ts`、`desktop-notify.ts` | 平台守卫；托盘创建 try/catch；`setDesktopName` |
| `ipc/api-ipc.ts:239-257` | 自启改调 `platform/autostart.ts` |

### P1' · 无头启动路径

| 文件 | 改动 |
|------|------|
| `src/main/index.ts:1139-1160,1535` | 新增 `--headless` 启动分叉：`whenReady` 后初始化服务但跳过窗口/托盘/宠物 |
| `main-window.ts` / `pet-window-manager.ts` / `tray-manager.ts` / `screen-record/*` | 无头模式下不加载 |
| `desktop-notify.ts` | 无窗口时降级为日志 + 渠道推送 |
| 渠道登录服务 | 二维码增加终端/HTTP 出口（当前仅 `webContents.send`） |
| `app-ui-control/commands.mjs` + `lumii-ui.mjs` | UI 类命令在无头下明确报错并返回非零退出码 |
| 新增 | systemd user service 模板 + `loginctl enable-linger` 说明 |

### P2 · 运行时与功能对等

| 文件 | 改动 |
|------|------|
| `python-env.ts`、`python-runner.ts`、`runtime-env.ts` | 系统 Python + venv；shim 指向 venv；缺失时不生成 shim |
| `voice/model-manager.ts:98-99` | Torch wheel 平台化 + CPU/GPU 开关 |
| `voice/asr-engine.ts` 等 4 处 | 验证 asar 下 `.so` 加载 |
| `screen-record/ffmpeg-runner.ts:22-30` | 三级 ffmpeg 解析 |
| `screen-record/narrate-service.ts:43-57,69` | `fc-match` + 平台候选字体；转义按平台 |
| `screen-record/screen-record-service.ts:159,464-468,964` | 系统音频降级 |
| `coding-dev-cli-install.ts` / `-detect.ts` / `-local-runner.ts` | 配方平台化；候选路径；提示文案 |
| `uv-installer.ts:133-139` | 增加 Linux 配方 |

### P3 · 发行与打磨

| 文件 | 改动 |
|------|------|
| `updater-service.ts` | `getUpdateCapability()`：AppImage 自动 / deb 仅提示 |
| `packages/agent-runtime/src/prompt/sections/runtime-section.ts:29-40` | 平台文案按 `osInfo` 动态化；品牌名改回 Lumii |
| `electron-builder.json` + `build-resources/deb-*.sh` | 卸载清理 autostart |
| `pnpm-workspace.yaml:22`、`.npmrc:5`、`apps/windows/package.json:26` | 清理陈旧条目（见 §9） |
| `README.md` / `AGENTS.md` | Linux 与无头部署章节 |
| `.github/workflows/build-linux.yml`（可选） | CI |

---

## 9. 本次调查中发现的存量缺陷

以下问题**在 Windows 上同样存在**，与是否移植无关，属于调查过程的顺带发现。

| # | 缺陷 | 位置 | 影响 | 状态 |
|---|------|------|------|------|
| 1 | `files` 白名单引用不存在的包 `silk-sdk` | `electron-builder.json:21` | 死条目；`silk-wasm` 反而未被列入 | 已确认（包已迁移，commit 5a37adc） |
| 2 | `silk-wasm` 注释与行为矛盾：注释称「必须外部化」，实则写在 `exclude` 中（= 被 Rollup 内联） | `electron.vite.config.ts:193-204` | 其 `silk.wasm` 通过 `new URL('silk.wasm', import.meta.url)` 解析，内联后 wasm 可能未随包分发 → **打包后 SILK 解码可能失效** | **需实测确认** |
| 3 | ffmpeg 平台二进制是否被打包存疑 | `electron-builder.json:11-41`（`files` 无 ffmpeg 条目） | 录屏/字幕可能缺 ffmpeg | 对 2026-09-02 旧产物检查发现 `@ffmpeg-installer/win32-x64` 缺失，但该产物早于 silk 迁移，**需重新构建确认** |
| 4 | PATH 键名大小写 | `runtime-env.ts:181-186` 复用 `Path` 键 | Linux 下 shim 目录不进 PATH | 已确认 |
| 5 | 数据根两套重复实现 | `paths.ts:39-65` 与 `client-data-root.ts:39-52` | 维护成本、缓存不一致风险 | 已确认 |
| 6 | `@lydell/node-pty` 在 allow-list 中但 lockfile 无此包 | `pnpm-workspace.yaml:22`、`.npmrc:5` | 陈旧条目 | **已核实：lockfile 中 0 处引用** |
| 7 | `package:portable` 指向不存在的脚本 | `apps/windows/package.json:26` → `scripts/package-portable.js` | 命令必然失败 | **已核实：该文件未被 git 跟踪** |
| 8 | 提示词向模型谎报平台 | `runtime-section.ts:31-38` | 影响模型对工具/路径语义的判断；品牌名仍为旧名 MtBot | 已确认 |

---

## 10. 验证方式

| 层级 | 手段 | 覆盖 |
|------|------|------|
| 单元测试 | Vitest | 平台分支纯函数：`killProcessTree` 命令构造、`resolveShell` 分派、安全策略、路径换算、命中测试（边界/padding/负坐标） |
| 回归门禁 | `pnpm typecheck && pnpm --filter ./apps/windows test:all` | **Windows 侧零回归**（移植期的主门禁） |
| 打包冒烟 | 手动 checklist | `release/linux-unpacked/resources/app.asar.unpacked/node_modules/` 含 linux 平台包；启动无 `Cannot find module` |
| 端到端 | Playwright（现有 `test:e2e`） | 主窗口对话链路；桌宠为人工验证（Playwright 无法驱动透明穿透窗） |
| 无头冒烟 | `xvfb-run` + `lumii-ui` 命令 | `settings get` / `memory stats` / `cron list` 返回成功；渠道收发可用 |
| 人工验收 | §功能处置矩阵逐项 | 见下方清单 |

**人工验收清单**：

```
桌面形态
□ AppImage 双击启动；deb 安装后菜单项与图标正常
□ 完成一轮对话（含工具调用）
□ 宠物模式：可见、可点、可拖、穿透正常，桌面图标不被误吞
□ 托盘菜单：切换模式、退出
□ 桌面通知点击回到主窗口
□ 开机自启：注销重登生效
□ 语音：录音 → 转写 → TTS 回复；至少一条 TTS 链路可用
□ 录屏 30s（屏幕 + 麦克风），中文字幕烧录正常，含空格/中文/引号路径
□ 卸载 deb：应用文件清除、~/.lumii 保留、autostart 文件清除
无头形态
□ xvfb-run 启动，进程常驻，日志正常写入 ~/.lumii/logs
□ lumii-ui 非 UI 类命令全部可用；UI 类命令返回明确错误并退出码非零
□ 渠道收发：从微信发消息 → Agent 回复
□ 定时任务触发并推送
□ systemd user service 重启/自愈
```

---

## 11. 风险与未验证假设

| 类型 | 内容 | 应对 |
|------|------|------|
| **未验证假设** | `sherpa-onnx-linux-x64` 在 asar 打包下能否被 loader 找到 `.so` | M0 优先实测；备选：平台包放 `extraResources` + `LD_LIBRARY_PATH` |
| **未验证假设** | `screen.getCursorScreenPoint()` 在 XWayland 下是否可靠返回全局坐标 | M0 实测；异常则回退「仅在鼠标按下时短暂解除穿透」的保守策略 |
| **未验证假设** | X11 分数缩放（125%/150%）下 CSS px 与 DIP 的换算偏差 | padding 吸收；必要时用 `getDisplayNearestPoint().scaleFactor` 校正 |
| **未验证假设** | 合成器缺失时透明窗是否黑底 | 首次进入宠物模式后 3s 自检并提示 |
| 技术风险 | POSIX `detached: true` 改变子进程生命周期 | 退出钩子统一清理；长时任务显式管理 |
| 技术风险 | 轮询方案在低性能机器上的 CPU 开销 | 光标静止提前返回；间隔可放宽至 80ms |
| 技术风险 | 包围盒近似吞掉桌面点击 | 极小 padding；保留精确命中的升级路径 |
| 环境风险 | `deb` 依赖在 22.04/24.04 间包名差异 | 只列两版都存在的；其余交 AppImage 兜底 |
| 环境风险 | AppImage 在无 FUSE 环境无法运行 | 文档提示 `--appimage-extract-and-run`；deb 作主推渠道 |
| 时间风险 | Python/Torch 体积大（CPU 版 ~800MB） | 分步下载 + 断点续传；UI 显示体积 |
| 流程风险 | 无头模式的扫码登录改造涉及渠道登录服务内部 | 单独评估，不阻塞桌面形态交付 |

---

## 12. 待确认项

1. **Wayland 接受度**：是否接受首版仅 X11 / XWayland（Ubuntu 24.04 默认走 Wayland，用户需在登录界面切换，或由应用强制 XWayland）？
2. **无头路线的选择**：首版走「`xvfb-run` + 跳窗口」（改动小）还是直接投入「纯 Node 化」（资源占用低但工作量大）？
3. **无头扫码登录出口的形式**：终端 ASCII 二维码（复用已有的 `qrcode-terminal` 传递依赖）还是经 HTTP 返回给 `lumii-ui` 渲染？
4. **首版 TTS 默认**：默认下载 CPU 版 Torch（+800MB，支持语音克隆），还是默认 MeloTTS、把语音克隆作为按需下载的高级选项？
5. **CI 是否引入**：仓库当前无 CI，新增涉及仓库设置与密钥。
6. **主推分发渠道**：AppImage（可自动更新）还是 deb（系统集成好、更新靠手动）？
7. 上一轮已提出但尚未确认的两项：功能降级范围（现已改为「屏蔽」策略，见 §7）、`apps/windows` 是否改名。
