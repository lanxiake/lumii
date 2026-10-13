# wechat-mcp · 分发与发布

> **状态**：已确认（2026-10-13 改版）
> **受众**：维护者（发版）、用户（安装）
> **关联**：[`README.md`](README.md)（工具说明）、[`TESTING.md`](TESTING.md)（真机验证）、[`docs/wechat-mcp-optimization-plan.md`](../../../../docs/wechat-mcp-optimization-plan.md)（灵栖内代聊 / `pcwechat`，**不**随 exe 提供）

---

## 一、用户怎么装

### 1.1 双击 exe（推荐）

拿到 `wechat-mcp.exe`，**双击**——向导会带你选 AI 客户端，然后一次配好：部署到稳定目录、
写 MCP 配置、放技能包。全程只按方向键，不用手抄路径。

也可以非交互地跑（脚本化、CI、远程指导用户时用）：

```powershell
wechat-mcp.exe --install          # 装（幂等，可重复跑）
wechat-mcp.exe --install-status   # 看装到哪、注册到哪些客户端
wechat-mcp.exe --uninstall        # 卸（摘注册 + 删技能包；**不删用户数据**）
wechat-mcp.exe --expiry-status    # 这份 exe 的有效期到哪天
```

**不跑 `--install`、只想手写配置**也可以，把 exe 拷到任意位置（路径无中文空格更稳）：

```json
{
  "mcpServers": {
    "wechat-local": { "command": "D:\\tools\\wechat-mcp\\wechat-mcp.exe" }
  }
}
```

验证：`wechat-mcp.exe --version`（应与 `server.py` 的 `SERVER_VERSION` 一致）。

### 1.2 灵栖已安装

无需任何手工步骤：设置里启用「微信本机助手」，exe 由插件下载到
`%USERPROFILE%\.lumii\mcp\wechat-mcp\wechat-mcp.exe`（与 `--install` 的 pro 落点是**同一个位置**）。

### 1.3 离线 / 内网

把 `wechat-mcp.exe` 和 `skills/wechat-mcp-pro/`（或 `-lite`）一起给出去——后者是给 Agent 看的
接入说明（安装方式 + 工具面 + 一轮完整回路 + 能力边界）。**给哪一档就要给对应的那份**：
基础版的技能里明说了「看不到图片和语音」。

> **npm 社区分发（`@lumii/wechat-mcp`）已于 2026-10-13 废弃**：模板、组装脚本
>（`pack-wechat-mcp-npm.mjs`）与 CI workflow 整体删除，分发改走上面这条「双击 exe」的路。

---

## 二、维护者发版流程（唯一版本源）

版本号的**权威来源**是 `server.py` 顶部的 `SERVER_VERSION`（例如 `0.8.0`）。
它同时写进 exe 的 `--version`、MCP `initialize` 与 Windows 版本资源（右键 → 详细信息）。

bump 之后还要同步一处**镜像**：`apps/windows/src/shared/mcp-presets.ts` 的 `WECHAT_MCP_VERSION`
（灵栖的 MCP 面板要显示它；面板每 5s 轮询状态，而 `wechat-mcp.exe --version` 冷启动要 1–3s，
实读会把轮询拖垮，所以留了常量）。忘改不会静默漂移——`apps/windows/src/test/components/mcp-presets.test.ts`
会读回 `server.py` 对账并失败。

### 2.1 发版前检查

在 **Windows** 上（打包用 PyInstaller，仅支持 win32）：

```powershell
cd <仓库根>
pnpm --filter ./apps/windows test:all          # 若动过主进程；至少跑下面这几条 python 的
$py = "$env:USERPROFILE\.lumii\runtimes\python-embed\python.exe"
cd apps\windows\resources\wechat-mcp
& $py test_edition.py     # 档位切分（秒级，发版前必跑）
& $py test_expiry.py      # 内置有效期（同上）
& $py test_mcp_stdio.py   # 四件套共用的协议层
& $py test_mcp_install.py # 一键安装（写别人的配置文件，纪律在这层）
& $py test_watch.py       # 读取层离线回归（或本机 python 3.10+）
```

改发送/读界面逻辑时，加 [`devcli.py selftest`](devcli.py) / 真机 `devcli send … --yes`（见 TESTING.md）。

### 2.2 本地构建

```powershell
cd <仓库根>
pnpm --filter ./apps/windows build:wechat-mcp         # 两档都打
pnpm --filter ./apps/windows build:wechat-mcp:lite    # 只打 lite
# 等价：node apps/windows/scripts/build-wechat-mcp.mjs [--edition pro|lite|both] [--days N] [--if-stale]
```

一次打出**两档**，**各占一个目录**（这样"哪个文件归哪一档"是结构事实，不靠名字猜）：

```
dist\pro\wechat-mcp.exe            pro（高级版）——名字固定，插件下载与部署路径都写死它
dist\pro\wechat-mcp-<version>.exe
dist\lite\wechat-mcp-lite.exe      lite（基础版）——单独分发用，**不进安装包**
dist\lite\wechat-mcp-lite-<version>.exe
```

