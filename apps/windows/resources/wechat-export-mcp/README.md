# wechat-export-mcp · 微信记录导出

一个 **stdio MCP server**：把本机微信里某个会话的聊天记录导出成 **md / html / json**，
可选连图片（已解密）与语音（SILK→wav）、可选语音转写。

**只读**：读层直读 SQLCipher4（密钥从进程内存**只读**扫描取，不注入、不改微信数据）；
导出只是把记录写成文件，微信里一个字都不动。

> ⚠️ 仅用于**你自己的账号、你自己的机器**。记录涉及他人隐私——**本地导出、不外传**。

## 装

```json
{
  "mcpServers": {
    "wechat-export": { "command": "C:\\你\\的\\路径\\wechat-export-mcp.exe", "args": [] }
  }
}
```

- 独立 exe：`dist/wechat-export-mcp.exe`（单文件）。
- 源码：`python server.py`（需 `pip install pycryptodome zstandard pilk`），或 `uv run server.py`。
- 数据目录默认自动探测；探测失败用 `env.LUMII_WECHAT_DB` 兜底。
- **改 py 代码要重新构建 exe**：`pnpm --filter ./apps/windows build:wechat-export-mcp`。

技能包：[`skills/wechat-export-mcp/SKILL.md`](skills/wechat-export-mcp/SKILL.md)。

## 工具（2 个）

| 工具 | 说明 |
|---|---|
| `list_sessions(query?)` | 列会话（拿确切名字/talker） |
| `export_chat(talker, out_dir, format?, since?, until?, media?, transcribe_voice?, split?)` | 导出 |

- `format`：`md`（默认）/ `html`（可分享，带样式）/ `json`（机读）。
- `media`：`none`（默认）/ `images` / `all`（+语音 wav）。
- `split`：`none`（默认）/ `month`（按月拆子目录）。
- `transcribe_voice`：默认 `false`；需本机装语音识别模型，缺了就逐条跳过并计数。
- 这三个枚举值**传错会被拒**（返回 `error_code=bad_args`），**不会静默降级**——否则
  "参数打错"和"这批消息没图"在返回里分不出来。
- `talker` 传会话**显示名**（如「文件传输助手」）或 wxid/群号都可以；解析不出唯一目标时返回
  `error_code=target_not_found`（**不是**"这个会话没记录"）。

## 输出形态

```
D:\导出\客户群\
  chat.md              ← 正文（split=month 时是 2026-08\chat.md 等）
  assets\img_001.jpg   ← media=images/all
  assets\voice_003.wav ← media=all
```

正文（群聊标发送人）：
```markdown
### 2026-08-12 14:30 · 张三
晚上一起吃饭？

### 2026-08-12 14:31 · 我
好，几点？
```

## 怎么工作的

1. **跨分片全量**：微信 4.x 按时间滚动分片（`message_N.db`），只读 `message_0.db` 会漏掉绝大部分历史——
   本服务合并**所有分片**。
2. **正文保留换行**：群消息正文前缀了发送者（`wxid:\n文本`），按核心的 `_PREFIX_RE` 剥掉后再保留换行；
   非文本消息走 `describe_nontext` 拿一行摘要（`[图片 17KB]`/`[引用] …`）。
3. **代发标记**：助手代发的消息正文里有零宽标记，导出时剥掉并标 `agent_sent`。
4. **图片**：走已解密的本地位图（需账号级图片密钥已缓存，见 wechat-mcp 的说明）。
5. **语音**：`VoiceInfo` 里的 SILK → `pilk` 解码 → stdlib `wave` 写 wav。

## 不支持的

- 导出发送（导出 ≠ 发送；发送是另一个产品的事）。
- 语音转写：**需要模型**，且 `sherpa-onnx` 未随 exe 打包（体积），没装就跳过。
- 读取**别人**的数据（只支持本机已登录账号）。

## 文件

| 文件 | 作用 |
|---|---|
| `server.py` | MCP 入口（stdio JSON-RPC）+ 2 个工具 |
| `exportcore.py` | 核心逻辑：跨分片取数、渲染 md/html/json、媒体导出 |
| `test_exportcore.py` | 单测（纯函数 + 真机只读导出冒烟，无库时跳过） |
| `skills/wechat-export-mcp/SKILL.md` | 给别的 AI 客户端看的技能包 |

**共享基础层**：读取层直接复用 `../wechat-mcp/` 的模块，本包**不复制**——详见
`docs/design/渠道与CLI/2026-10-12-微信小工具MCP四件套设计.md`。

自检：`python test_exportcore.py`。
