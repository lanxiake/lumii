# wechat-mcp · 本机微信 MCP 服务

## 社区安装（npm，持续更新）

**Windows x64 + Node 18+**，在任意支持 stdio MCP 的客户端（Cursor、Claude Desktop、Cline 等）配置：

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

- npm：[@lumii/wechat-mcp](https://www.npmjs.com/package/@lumii/wechat-mcp)（无需本机 Python）
- **国内网络**：可用 npmmirror（`registry.npmmirror.com`），见 [`PUBLISHING.md` §1.1](PUBLISHING.md#11-国内网络镜像源通常不必-vpn)
- **离线 / 内网**：exe 或 tgz，见 [`PUBLISHING.md` §1.2](PUBLISHING.md#12-离线安装不依赖-npm-在线拉包)
- 维护者发版、CI、版本规则：[`PUBLISHING.md`](PUBLISHING.md)
- 使用灵栖的用户：设置里启用内置 **wechat-local** 即可，exe 在 `%USERPROFILE%\.lumii\mcp\wechat-mcp\`

---

一个 **stdio MCP server**：让 AI Agent 以**用户本人身份**读本机微信（会话/历史/检索/未读），并能**发消息、发文件、引用回复、群发**，以及**蒸馏用户/好友画像与行为**。

**零注入、零外传、只读优先**：读层用 SQLCipher4 直读（密钥从进程内存**只读**扫描取，不注入、不改微信数据）；写层用**截图 OCR 定位 + SendInput** 模拟真人操作。

> ⚠️ 仅用于**你自己的账号、你自己的机器**。数据涉及他人隐私——全部**本地处理、不外传**。

想让 AI **自动回复**你的微信？那是接入侧的事（MCP 只提供工具，不会自己回复）。
把带场景描述的「技能包」丢进客户端的 skills 目录即可，Agent 会自己认场景并调用：

- [`skills/wechat-mcp-pro/`](skills/wechat-mcp-pro/SKILL.md) —— 高级版（能看图、转写语音、蒸馏画像）
- [`skills/wechat-mcp-lite/`](skills/wechat-mcp-lite/SKILL.md) —— 基础版（只读收发文本/文件）

两份都含**安装方式、工具面、一轮完整回路、发送纪律与能力边界**，是给**别的 AI 客户端**看的
接入说明；[`DEMO-代聊回路.md`](DEMO-代聊回路.md) 是不分档位的通用回路原型，两版技能都由它派生。

---

## 1. 环境要求

- **Windows**（依赖 Win32 GDI/UI Automation/剪贴板与 PowerShell）。
- **微信 4.x**，且已登录、主窗口可正常显示。
- **Python 3.10+**（在微信所在的同一台机器上运行），或者装了 [uv](https://docs.astral.sh/uv/)（推荐，uv 会自动准备 Python 与依赖）。

## 2. 协议与兼容性

- 传输：**stdio**（换行分隔的 JSON-RPC 2.0），stdout 只输出协议消息，日志走 stderr。
- 协议版本：`2025-06-18` / `2025-03-26` / `2024-11-05`，`initialize` 时按客户端请求协商。
- 能力：`tools`（**按档位** 12 或 19 个工具，带 `readOnlyHint` / `destructiveHint` 等 annotations），`initialize` 返回 `instructions` 使用引导与 `edition` 字段。
- 支持 `ping`；未知方法回 `-32601`，未知工具回 `-32602`；工具内部失败以 `isError: true` 结果返回。
- 依赖缺失时服务仍能启动并列出工具，`check_env` 的 `deps` 字段会报告缺什么，相关工具返回带安装命令的错误。

## 3. 安装与配置（任选一种）

### 方式 0：独立 exe（推荐，不需要 Python）

`wechat-mcp.exe` 是 PyInstaller 打出的单文件，依赖全在里面。装了灵栖的机器上它已部署在
`%USERPROFILE%\.lumii\mcp\wechat-mcp\wechat-mcp.exe`（灵栖每次启动按内容同步，路径固定、不随安装位置变化）；
也可以自己构建：`pnpm --filter ./apps/windows build:wechat-mcp`——**一次把两档都打出来**
（`dist/wechat-mcp.exe` + `dist/wechat-mcp-lite.exe`，各带一份按版本命名的副本；需要 [uv](https://docs.astral.sh/uv/)）。
只想打一档用 `--edition pro` / `--edition lite`，或 `pnpm build:wechat-mcp:lite`；
加 `--if-stale` 在两档都已是最新时跳过。
版本号来自 `server.py` 的 `SERVER_VERSION`，也写在 exe 的 Windows 属性（右键 → 详细信息 → 文件版本）里，`wechat-mcp.exe --version` 输出同一值；`--edition` 打印档位（`pro`/`lite`）。

```json
{
  "mcpServers": {
    "wechat-local": {
      "command": "C:\\Users\\you\\.lumii\\mcp\\wechat-mcp\\wechat-mcp.exe"
    }
  }
}
```

装了 Node 的机器也可以走 npm（同一个 exe，按平台自动下载）——见文首 **社区安装**。
维护者：`pnpm --filter ./apps/windows pack:wechat-mcp-npm`，发布见 [`PUBLISHING.md`](PUBLISHING.md) 与 Actions **publish-wechat-mcp**；版本号取 `server.py` 的 `SERVER_VERSION`。

`wechat-mcp.exe --version` 打印版本号。exe 是两层进程（引导进程 + Python），客户端停掉引导进程时内层会跟着退出。

> 以下源码方式的路径换成你本机 `wechat-mcp` 目录的**绝对路径**。

### 方式 A：uv（零手工安装）

`server.py` 顶部带 [PEP 723](https://peps.python.org/pep-0723/) 内联依赖声明，`uv run` 会自动创建隔离环境并装好依赖：

```json
{
  "mcpServers": {
    "wechat-local": {
      "command": "uv",
      "args": ["run", "C:\\path\\to\\wechat-mcp\\server.py"]
    }
  }
}
```

首次启动要下载依赖（可能需要十几秒）；国内网络可在 `env` 里加 `"UV_DEFAULT_INDEX": "https://pypi.tuna.tsinghua.edu.cn/simple"`。

### 方式 B：自己的 Python + pip

```bash
python -m pip install -r requirements.txt   # 必需 pycryptodome；推荐 zstandard
```

```json
{
  "mcpServers": {
    "wechat-local": {
      "command": "C:\\Python312\\python.exe",
      "args": ["C:\\path\\to\\wechat-mcp\\server.py"]
    }
  }
}
```

**`command` 请写解释器的绝对路径，不要写裸 `python`**：多数 MCP 客户端不经过 shell 直接启动进程，
Windows 上 PATH 里的 `%LOCALAPPDATA%\Microsoft\WindowsApps\python.exe` 是 Microsoft Store 的占位程序，
命中它会直接以 **code=9009** 退出（表现为「进程提前退出」）。用 `where python` 查真实路径，
或在「设置 → 应用 → 应用执行别名」里关闭 `python.exe` / `python3.exe` 两个别名。

### 可选环境变量

在上面任一配置里加 `env`：

```json
"env": {
  "LUMII_WECHAT_ACCOUNT": "wxid_xxxxxxxxxxxx",
  "LUMII_WECHAT_DB": "C:\\Users\\you\\xwechat_files\\wxid_xxx_xxxx\\db_storage",
  "LUMII_WECHAT_DISTILL": "D:\\wechat-distill"
}
```

- 客户端（Claude Desktop / Cursor / Cline / Cherry Studio 等支持 stdio MCP 的宿主）填法大同小异，都是 `command` + `args`。
- 在灵栖里无需手工配置：内置项直接写方式 0 的 exe 绝对路径（不含任何占位符，可原样复制给别的客户端）；
  旧版的 `{{LUMII_PYTHON}}` + `{{LUMII_RESOURCES}}/wechat-mcp/server.py` 配置会在启动时自动迁移。
- **改了 py 代码要重新构建 exe 并重启灵栖**（`build:wechat-mcp` → 启动时同步到部署目录）；
  用源码方式跑的，重连 MCP 即可。
- 连通性自测：`echo {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18"}} | python server.py`，应输出一行 `initialize` 结果。

## 4. 环境变量说明

| 变量 | 作用 |
|---|---|
| `LUMII_WECHAT_DB` | 直接指定微信数据目录（含 `message/message_0.db`）。**一般不用填**：自动探测已覆盖 4.x 自定义目录与任意盘；只在探测失败时兜底 |
| `LUMII_WECHAT_ACCOUNT` | 多账号时锁定账号（`wxid` 或目录名） |
| `LUMII_WECHAT_DISTILL` | 画像/状态产出目录（默认 `~/.lumii/wechat-distill`） |

### 数据目录自动探测

微信 4.x 的**自定义数据目录不在注册表**，而是写在 `%APPDATA%\Tencent\xwechat\config\<哈希>.ini`（文件内容即数据基目录，
即 `xwechat_files` 的父目录）。本服务按下列优先级自动定位（先命中先用），**换机 / 数据目录在别的盘都能找到**：

1. `LUMII_WECHAT_DB` / `LUMII_WECHAT_ACCOUNT`（显式，最高）
2. `%APPDATA%\Tencent\xwechat\config\*.ini`（4.x 自定义目录的权威来源；Linux 为 `~/.xwechat/config/*.ini`）
3. 注册表 `HKCU\Software\Tencent\Weixin`（4.x）/ `Tencent\WeChat`（3.x）
4. 默认路径 `~/xwechat_files`、`~/Documents/xwechat_files`
5. **固定盘有界扫描**（深度 ≤ 2，覆盖 `D:\微信\xwechat_files` 这类）

用 `locate_db` 工具或 `devcli.py accounts` 可查看命中的 `root` 与其 `source`（从哪找到的）。

## 5. 授权与有效期（只影响 pro 版 exe）

`lite`（基础版）**免费、不校验**。`pro`（高级版）在**打包成 exe** 运行时校验离线授权，
**没授权就降级为基础版**（不拒绝启动，只是工具集退回 12 个）。

源码方式跑（`python server.py`）不做授权校验——那是开发/测试场景。

**三步拿到授权：**

1. 用户在自己的机器上跑 `wechat-mcp.exe --machine-id`，把输出的 JSON 发给你；
2. 你离线签发：`python tools/sign-license.py --fp '<上面那段 JSON>' --days 365 --out license.json`
   （详见 [`tools/sign-license.py`](tools/sign-license.py) 头注释）；
3. 用户把 `license.json` 放到 `%USERPROFILE%\.lumii\wechat-mcp\license.json`。

排障：`wechat-mcp.exe --license-status` 打印授权状态、生效档位与授权文件路径。
`--edition` 打印**构建档位**（产物是哪一档），与生效档位是两回事。

- **机器绑定**：授权绑三个子指纹（主板 UUID / 系统盘卷序列号 / 系统 MachineGuid），
  **2/3 命中即通过**——换网卡、加硬盘、单硬件漂移都不误伤，换整机必挂。**刻意不用 MAC**（虚拟网卡/VPN 常变）。
- **有效期**：签发时定（默认 365 天）；到期后降级为基础版。
- **防时钟回拨**：`~/.lumii/wechat-mcp/.state.json` 记见过的最大时间，回拨按过期处理。
- **授权文件不要放 exe 同目录**：灵栖按内容哈希同步 exe 目录，用户也会整目录拷走。
- **灵栖内置的用户免授权**：灵栖把 exe 部署到 `<数据根>/mcp/wechat-mcp/` 时会在同目录写一个
  `.lumii-bundled` 标记，exe 见到它就按已授权处理。⚠️ 这是**礼貌性豁免，不是安全边界**——标记可伪造。

## 6. 工具

### 两个档位

同一份源码打两个 exe，差异**只在构建期**注入（构建脚本往临时源码目录写一个 `edition.py`，
工作区不落这个文件，所以跑源码 = `pro`）：

| 档位 | exe | 工具 | 说明 |
|---|---|---|---|
| `pro`（高级版，默认） | `wechat-mcp.exe` | 19 个 | 基础读写发送 **+ 媒体 + 用户蒸馏** |
| `lite`（基础版） | `wechat-mcp-lite.exe` | 12 个 | 只有基础读写发送；**不解媒体**（消息只剩 `[图片 17KB]`/`[语音 3.2 秒]` 摘要） |

构建：`pnpm --filter ./apps/windows build:wechat-mcp`（pro）/ `build:wechat-mcp:lite`（lite）。
**档位不是运行期开关**：客户端改不了，`tools/list` 只列出本档工具，直接按名字调用被门控的
工具也会被拒（返回协议错误）。用 `wechat-mcp.exe --edition` 可打印本产物的档位。

`lite` 版**连 `image_path` / `voice_path` 都不返回**——否则「基础版没有图片解析」是句空话。

### 语音转写（pro 版）

`transcribe_voice` 把语音转成文字，**全本地**：SILK 用 `pilk` 解码成 PCM，
再喂给 `sherpa-onnx` 的离线 Paraformer（与灵栖 App 侧同一个模型）。音频不外传。

**要先有模型**（约 78MB，**不在 exe 里**，否则包体白涨）：

| 情形 | 怎么办 |
|---|---|
| 装了灵栖 | **什么都不用做**——它已经下在 `~/.lumii/models/voice/asr/paraformer-zh-small`，MCP 默认就复用那一份 |
| 独立用户 | `wechat-mcp.exe --download-asr-model`（国内走 hf-mirror，GitHub 兜底） |
| 想放别处 | 设 `LUMII_WECHAT_ASR_MODEL=<目录>`，目录里需有 `model.int8.onnx` 与 `tokens.txt` |

状态自查：`check_env` 返回里的 `asr` 字段（依赖 / 模型目录 / `ready` / 缺失原因）。
实测耗时：3 秒语音约 **0.5 秒**；首次调用含模型加载约 **3 秒**。

> `sherpa-onnx` / `pilk` / `numpy` 这三个依赖**只有 pro 版带**（lite 版不带，免得两版体积没区别）。

### 工具清单

**仅 pro 版有**：`read_image`、`transcribe_voice`、`wechat_digest`、`wechat_distill_state`、
`wechat_distill_clear`、`wechat_profile_save`、`wechat_profile_get`。下表其余工具两档都有。

**只读（不需要微信窗口）**

| 工具 | 说明 |
|---|---|
| `list_sessions(query?)` | 列会话（显示名 + talker + 最新预览），`query` 按关键词过滤 |
| `read_history(talker, limit, before_ts?)` | 读历史（正序；带 `cursor`/`has_more` 翻页）；每条带 `from_me`/`sender`，群里 @ 了本人则带 `at_me: true`。🅿 图片/语音消息另带 `image_path`（**已解密的明文位图**）/`voice_path` |
| 🅿 `read_image(talker, local_id)` | 取一张图片消息的**内容**：返回 MCP **image 内容块**（内联 base64 位图），跨机/客户端读不到本地文件时用；随图返回 `variant`(hd/thumb) 与 `bytes` |
| 🅿 `transcribe_voice(talker, local_id)` | **本地**把一条语音转成文字（SILK → Paraformer，音频不外传）。需模型就位，见 §6「语音转写（pro 版）」；较老的语音音频可能已被微信清掉，这时返回 `voice_unavailable` |
| `poll_new(since_ts)` | 增量新消息（正序）。每条带 `from_me`/`sender`（自己发的也返回），群里 @ 了本人则带 `at_me: true`（按 `msgsource.atuserlist` 里的 wxid 判定，不看昵称）；返回 `next_since_ts` 供下一轮直接用（**别传墙上时钟的 now**，同秒会漏）。走增量快路径：只解密新增的 WAL 帧、只扫有变化的会话表 |
| `search_messages(keyword, talker?, since?, until?)` | 关键词/时间检索（跨全部时间分片） |
| `list_unread()` | 未读会话 + 最近一条预览 |
| `check_env()` | 自检：微信进程/窗口/最小化/前台/尺寸·DPI + 依赖(`deps`)、账号(`accounts`)、数据目录(`db_root`/`db_source`) |
| `locate_db()` | 只读定位微信数据目录：返回 `root`/`source`（从哪找到的）/`accounts`（所有候选账号），换机排查用 |
| `repair_env()` | 确定性环境修复：还原微信窗口 + 规范化到预设尺寸(1280×820) + 重探数据目录；返回修复前后对比 |
| `wechat_digest(talker?, limit?, since?)` | **蒸馏**：行为统计 + 代表性样本（多分片、本地、不外传） |
| `wechat_profile_get(scope?)` | 读回画像（含 `updated`/`age_days`/`stale`）。`scope="self"`（或 `me`/`我`/`本人`）＝ **用户本人**的画像；给会话名/wxid ＝ 该好友/群；**留空**才只列出已产出的画像清单（不含正文） |
| `wechat_distill_state(action?, scope?, ts?)` | 蒸馏**水位**（增量蒸馏用） |

**发送（均默认 `dry_run=true`）**

| 工具 | 说明 |
|---|---|
| `send_text(talker, text, dry_run)` | 发文本 —— **不需要前台，锁屏也能发**（窗口消息投递，不移动光标/剪贴板、不打断用户） |
| `send_file(talker, path, dry_run)` | 发文件/图片/视频——**不按扩展名分流**，一律走微信「发送文件」入口；**不需要前台，锁屏也能发** |
| `send_batch(messages=[{talker,text}], dry_run)` | 群发（逐目标独立校验） |
| `reply_to(talker, quote, text, dry_run)` | **引用回复**（`quote` 传被引用消息的文字定位） |
| `wechat_profile_save(scope?, content)` | 存画像（Markdown，本地白盒）。本人那份用 `scope="self"`。⚠️ **整份覆盖写**（旧的只留一份 `.prev` 备份）——更新前先 `wechat_profile_get` 读回 |
| `wechat_distill_clear(scope?, everything?)` | **一键清除**画像/水位（清空全部须 `everything=true`；`scope="self"` 只清本人那份） |

## 7. 发送安全（fail-closed）

发送前依次校验，任一不过即中止、**绝不盲发**：**环境**（微信运行、主窗口可见；`send_text`/`send_file` 都不要求前台）→ **目标会话**（内容锚点 + 头部双印证，
并新增"**头部更像别的会话即拒绝**"的通用反证与群成员昵称第三重印证）→ **输入落地** → **发送生效** → **读库确认**。
失败返回稳定 `error_code` + 最后截图路径；跨进程文件锁保证一次只做一个 UI 操作。

## 8. 隐私

- 只读本人账号数据；**全本地处理、不外传**（裸 MCP 客户端下画像不自动注入，靠 `wechat_profile_get` **按需取**；
  灵栖的「本机微信代聊」会**每轮注入一次**命中的画像——那是 App 侧行为，见
  [`docs/wechat-mcp-optimization-plan.md`](../../../../docs/wechat-mcp-optimization-plan.md) §3.9）。
- 画像落 `~/.lumii/wechat-distill/`（白盒 Markdown，可读/可改/可删）；`wechat_distill_clear` 一键清除。
- **注意**：把画像/聊天内容交给云端 LLM 即等于外传——这由你的客户端与模型决定，请自行评估。

## 9. 不支持的

- **发**微信语音消息（按住录音，无法自动化）——只能把音频**当文件**发。
  （**读**语音是支持的：pro 版的 `transcribe_voice` 本地转写，见 §6。）
- 微信 **3.x** 的 `WeChat Files` 目录布局（本 Server 面向 4.x 的 `xwechat_files`）。
- 读取**别人**的数据（只支持本机已登录账号）。

## 10. 文件

| 文件 | 作用 |
|---|---|
| `server.py` | MCP 入口（stdio JSON-RPC） |
| `wechat_core.py` | 只读读取（发现目录/取密钥/解密/查询/蒸馏/画像） |
| `wechat_sender.py` | 发送（截图 OCR + SendInput + 剪贴板） |
| `wxread4.py` / `wxkey4.py` | SQLCipher4 解密 / 进程内存取密钥 |
| `licensing.py` | 离线授权：机器指纹、RSA 验签、有效期、防回拨、灵栖内置豁免 |
| `wechat_asr.py` | 本地语音转写（SILK → Paraformer），仅 pro 版用；含模型目录解析与 `--download-asr-model` 的下载实现 |
| `tools/sign-license.py` | **离线签发工具（不随 exe 分发）**；私钥在 `~/.wechat-mcp-keys/`，绝不入库 |
| `DEMO-代聊回路.md` | 用本 MCP 做「本机微信自动回复」的通用回路原型（不分档位；两版技能都由它派生） |
| `skills/wechat-mcp-pro/` `skills/wechat-mcp-lite/` | **给别的 AI 客户端看的技能包**：安装方式 + 工具面 + 一轮完整回路 + 发送纪律 + 能力边界。放客户端 skills 目录即用 |
| `devcli.py` | 自检命令行（`status/sessions/history/send/sendfile/reply/watch/selftest/digest/profile/state/clear/accounts...`） |
| `test_edition.py` | 档位切分自测（工具集 / 门控 / 引导词 / 媒体裁剪），不碰微信，秒级 |
| `test_agent_mark.py` | 代发标记自测（两侧码位一致 / 先剥后截断），不碰微信，毫秒级 |
| `test_render_labels.py` | 非文本消息标签自测（`appmsg type` → `[引用]`/`[转账]`… 与未知类型兜底），纯函数，毫秒级 |
| `test_skills.py` | **技能包 ↔ 产物一致性**：两份 `SKILL.md` 的工具名必须与真 exe 的 `tools/list` 完全对上（文档漂移不会自己报警，靠它兜） |
| `ocr4.ps1` | 四角坐标 OCR（PowerShell）；截图已在进程内用 `PrintWindow` 完成，不再有 `shot.ps1` |

自检：`python devcli.py selftest`（依赖 / 数据目录 / 会话 / 实时读取耗时一次看全）。
档位自测：`python test_edition.py`（源码跑起来永远是 pro，两个档位的差异在开发机上看不见，靠它兜底）。
授权自测：`python test_licensing.py`（临时密钥对 + 临时目录，不碰你机器上的授权；验签/指纹/到期/回拨/豁免/降级全覆盖）。
标记/标签自测：`python test_agent_mark.py`、`python test_render_labels.py`（都是纯函数，不碰微信）。
技能自测：`python test_skills.py`（需先 build 出 dist 的两个 exe；没 build 会自动跳过）。
盯消息：`python devcli.py watch [since_ts] [--ticks N] [--interval S]` —— 连续打拍，
输出每拍的新消息、滞后秒数、刷新与查询耗时、快路径命中情况。

### 实时读取（2026-10-08 起）

微信是 WAL 模式：新消息先落 `-wal`，主库文件常常不动。读取层因此按「**主库 + -wal 任一变化都刷新**」
判新鲜（旧实现只看主库 mtime，会**静默读旧**），并只把**属于当前 WAL 会话**的提交帧增量打进明文镜像
（`-wal` 是不截断复用的，文件里混着多轮历史残留帧，靠每条帧自带的 salt 与 WAL 头比对来判定归属）。
实测（本机 3.5MB 库）：空闲刷新 ~2.5ms，单条新消息增量 ~10ms，只有 checkpoint 落主库时才做一次全量
（~55ms，密钥已缓存；原先一次要 ~1.9s 全在扫进程内存取密钥）。
