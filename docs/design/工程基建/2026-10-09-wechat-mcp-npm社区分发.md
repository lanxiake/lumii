# wechat-mcp · npm 社区分发（设计说明）

> **状态**：已确认（2026-10-09）  
> **关联计划**：[`docs/plans/渠道与CLI/2026-10-07-微信MCP设计改进计划.md`](../../plans/渠道与CLI/2026-10-07-微信MCP设计改进计划.md)  
> **操作手册（正本）**：[`apps/windows/resources/wechat-mcp/PUBLISHING.md`](../../../apps/windows/resources/wechat-mcp/PUBLISHING.md)

## 目标

把 **wechat-local MCP** 从灵栖 monorepo 中拆成可独立消费的 npm 产物，让 Cursor / Claude Desktop 等 **stdio MCP 客户端**在不安装 Lumii 的情况下持续获得更新（`npx @lumii/wechat-mcp`）。

## 架构要点

- **双包**：主包只含 Node 启动器；平台包 `win32-x64` 含 PyInstaller exe（与灵栖内置 exe 同源构建脚本）。
- **版本单源**：`server.py` → `SERVER_VERSION` → npm version + exe `--version`。
- **构建链**：`build-wechat-mcp.mjs` → `pack-wechat-mcp-npm.mjs` →（可选）GitHub Actions `publish-wechat-mcp.yml`。
- **边界**：npm 分发 **MCP 工具**；灵栖 **pcwechat 渠道 / 盯梢 / 代聊 Agent** 仍在 App 内，不在 npm 范围。

## 维护者

发版步骤、Secrets、验证命令见 **PUBLISHING.md**（避免在本文件重复维护两套流程）。
