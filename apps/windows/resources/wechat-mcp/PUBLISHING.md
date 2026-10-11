# wechat-mcp · npm 社区分发与发布

> **状态**：已确认（2026-10-09）  
> **受众**：维护者（发版）、社区用户（安装）  
> **关联**：[`README.md`](README.md)（工具说明）、[`TESTING.md`](TESTING.md)（真机验证）、[`docs/wechat-mcp-optimization-plan.md`](../../../../docs/wechat-mcp-optimization-plan.md)（灵栖内代聊 / `pcwechat`，**不**随 npm 包提供）

---

## 一、社区用户怎么装（持续更新入口）

**推荐**（Windows x64，已装 Node 18+，能访问 npm）：

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

| 项 | 说明 |
|---|---|
| npm 包 | [`@lumii/wechat-mcp`](https://www.npmjs.com/package/@lumii/wechat-mcp)（启动器）+ [`@lumii/wechat-mcp-win32-x64`](https://www.npmjs.com/package/@lumii/wechat-mcp-win32-x64)（exe，optional 依赖） |
| 平台 | 仅 **Windows x64**；其它平台 `npx` 会报缺少平台包 |
| 微信 | 4.x 已登录；读库自动发现目录，失败时用 `LUMII_WECHAT_DB` / `LUMII_WECHAT_ACCOUNT` |
| 文档 | 安装与工具清单（按档位 12/19 个）：[`README.md`](README.md) |
| 调试 exe | `LUMII_WECHAT_MCP_BINARY=C:\path\to\wechat-mcp.exe` 可覆盖 npm 自带的二进制 |

**不要用裸 `python` 作 MCP command**（Windows Store 占位会 9009 退出）——见 README §3 方式 B。

**与灵栖的关系**：灵栖内置同名能力，exe 同步到 `%USERPROFILE%\.lumii\mcp\wechat-mcp\`。社区用户**不必装灵栖**即可在 Cursor / Claude Desktop 等客户端使用本 MCP；灵栖的「本机微信代聊 / 盯梢」是 App 内渠道逻辑，不在 npm 包里。

### 1.1 国内网络（镜像源，通常不必 VPN）

包**发布**在 [registry.npmjs.org](https://www.npmjs.com)；国内直连官方源常慢或超时。公共包同步到镜像后，**安装/npx 可改 registry**，包名仍是 `@lumii/wechat-mcp`（不是另一个包）。

| 源 | URL | 说明 |
|---|---|---|
| 官方 | `https://registry.npmjs.org` | 维护者 `npm publish` 的目标；海外或配代理时直连 |
| npmmirror（原淘宝 npm 镜像） | `https://registry.npmmirror.com` | 国内常用；同步有延迟（新发版可能几小时内没有） |

**一次性指定镜像**（PowerShell）：

```powershell
npx -y --registry=https://registry.npmmirror.com @lumii/wechat-mcp
```

**本机长期默认镜像**：

```powershell
npm config set registry https://registry.npmmirror.com
# 恢复官方：npm config set registry https://registry.npmjs.org
```

MCP 客户端里的 `npx` 参数**不用改**（仍 `-y @lumii/wechat-mcp`），只要启动 `npx` 的环境读到了上述 registry 即可。

**注意**：

- 镜像**不能代替发布**——维护者仍发布到 npmjs；镜像只拉副本。
- 包**尚未在 npmjs 上线**时（`npm view @lumii/wechat-mcp` 404），镜像里也不会有 → 用下面 **1.2 离线** 或等首发完成。
- 若镜像缺 optional 平台包，检查是否用了 `--omit=optional`；或暂时切回官方源 / 用 exe 路径。

### 1.2 离线安装（不依赖 npm 在线拉包）

适合内网、registry 不可用、或想固定某一版二进制。

**方式 A · 单文件 exe（最简单）**

维护者或 CI 构建：

```powershell
cd <仓库根>
pnpm --filter ./apps/windows build:wechat-mcp
# 一次打出**两档**。产物：apps\windows\resources\wechat-mcp\dist\
#   wechat-mcp.exe                  pro（高级版）——名字固定，安装包与灵栖部署路径都写死它
#   wechat-mcp-lite.exe             lite（基础版）——单独分发用，**不进安装包**
#   wechat-mcp-<version>.exe 等     各自按版本命名的副本，方便区分与单独分发
#
# 只想出一档：--edition pro / --edition lite（或 pnpm build:wechat-mcp:lite）
```

分发给「别的 AI 客户端」时，把 `skills/wechat-mcp-pro/` 或 `skills/wechat-mcp-lite/`
一起给出去——那是给 Agent 看的接入说明（安装方式 + 工具面 + 一轮完整回路 + 能力边界）。
**给哪一档就要给对应的那份**：基础版的技能里明说了「看不到图片和语音」。

版本号唯一来源是 `server.py` 的 `SERVER_VERSION`，会写进 exe 的 Windows 版本资源——右键属性 → 详细信息看「文件版本」，改名或复制后依然可辨认。

把 `wechat-mcp.exe` 拷到对方机器（路径无中文空格更稳），MCP 配置：

```json
{
  "mcpServers": {
    "wechat-local": {
      "command": "D:\\tools\\wechat-mcp\\wechat-mcp.exe"
    }
  }
}
```

验证：`wechat-mcp.exe --version`（应与 `server.py` 的 `SERVER_VERSION` 一致）。

**方式 B · 本地 tgz（等同 npm 包结构，可内网分发）**

维护者执行 `pnpm --filter ./apps/windows pack:wechat-mcp-npm` 后，在  
`apps/windows/resources/wechat-mcp/dist/npm/` 得到：

- `lumii-wechat-mcp-<version>.tgz`
- `lumii-wechat-mcp-win32-x64-<version>.tgz`

对方机器（需 Node 18+）：

```powershell
mkdir C:\tools\wechat-mcp-npm -Force
cd C:\tools\wechat-mcp-npm
npm init -y
npm install --offline --no-audit "D:\share\lumii-wechat-mcp-0.5.0.tgz" "D:\share\lumii-wechat-mcp-win32-x64-0.5.0.tgz"
```

MCP 配置（用装出来的 cli）：

```json
{
  "mcpServers": {
    "wechat-local": {
      "command": "node",
      "args": ["C:\\tools\\wechat-mcp-npm\\node_modules\\@lumii\\wechat-mcp\\bin\\cli.js"]
    }
  }
}
```

或设置环境变量后仍用 `npx` 的等价物：  
`$env:LUMII_WECHAT_MCP_BINARY="D:\...\wechat-mcp.exe"` 指向平台包里的 exe（调试用）。

**方式 C · 灵栖已安装**

无需 npm：启用内置 wechat-local，exe 在  
`%USERPROFILE%\.lumii\mcp\wechat-mcp\wechat-mcp.exe`（随灵栖启动同步）。

---

## 二、维护者发版流程（唯一版本源）

版本号的**权威来源**是 `server.py` 顶部的 `SERVER_VERSION`（例如 `0.5.0`）。  
组装脚本会把它写入两个 npm 包的 `package.json`，并打进 exe 的 `--version` / MCP `initialize`。

bump 之后还要同步一处**镜像**：`apps/windows/src/shared/mcp-presets.ts` 的 `WECHAT_MCP_VERSION`（灵栖的 MCP 面板要显示它；面板每 5s 轮询状态，而 `wechat-mcp.exe --version` 冷启动要 1–3s，实读会把轮询拖垮，所以留了常量）。忘改不会静默漂移——`apps/windows/src/test/components/mcp-presets.test.ts` 会读回 `server.py` 对账并失败。

### 2.1 发版前检查

在 **Windows** 上（组装与 PyInstaller 仅支持 win32）：

```powershell
cd <仓库根>
pnpm --filter ./apps/windows test:all          # 若动过主进程；至少跑 wechat-mcp 离线回归
cd apps\windows\resources\wechat-mcp
& "$env:USERPROFILE\.lumii\runtimes\python-embed\python.exe" test_edition.py    # 档位切分（秒级，发版前必跑）
& "$env:USERPROFILE\.lumii\runtimes\python-embed\python.exe" test_licensing.py  # 离线授权（同上）
& "$env:USERPROFILE\.lumii\runtimes\python-embed\python.exe" test_watch.py   # 或本机 python 3.10+
```

改发送/读界面逻辑时，加 [`devcli.py selftest`](devcli.py) / 真机 `devcli send … --yes`（见 TESTING.md）。

### 2.2 本地组装 + 验证（不发布）

```powershell
cd <仓库根>
pnpm --filter ./apps/windows pack:wechat-mcp-npm
# 等价：node apps/windows/scripts/pack-wechat-mcp-npm.mjs
```

脚本会依次：

1. `build-wechat-mcp.mjs --if-stale` → **两档都出**（`wechat-mcp.exe` + `wechat-mcp-lite.exe`，
   各带一份 `-<version>` 副本）。本步打的档位比 npm 包需要的多一个，无害——下面的步骤只取它要的那份。
   （**npm 平台包发哪一档尚未定**，见
   [`双版本与授权改造计划`](../../../../docs/plans/渠道与CLI/2026-10-11-微信MCP双版本与授权改造计划.md) P0-5）
2. 拷贝 npm 模板 → `dist/npm/`，写入 `SERVER_VERSION`
3. `npm pack` 两个包 → `dist/npm/*.tgz`
4. 离线安装 tgz，跑 `wechat-mcp --version` 与 MCP `initialize` 握手

通过后再发布；**npm 不允许重复发布同一版本**，忘 bump 版本会在 publish 步骤失败。

### 2.3 发布到 npmjs.org

**方式 A · GitHub Actions（推荐）**

1. 仓库 Settings → Secrets：`NPM_TOKEN`（Automation token，对 `@lumii` scope 有 publish）。
2. Actions → **publish-wechat-mcp** → Run workflow（`workflow_dispatch`）。
3. 工作流在 `windows-latest` 上执行 `pack-wechat-mcp-npm.mjs --publish`。

**方式 B · 本机**

```powershell
npm login   # 或设置 NODE_AUTH_TOKEN
node apps/windows/scripts/pack-wechat-mcp-npm.mjs --publish
```

发布顺序固定：**先** `@lumii/wechat-mcp-win32-x64`，**再** `@lumii/wechat-mcp`（主包一上线，用户 `npm install` 就要能解析到同版本平台包）。

### 2.4 发版后

- 在 [npm @lumii/wechat-mcp](https://www.npmjs.com/package/@lumii/wechat-mcp) 确认版本与 README 渲染。
- 社区用户：`npx -y @lumii/wechat-mcp@<新版本>` 或等 `-y` 拉最新（注意客户端缓存）。
- 灵栖仓库：发 App 版时会 `build:wechat-mcp` 打进安装包；**与 npm 发版独立**，但应共用同一 `SERVER_VERSION` 便于对账。
- 可选：在 [`docs/wechat-mcp-optimization-plan.md`](../../../../docs/wechat-mcp-optimization-plan.md) 或 CHANGELOG 记一笔行为变更。

---

## 三、包结构（给维护者）

| 包 | 内容 |
|---|---|
| `@lumii/wechat-mcp` | `bin/cli.js`：解析平台包里的 `wechat-mcp.exe`，stdio 透传 |
| `@lumii/wechat-mcp-win32-x64` | `bin/wechat-mcp.exe`（PyInstaller 单文件，含 `ocr4.ps1` / `uia_read.ps1` 等） |

模板目录：`npm/wechat-mcp`、`npm/wechat-mcp-win32-x64`。  
改 `package.json` 模板后需重新 `pack:wechat-mcp-npm` 验证。

**许可证**：当前模板为 `UNLICENSED`；若要对社区开源发布，需在发 npm 前改为 SPDX 许可并在 README 写明（与 monorepo 总许可对齐）。

---

## 四、离线授权签发（pro 版 exe）

`lite` 版免费、不校验；`pro` 版**打包成 exe** 后校验离线授权，没授权就降级为 lite。
源码方式跑不校验（开发/测试场景）。完整说明见 [`README.md` §5](README.md)。

**签发三步**

```powershell
# 1. 用户在**自己的机器**上取机器码，把 JSON 发给你
wechat-mcp.exe --machine-id
# {"board": "…", "disk": "…", "os": "…"}

# 2. 你离线签（私钥在你手上，见下）
python tools\sign-license.py --fp '<上面那段 JSON>' --days 365 --out license.json

# 3. 用户放到 %USERPROFILE%\.lumii\wechat-mcp\license.json，再跑 --license-status 核对
```

**密钥管理（最容易出事的地方）**

- 密钥对由 `RSA.generate(2048)` 生成，私钥在 `~/.wechat-mcp-keys/private.pem`，**离线保管、绝不入库**；
  公钥 PEM 内嵌在 `licensing.py` 的 `PUBLIC_KEY_PEM`（公钥可以公开，改它才需要重新出包）。
- **私钥丢了** = 以后签不出新的授权（**已发出的授权仍然有效**，不用慌）。
- **私钥泄了** = 谁都能自己签授权，必须换密钥重出所有 exe，且**已发授权全部作废**。
- 换密钥后 `PUBLIC_KEY_PEM` 变了 → 必须重新 `build:wechat-mcp` 并分发。

**防迁移强度与边界**

- 授权绑三个子指纹（主板 UUID / 系统盘卷序列号 / 系统 MachineGuid），**2/3 命中即通过**：
  换网卡、加硬盘、单硬件漂移不误伤；换整机必挂。**刻意不用 MAC**（虚拟网卡/VPN 常变，误伤率最高）。
- 到期按 `exp` 判；`~/.lumii/wechat-mcp/.state.json` 记见过的最大时间，**回拨系统时钟按过期处理**。
- 灵栖内置的那份**免授权**：灵栖部署 exe 时在同目录写 `.lumii-bundled` 标记
  （`src/main/bundled-mcp-exe.ts`），exe 见到就按已授权处理。
- ⚠️ **诚实边界**：标记可伪造、纯 Python 校验可被 patch 掉。离线方案挡的是**伪造与跨机复用**，
  挡不住**整机转卖与逆向 patch**。真强度要靠打包加固（见改造计划 P2）。

## 五、常见问题

| 问题 | 处理 |
|---|---|
| 用户 `npx` 报缺少 `@lumii/wechat-mcp-win32-x64` | 安装时用了 `--omit=optional` / `--no-optional`，去掉后重装 |
| 用户 macOS / Linux 想装 | 暂不支持；仅 win32-x64 |
| 改了 `server.py` 但 npx 行为旧 | 确认 npm 已发新版本；或让用户 pin 版本 / 用 exe + 绝对路径 |
| CI 发布失败 403 | Token 权限或 scope；或该 `SERVER_VERSION` 已存在 |
| 国内 `npx` 超时 / ECONNRESET | 设 `registry.npmmirror.com`（§1.1），或离线 exe/tgz（§1.2） |
| 镜像里找不到刚发的版本 | 等 npmmirror 同步，或临时用官方源 + 代理，或 pin 已同步的旧版 / 离线包 |

---

## 六、交叉引用

- 设计改进脉络：[`docs/plans/渠道与CLI/2026-10-07-微信MCP设计改进计划.md`](../../../../docs/plans/渠道与CLI/2026-10-07-微信MCP设计改进计划.md)
- 工程索引：[`docs/design/工程基建/2026-10-09-wechat-mcp-npm社区分发.md`](../../../../docs/design/工程基建/2026-10-09-wechat-mcp-npm社区分发.md)
