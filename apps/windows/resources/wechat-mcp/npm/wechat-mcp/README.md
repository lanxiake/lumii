# @lumii/wechat-mcp

本机微信（4.x）的 stdio MCP Server：**Windows x64**，读会话 / 历史 / 检索 / 未读，发消息、发文件、引用回复、群发，蒸馏好友画像。全部本地处理、不外传。**仅用于你自己的账号、你自己的机器。**

## 安装

```json
{
  "mcpServers": {
    "wechat-local": {
      "command": "npx",
      "args": ["-y", "@lumii/wechat-mcp"]
    }
  }
}
```

- 需要 **Node.js ≥ 18**、**微信 4.x 已登录**。
- **国内用户**：`npm config set registry https://registry.npmmirror.com`，或  
  `npx -y --registry=https://registry.npmmirror.com @lumii/wechat-mcp`（详见 [PUBLISHING.md §1.1](https://github.com/lanxiake/lumii/blob/main/apps/windows/resources/wechat-mcp/PUBLISHING.md#11-国内网络镜像源通常不必-vpn)）。
- **离线**：直接配置 `wechat-mcp.exe` 绝对路径，见 [PUBLISHING.md §1.2](https://github.com/lanxiake/lumii/blob/main/apps/windows/resources/wechat-mcp/PUBLISHING.md#12-离线安装不依赖-npm-在线拉包)。
- 二进制由 `@lumii/wechat-mcp-win32-x64` 提供；安装时不要省略 optional 依赖（勿用 `--omit=optional`）。
- 可选环境变量：`LUMII_WECHAT_ACCOUNT`、`LUMII_WECHAT_DB`、`LUMII_WECHAT_DISTILL`。
- 调试：`LUMII_WECHAT_MCP_BINARY` 指向任意 `wechat-mcp.exe`。

## 文档

| 文档 | 内容 |
| --- | --- |
| [完整 README](https://github.com/lanxiake/lumii/blob/main/apps/windows/resources/wechat-mcp/README.md) | 15 个工具、uv/python 安装、安全与隐私 |
| [PUBLISHING.md](https://github.com/lanxiake/lumii/blob/main/apps/windows/resources/wechat-mcp/PUBLISHING.md) | 维护者 npm 发版流程 |
| [优化与代聊说明](https://github.com/lanxiake/lumii/blob/main/docs/wechat-mcp-optimization-plan.md) | 灵栖内 `pcwechat` / 盯梢（非 npm 范围） |

## 版本

`npx @lumii/wechat-mcp --version` 与 MCP `initialize` 里的 `serverInfo.version` 一致，对应源码 `server.py` 的 `SERVER_VERSION`。

发送类工具默认 `dry_run=true`；发送前 fail-closed 校验，失败返回稳定 `error_code`。
