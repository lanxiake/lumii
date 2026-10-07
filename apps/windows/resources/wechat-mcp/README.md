# wechat-mcp · 本机微信 MCP 服务

一个 **stdio MCP server**：让 AI Agent 以**用户本人身份**读本机微信（会话/历史/检索/未读），并能**发消息、发文件、引用回复、群发**，以及**蒸馏用户/好友画像与行为**。

**零注入、零外传、只读优先**：读层用 SQLCipher4 直读（密钥从进程内存**只读**扫描取，不注入、不改微信数据）；写层用**截图 OCR 定位 + SendInput** 模拟真人操作。

> ⚠️ 仅用于**你自己的账号、你自己的机器**。数据涉及他人隐私——全部**本地处理、不外传**。

---

## 1. 环境要求

- **Windows**（依赖 Win32 GDI/UI Automation/剪贴板与 PowerShell）。
- **微信 4.x**，且已登录、主窗口可正常显示。
- **Python 3.10+**（在微信所在的同一台机器上运行）。

## 2. 安装

```bash
pip install -r requirements.txt      # 必需 pycryptodome；推荐 zstandard
```

## 3. 配置（把它挂到你的 MCP 客户端）

在客户端的 MCP 配置里加一项，命令用 `python`，参数指向本目录的 `server.py`：

```jsonc
{
  "mcpServers": {
    "wechat-local": {
      "command": "python",
      "args": ["C:\\path\\to\\wechat-mcp\\server.py"],
      "env": {
        // 可选：多账号时锁定账号（wxid 或数据目录名），否则取"最近修改"的那个
        // "LUMII_WECHAT_ACCOUNT": "wxid_xxxxxxxxxxxx",
        // 可选：直接指定数据目录（含 message/message_0.db）
        // "LUMII_WECHAT_DB": "C:\\Users\\you\\xwechat_files\\wxid_xxx_xxxx\\db_storage",
        // 可选：画像/状态产出目录（默认 ~/.lumii/wechat-distill）
        // "LUMII_WECHAT_DISTILL": "D:\\wechat-distill"
      }
    }
  }
}
```

- 客户端（Claude Desktop / Cursor / 各类支持 stdio MCP 的宿主）填法大同小异，都是 `command` + `args`。
- 用 `uv` 亦可：`command: "uv"`, `args: ["run", "--with", "pycryptodome", "--with", "zstandard", "server.py"]`。
- **改了 py 代码要重连 MCP**（客户端"MCP 面板 → 保存并重连"），否则跑的还是旧进程。

## 4. 环境变量

| 变量 | 作用 |
|---|---|
| `LUMII_WECHAT_DB` | 直接指定微信数据目录（含 `message/message_0.db`） |
| `LUMII_WECHAT_ACCOUNT` | 多账号时锁定账号（`wxid` 或目录名） |
| `LUMII_WECHAT_DISTILL` | 画像/状态产出目录（默认 `~/.lumii/wechat-distill`） |

## 5. 工具（15 个）

**只读（不需要微信窗口）**

| 工具 | 说明 |
|---|---|
| `list_sessions(query?)` | 列会话（显示名 + talker + 最新预览），`query` 按关键词过滤 |
| `read_history(talker, limit, before_ts?)` | 读历史（正序；带 `cursor`/`has_more` 翻页）；每条带 `from_me`/`sender` |
| `poll_new(since_ts)` | 读某 Unix 秒之后的增量新消息 |
| `search_messages(keyword, talker?, since?, until?)` | 关键词/时间检索（跨全部时间分片） |
| `list_unread()` | 未读会话 + 最近一条预览 |
| `check_env()` | 自检：微信进程/窗口/最小化/前台/尺寸·DPI + 依赖(`deps`)与账号(`accounts`) |
| `wechat_digest(talker?, limit?, since?)` | **蒸馏**：行为统计 + 代表性样本（多分片、本地、不外传） |
| `wechat_profile_get(scope?)` | 读回画像（含 `updated`/`age_days`/`stale`）；不给 `scope` 列出全部 |
| `wechat_distill_state(action?, scope?, ts?)` | 蒸馏**水位**（增量蒸馏用） |

**发送（需要微信窗口可见且在前台；均默认 `dry_run=true`）**

| 工具 | 说明 |
|---|---|
| `send_text(talker, text, dry_run)` | 发文本 |
| `send_file(talker, path, dry_run)` | 发图片（内联）/ 文件 / 视频（按扩展名） |
| `send_batch(messages=[{talker,text}], dry_run)` | 群发（逐目标独立校验） |
| `reply_to(talker, quote, text, dry_run)` | **引用回复**（`quote` 传被引用消息的文字定位） |
| `wechat_profile_save(scope?, content)` | 存画像（Markdown，本地白盒） |
| `wechat_distill_clear(scope?, everything?)` | **一键清除**画像/水位（清空全部须 `everything=true`） |

## 6. 发送安全（fail-closed）

发送前依次校验，任一不过即中止、**绝不盲发**：**环境**（窗口可见在前台）→ **目标会话**（内容锚点 + 头部双印证，
并新增"**头部更像别的会话即拒绝**"的通用反证与群成员昵称第三重印证）→ **输入落地** → **发送生效** → **读库确认**。
失败返回稳定 `error_code` + 最后截图路径；跨进程文件锁保证一次只做一个 UI 操作。

## 7. 隐私

- 只读本人账号数据；**全本地处理、不外传**（画像默认不自动注入，靠 `wechat_profile_get` **按需取**）。
- 画像落 `~/.lumii/wechat-distill/`（白盒 Markdown，可读/可改/可删）；`wechat_distill_clear` 一键清除。
- **注意**：把画像/聊天内容交给云端 LLM 即等于外传——这由你的客户端与模型决定，请自行评估。

## 8. 不支持的

- **微信语音消息**（按住录音，无法自动化）——只能把音频**当文件**发。
- 微信 **3.x** 的 `WeChat Files` 目录布局（本 Server 面向 4.x 的 `xwechat_files`）。
- 读取**别人**的数据（只支持本机已登录账号）。

## 9. 文件

| 文件 | 作用 |
|---|---|
| `server.py` | MCP 入口（stdio JSON-RPC） |
| `wechat_core.py` | 只读读取（发现目录/取密钥/解密/查询/蒸馏/画像） |
| `wechat_sender.py` | 发送（截图 OCR + SendInput + 剪贴板） |
| `wxread4.py` / `wxkey4.py` | SQLCipher4 解密 / 进程内存取密钥 |
| `devcli.py` | 自检命令行（`status/sessions/history/send/sendfile/reply/digest/profile/state/clear/accounts...`） |
| `ocr4.ps1` / `shot.ps1` | OCR / 截图兜底（PowerShell） |

自检：`python devcli.py selftest`。
