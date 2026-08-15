---
name: cli-hub
description: |
  Discover, install, and run CLI-Anything harnesses via CLI-Hub to control external
  desktop software (GIMP, Blender, LibreOffice, Inkscape, etc.) from the terminal.
  Use when: (1) User wants to operate third-party GUI apps via CLI,
  (2) Mentions cli-hub / CLI-Anything / cli-anything-*,
  (3) Needs agent-native control of image/3D/office/video tools that are not Lumii itself.
  NOT for: controlling Lumii's own windows (use app_screenshot / app_goto / app_act),
  or external web pages (use browser_*).
metadata:
  {
    "mtbot":
      {
        "emoji": "🧰",
        "requires": { "anyBins": ["python3", "python"] },
        "install":
          [
            {
              "id": "pip-hub",
              "kind": "shell",
              "command": "python -m pip install -U cli-anything-hub",
              "bins": ["cli-hub"],
              "label": "Install CLI-Hub package manager via pip",
            },
          ],
      },
  }
---

# CLI-Hub（外部软件 Agent CLI）

通过 [CLI-Anything](https://github.com/HKUDS/CLI-Anything) 的包管理器 `cli-hub`，为第三方 GUI 软件安装可脚本化的 CLI harness，再用 `--json` 交给 Agent 解析。

官网目录：https://clianything.cc/

## 能力边界（必守）

| 对象 | 用法 |
|------|------|
| **第三方桌面软件**（GIMP / Blender / LibreOffice…） | 本技能：`cli-hub` + `cli-anything-*` |
| **Lumii 自己的窗口** | `app_screenshot` / `app_goto` / `app_act`（禁止用本技能或 `bash lumii-ui` 顶替） |
| **外部网页** | `browser_*` |

安装 harness **不会**自动安装对应 GUI 软件；多数 harness 仍依赖本机已安装的真实应用。

## 前置：安装 CLI-Hub

```bash
python -m pip install -U cli-anything-hub
cli-hub --help
```

环境已默认关闭匿名统计（`CLI_HUB_NO_ANALYTICS=1`）。若需自行覆盖，可在命令前取消该变量。

## 标准工作流

### 1. 发现

```bash
cli-hub list --json
cli-hub list -c image --json
cli-hub search "blender" --json
cli-hub info gimp
```

### 2. 安装 / 更新 / 卸载

安装前向用户确认目标软件名与用途；`bash` 会触发权限确认。

```bash
cli-hub install gimp
cli-hub update gimp
cli-hub uninstall gimp
```

### 3. 调用 harness（优先 JSON）

安装后命令形如 `cli-anything-<name>`：

```bash
cli-anything-gimp --help
cli-anything-gimp --json project list
# 无子命令时常进入 REPL；Agent 应优先用一次性子命令 + --json，避免交互式 REPL 卡住。
```

预览类 harness（若支持）：

```bash
cli-anything-<name> preview ... --json
cli-hub previews inspect /path/to/bundle-or-session
```

### 4. 验收

- 命令失败时先读 stderr / JSON error，再 `cli-hub info <name>` 查依赖。
- 改文件或导出产物后，用 `ls` / 打开产物路径确认，不要只凭 exit 0 交差。

## 常见坑

1. **只有 harness、没有宿主软件**：需用户自行安装 GIMP/Blender 等；CLI 通常通过 `PATH` 找可执行文件。
2. **REPL 卡住**：不要对 Agent 默认进 REPL；始终带子命令与 `--json`。
3. **Python / pip 找不到**：用 `python -m pip`；Lumii 可能提供内置 Python（shim 在 PATH 末尾）。
4. **与 app_* 混淆**：截 Lumii 界面、点设置/技能页 → 用 `app_*`，不是 cli-hub。

## 快速决策

```
用户要操作外部软件？
  → skill_invoke cli-hub → 发现 → 确认后 install → --json 调用
用户要操作本客户端 UI？
  → app_goto / app_screenshot / app_act
用户要操作网页？
  → browser_*
```
