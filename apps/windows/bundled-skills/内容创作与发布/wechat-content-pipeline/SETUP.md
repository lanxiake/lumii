# 环境配置与依赖（换电脑/新会话必读）

> 本文件让你在**任何一台新电脑或新会话**上，从零配好环境、跑通整套文章创作与发布流程。

---

## 一、依赖清单

| 依赖 | 用途 | 安装 |
|------|------|------|
| Python 3.x | 跑所有脚本（标准库为主） | 系统自带或官网装 |
| cloakbrowser | 抓取/截图/录GIF（穿透微信等反爬） | `python -m pip install cloakbrowser` |
| Pillow | 合成 GIF | `python -m pip install pillow` |

> 注意：若本机 `pip` 被 uv 等接管，统一用 `python -m pip install`。
> cloakbrowser 首次 `launch()` 会自动下载定制 Chromium（约 200MB，缓存本地）。

无需 Node/bun（已弃用第三方 baoyu 技能，发布用纯 Python 的 wechat-publisher）。

---

## 二、凭证配置（.env 文件，一次配置长期生效）

**所有密钥统一写在技能包根目录的 `.env` 文件里**，脚本运行时自动向上查找并加载——**不再需要每次新会话重设环境变量**。`.env` 已被 `.gitignore` 忽略，绝不进仓库。

### 2.1 需要配置的变量一览

| 变量名 | 用途 | 影响哪个流程 |
|--------|------|-------------|
| `WECHAT_APP_ID` | 微信公众号 AppID | 公众号自动发布 |
| `WECHAT_APP_SECRET` | 微信公众号 AppSecret | 公众号自动发布 |
| `LLM_LINK_API_KEY` | LLM-Link 平台 key | gpt-image-2-pro 生图（主力配图） |
| `LLM_LINK_BASE_URL` | LLM-Link 接口地址（默认 `https://www.llm-link.top`） | 生图（一般不用改） |
| `LLM_LINK_MODEL` | 生图模型（默认 `gpt-image-2`） | 生图（一般不用改） |

> **三个流程对应关系**：
> - 网络素材抓取 → 只需安装 cloakbrowser，无需凭证
> - 生图（主力） → 需要 `LLM_LINK_API_KEY`
> - 公众号自动发布 → 需要 `WECHAT_APP_ID` + `WECHAT_APP_SECRET`

---

### 2.2 如何配置 .env

```bash
# 1. 进入技能包根目录
cd wechat-makeup

# 2. 复制模板
cp .env.example .env

# 3. 用编辑器打开 .env，填入真实凭证
#    WECHAT_APP_ID=wx....
#    WECHAT_APP_SECRET=....
#    LLM_LINK_API_KEY=sk-....
```

配好后，无论从哪个目录运行 `publish.py` / `generate_image.py`，脚本都会自动向上查找到 `wechat-makeup/.env` 并加载，**换会话、换终端都不用再设环境变量**。

> 加载逻辑：脚本从自身位置向上最多 6 级查找 `.env`，命中即把键值注入进程环境（用 `setdefault`，不覆盖已存在的系统环境变量）。需要临时覆盖某个值时，仍可在命令前加 `WECHAT_APP_ID=xx python ...`。

> 安全红线：`.env` 只存在于本地，已在 `.gitignore` 排除；`.env.example` 仅含占位符，可安全提交作模板。


### 2.3 各凭证获取方式