构建脚本会自己跑一遍冒烟：MCP 握手 + `--version` 与 `initialize` 版本自洽 + 档位自洽 +
**有效期真的打进了产物**（`expiry.py` 没被 PyInstaller 收进去时最后一条会当场报错——
那种产物会静默地"不判到期"，是最坏的失败形态）。

### 2.3 灵栖插件资产（App 用户拿到的就是它）

App 侧「微信本机助手」插件按需从 **GitHub Release** 下载 `wechat-mcp.exe`：

```powershell
node apps/windows/scripts/upload-plugin-assets.mjs --dry-run   # 先看一眼要传什么
node apps/windows/scripts/upload-plugin-assets.mjs             # 真传（需 gh 已登录）
```

- tag **必须** = `v<App版本>`（客户端拼的 URL 用它），脚本自己读 `package.json` 的 version；
- 脚本内部会先跑 `build-wechat-mcp.mjs --if-stale` 保证资产是当前源码构建的；
- **`--if-stale` 会连有效期一起看**：产物比源码新、但剩余不足 30 天，照样重建——
  否则一份躺着不动的旧 exe 会带着只剩几天的有效期被发出去（静默，见 §四）。

### 2.4 发版后

- 灵栖仓库：发 App 版时会带上同版本插件资产；**与 App 版本独立**，但共用同一 `SERVER_VERSION` 便于对账。
- 已经装过插件的客户端**不会自动更新**（`status` 只判文件在不在）——升级要用户自己卸载重装，
  或在面板里重新安装一次。

---

## 三、内置有效期（五件套同一条规则）

**不存在授权密钥**。这份 exe 的有效期在**构建时**钉死：`BUILT_EXPIRY = 构建时刻 + N 天`，
由构建脚本写成一个 `expiry.py` 放进打包源码（工作区**不落**这个文件，所以跑源码不判到期）。
判据在 [`builtin_expiry.py`](builtin_expiry.py)，主产品与四个小工具共用一份。

- **N 默认 365**，用 `--days N` 改：`node scripts/build-wechat-mcp.mjs --days 180`；
- **到期后**：每次工具调用返回 `{"ok": false, "error_code": "expired", "hint": "…"}`，
  `initialize` 照常（连接是通的），引导词里也先写明——用户不会对着一个连不上的服务器发懵；
- **防时钟回拨**：`~/.lumii/wechat-mcp/.state.json` 记见过的最大时间，回拨按过期处理。
  有效期是唯一的约束，不防这一步等于没做；
- **诚实边界**：纯 Python 校验可被 patch 掉。这套挡的是「过期后继续白用」，
  **不是**防逆向，也**不挡**整机转卖。

> 授权密钥那一套（`licensing.py` / `mcp_license.py` / `tools/sign-license.py` /
> `test_licensing.py` / `test_mcp_license.py`）已于 2026-10-13 整体移除。
> 当时的判断：交付一张要用户贴进 MCP 配置的密钥，摩擦比它挡住的东西大；
> 而 `.lumii-bundled` 这类"礼貌性豁免"本来也不是安全边界，留着只会让人以为它在生效。

---

## 四、常见问题

| 问题 | 处理 |
|---|---|
| 双击 exe 什么都没发生 / 黑窗口一闪 | 它是个 stdio MCP 服务器，双击走的是**安装向导**；窗口一闪说明向导崩了，用 `cmd` 跑一次看报错 |
| 用户 macOS / Linux 想装 | 暂不支持；仅 win32-x64 |
| 客户端里连不上 | 先 `wechat-mcp.exe --install-status` 看注册到哪、exe 在哪；再重启客户端（新服务只在重启后加载） |
| 工具调用报 `expired` | 这份 exe 有效期到了，换新版本重装（`--expiry-status` 看到期日） |
| `--expiry-status` 说「源码运行」 | 你在跑**源码**，不是产物；或者在跑一份构建期没注入 `expiry.py` 的坏产物 |
| 改了 `server.py` 但行为旧 | `--install` 是幂等的，跑一次会重新部署；灵栖那条路要卸载重装插件 |
| 打包后 `--version` 与属性页对不上 | 构建期间源码被并行改了；脚本会告警并以 exe 实际值为准 |

---

## 五、交叉引用

- 设计改进脉络：[`docs/plans/渠道与CLI/2026-10-07-微信MCP设计改进计划.md`](../../../../docs/plans/渠道与CLI/2026-10-07-微信MCP设计改进计划.md)
- 双版本与授权改造（授权部分已被本文件 §三 取代）：[`docs/plans/渠道与CLI/2026-10-11-微信MCP双版本与授权改造计划.md`](../../../../docs/plans/渠道与CLI/2026-10-11-微信MCP双版本与授权改造计划.md)
- 四件套（同一套安装/有效期）：[`docs/design/渠道与CLI/2026-10-12-微信小工具MCP四件套设计.md`](../../../../docs/design/渠道与CLI/2026-10-12-微信小工具MCP四件套设计.md)
