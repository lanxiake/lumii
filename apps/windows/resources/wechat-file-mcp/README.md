# wechat-file-mcp · 微信文件归档

一个 **stdio MCP server**：把本机微信里收发的**文件**列出来、归档到本地目录、报告已过期下不动的文件。

**只读、只拷贝**：读层直读 SQLCipher4（密钥从进程内存**只读**扫描取，不注入、不改微信数据）；
归档只把 `msg/file/<月>/` 里的文件**复制**到用户目录，微信原文件原地不动。

> ⚠️ 仅用于**你自己的账号、你自己的机器**。文件涉及他人隐私——全部**本地处理、不外传**。

## 装

Windows x64 + Node 18+（或用独立 exe，不需要 Node/Python）：

```json
{
  "mcpServers": {
    "wechat-file": { "command": "C:\\你\\的\\路径\\wechat-file-mcp.exe", "args": [] }
  }
}
```

- 独立 exe：`dist/wechat-file-mcp.exe`（单文件，依赖全在里面）。
- 源码：`python server.py`（需 `pip install pycryptodome zstandard`），或 `uv run server.py`。
- 数据目录默认自动探测（微信 4.x 自定义目录、任意盘）；探测失败用 `env.LUMII_WECHAT_DB` 兜底。
- **改 py 代码要重新构建 exe**：`pnpm --filter ./apps/windows build:wechat-file-mcp`。

技能包（给别的 AI 客户端看的接入说明）：[`skills/wechat-file-mcp/SKILL.md`](skills/wechat-file-mcp/SKILL.md)。

## 工具（2 个）

| 工具 | 说明 |
|---|---|
| `list_files(talker?, since?, until?, types?, keyword?, only_missing?)` | 列文件消息 + 磁盘定位。`only_missing=true` = **过期预警** |
| `archive_files(out_dir, talker?, since?, until?, types?, layout?, dry_run?)` | 拷贝归档；`dry_run=true`（默认）只出计划 |

`layout`：`by_session`（默认，每会话一个子目录）/ `by_type` / `flat`。
每条文件的 `status`：`ok` 可归档 / `size_mismatch` 同名但大小不符（可能另一版本）/ `missing` 过期或未下载。

## 怎么工作的（一条链）

1. 消息：`message/message_N.db`（多分片，时间滚动）里 `local_type=49` 且 appmsg `type=6` 的是文件消息，
   带 `title`(文件名) / `totallen`(大小) / `fileext`。
2. 磁盘：文件本体在 `msg/file/<YYYY-MM>/<文件名>`，与消息 `title` **同名**；
   同名用 `totallen` 对大小消歧，少量文件带 `YYYYMMDD` 前缀（按别名命中）。
3. 关联率：真机实测 140 条文件消息 → 132 条可定位（94%），其余 8 条是**未下载/已过期**。

## 不支持的

- 归档**已过期**的文件（服务器端已无，本地也没有）。
- 图片/视频（另属记录导出；本产品只管文件消息）。
- 读取**别人**的数据（只支持本机已登录账号）。

## 文件

| 文件 | 作用 |
|---|---|
| `server.py` | MCP 入口（stdio JSON-RPC）+ 2 个工具 |
| `filecore.py` | 核心逻辑（纯函数，可单测）：文件消息解析、磁盘映射、归档 |
| `test_filecore.py` | 单测（纯函数 + 真机只读冒烟，无微信库时跳过） |
| `skills/wechat-file-mcp/SKILL.md` | 给别的 AI 客户端看的技能包 |

**共享基础层**：读取层（密钥扫描 / SQLCipher 解密 / 多分片镜像 / 路径发现）直接复用 `../wechat-mcp/`
的模块，本包**不复制**——详见 `docs/design/渠道与CLI/2026-10-12-微信小工具MCP四件套设计.md`。

自检：`python test_filecore.py`（纯函数秒回 + 真机只读冒烟）。