**WECHAT_APP_ID / WECHAT_APP_SECRET：**
1. 登录 [微信公众平台](https://mp.weixin.qq.com)
2. 左侧菜单 → 设置与开发 → 基本配置
3. 找到「开发者 ID（AppID）」和「开发者密码（AppSecret）」
4. AppSecret 只在重置时显示一次，**立即保存到本地安全位置**

**LLM_LINK_API_KEY：**
1. 登录 [LLM-Link 平台](https://www.llm-link.top)
2. 在「API 密钥」或「个人中心」页面创建/复制 key

---

### 2.4 配图生成的 LLM-Link 接入说明（主力配图方案）

- **配图首选 gpt-image-2-pro 生图**，只有「文字必须分毫不差的信息图/架构图」「动态 GIF」「图片难以表达需精确绘制」时才退回 HTML 截图（见 WORKFLOW.md ④ 配图策略）
- 接口：`https://www.llm-link.top/v1/chat/completions`（注意是 **chat completions** 接口，不是 images 接口）
- 模型：`gpt-image-2`
- 必带浏览器 `User-Agent` 头（否则被 Cloudflare 拦）
- 响应在 `choices[0].message.content` 里，含 markdown 图片链接，正则提取 URL 再下载
- 504 超时常见，**重试 3-5 次**

---

### 2.5 公众号发布前置配置

1. 拿到 AppID + AppSecret，按 2.2 节填入 `wechat-makeup/.env`
2. 查询当前出口公网 IP（见下方脚本），加入公众号后台 IP 白名单
3. 白名单保存后等 **3-5 分钟**再发布，动态宽带每次都可能需要重加

#### 检测当前出口公网 IP

```python
# 查询出口 IP（多源交叉验证，结果一致则可信）
python -c "
import urllib.request, json

sources = [
    ('api64.ipify.org',    'https://api64.ipify.org?format=json',          lambda d: d['ip']),
    ('ipinfo.io',          'https://ipinfo.io/json',                        lambda d: d['ip']),
    ('ifconfig.me',        'https://ifconfig.me/ip',                        lambda d: d.strip()),
]

ua = {'User-Agent': 'Mozilla/5.0'}
results = []
for name, url, extract in sources:
    try:
        req = urllib.request.Request(url, headers=ua)
        raw = urllib.request.urlopen(req, timeout=8).read().decode()
        ip  = extract(json.loads(raw) if raw.strip().startswith('{') else raw)
        print(f'  {name:<20} → {ip}')
        results.append(ip)
    except Exception as e:
        print(f'  {name:<20} → 查询失败: {e}')

if results:
    unique = set(results)
    if len(unique) == 1:
        print(f'\n✅ 出口 IP（一致）: {results[0]}')
        print(f'   → 将此 IP 填入微信公众号后台 IP 白名单')
    else:
        print(f'\n⚠️  各源返回不同，以微信报错中的 IP 为准: {unique}')
"
```

或使用一行快速版：
```bash
python -c "import urllib.request; print(urllib.request.urlopen('https://api64.ipify.org').read().decode())"
```

> **注意**：若上述结果与微信报错 `errcode 40164 invalid ip X.X.X.X` 中的 IP 不同，**以微信报错里的 IP 为准**——出口线路可能经过代理/NAT，本地探测不可靠。

---

## 三、技能放哪、怎么被识别

本目录的 `sub-skills/` 是**自包含副本**。在新环境用法二选一：

1. **直接按文档手动跑**：照 `WORKFLOW.md` 的步骤，用 `python sub-skills/<技能>/scripts/xxx.py` 调用即可，不依赖任何技能加载机制。
2. **接入 Claude Code 技能系统**：把整个 `wechat-makeup/` 放进你的技能目录（如 `~/.claude/skills/`），Claude 会自动识别 SKILL.md。

> 凭证只配一次：复制 `.env.example` 为 `.env` 并填值，脚本自动加载（见第二节）。

---

## 四、最小验证（配好后自测）

```bash
# 进入技能包根目录
cd wechat-makeup

# 1. 验证 cloakbrowser 能抓取
python sub-skills/cloakbrowser-scraper/scripts/scrape.py "https://example.com" --out-dir _test

# 2. 验证截图
python sub-skills/cloakbrowser-scraper/scripts/screenshot.py sub-skills/cloakbrowser-scraper/templates/terminal.html _test/shot.png .term

# 3. 验证生图（读 .env 里的 LLM_LINK_API_KEY）
python sub-skills/article-writing-pipeline/scripts/generate_image.py --help

# 4. 验证公众号发布凭证（读 .env，发布任一 publish.md 即可，会先换 token）
#    publish.py 启动时若缺凭证会直接报错提示去 .env 配置
```
（生图脚本能打印 --help 即依赖就绪；publish.py 若返回 40164 则去加 IP 白名单。）

---

## 五、安全红线

- 凭证只进 `.env`，**不进 git**（技能包根目录 `.gitignore` 已排除 `.env`）；`.env.example` 仅占位符可提交
- AppSecret 若曾在不可控渠道出现过，到后台**重置**
- 第三方技能下载后**必须审查**（扫外联域名、密钥流向）再用
