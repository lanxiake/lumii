# CLI-Hub 外部软件接入 — 设计

> 日期：2026-08-15  
> 状态：已落地（轻量技能包）  
> 相关：`docs/design/2026-08-13-agent-app-ui-control-design.md` §8.4、[HKUDS/CLI-Anything](https://github.com/HKUDS/CLI-Anything)

---

## 1. 结论

| 问题 | 结论 |
|------|------|
| 是否用 CLI-Anything 生成 Lumii 自己的 `lumii-ui` | **否**。自控 UI 仍走进程内 `app_*` / 二期 `lumii-ui` 控制口。 |
| 是否接入 CLI-Hub 控外部软件 | **是**。以 **bundled 指令型技能** 接入，不新增一等工具、不做设置页。 |
| Agent 怎么用 | `skill_invoke cli-hub` → 按文档用 `bash` 执行 `pip` / `cli-hub` / `cli-anything-* --json`。 |

## 2. 架构

```
用户：「用 GIMP 处理这张图」
  → skill_invoke(cli-hub)
  → bash: python -m pip install -U cli-anything-hub   （若未装，需用户确认）
  → bash: cli-hub search/install gimp --json
  → bash: cli-anything-gimp ... --json
  → 用产物路径 / 输出验收
```

不改 Agent 工具表；复用现有：

- `bash` + 权限确认（`local-bash.ts` → `buildScriptEnv()`）
- 内置 / 系统 Python（`runtime-env` / `python-env`）
- `skill_list` / `skill_search` / `skill_invoke`

## 3. 落地清单

| 项 | 路径 |
|----|------|
| 内置技能 | `apps/windows/bundled-skills/技能管理/cli-hub/SKILL.md` |
| 关闭 Hub 匿名统计 | `buildScriptEnv()` 默认 `CLI_HUB_NO_ANALYTICS=1`（可覆盖） |
| 与 app-ui 分界 | 设计文档 §8.4 已改写 |

## 4. 明确不做（YAGNI）

- `cli_hub_list` / `cli_hub_install` 等一等工具
- 设置页浏览/安装 harness
- 自动安装第三方 GUI 宿主（GIMP 等）
- 用 CLI-Anything 七阶段流水线生成 `lumii-ui`

## 5. 验收

1. 新装/播种后 `skill_search` / 技能列表能看到 `cli-hub`。
2. Agent 按技能文档安装 hub 后，`cli-hub list --json` 有结构化输出。
3. `bash` 子进程 env 含 `CLI_HUB_NO_ANALYTICS=1`（单测覆盖）。
4. 询问「打开 Lumii 设置」时仍走 `app_goto`，不走 cli-hub。

## 6. 后续（可选）

- 设置页管理已装 harness（原方案 3）
- 白名单常用类别预装提示
- `execute_skill` 接线后可为可执行包装薄壳（非必须）
