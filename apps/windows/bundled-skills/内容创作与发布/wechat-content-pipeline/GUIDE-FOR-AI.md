# 公众号文章创作与发布——AI 全流程操作指南

> 本文档面向**在新会话中接手此任务的 AI**，读完即可独立完成从选题到发布草稿的完整流程。
> 人工只需在关键节点审核，其余全自动。

---

## 技能包概览

```
wechat-makeup/                           ← 技能包根目录（本目录）
├── SKILL.md                             ← 技能总入口（安装/结构/系列管理）
├── GUIDE-FOR-AI.md                      ← 本文档：AI操作指南
├── SETUP.md / WORKFLOW.md               ← 环境配置 / 端到端SOP
├── .env.example                         ← 凭证模板（复制为 .env 填值）
├── sub-skills/
│   ├── article-writing-pipeline/SKILL.md + scripts/generate_image.py
│   ├── cloakbrowser-scraper/SKILL.md + scripts/ + templates/
│   └── wechat-publisher/SKILL.md + scripts/publish.py
└── data/
    ├── ai-programming/                  ← 《人人都能用AI写程序》（含 samples/ 示例）
    │   ├── 00-series-outline.md         ← ⭐ 系列大纲（每次接手必读）
    │   ├── samples/                     ← 样板文章（参考）
    │   └── articles/                    ← 新文章产出目录（默认为空）
    └── parenting-with-ai/               ← 《教育是一场对自己的救赎》（含大纲，待写）
        ├── 00-series-outline.md         ← ⭐ 系列大纲
        ├── samples/
        └── articles/                    ← 默认为空
```

**AI 接手任务时，用户会告知当前系列**（如 `data/parenting-with-ai/`），先读该系列的 `00-series-outline.md`，再按本文档流程执行。

---

## 前置：环境准备（每台新机器做一次）

### 1. 安装 Python 依赖

```bash
python -m pip install cloakbrowser pillow
```

cloakbrowser 首次调用会自动下载定制 Chromium（约 535MB），缓存在本地，后续无需重复下载。

### 2. 配置凭证（.env 文件，配一次长期生效）

复制 `wechat-makeup/.env.example` 为 `.env` 填入凭证，脚本自动加载，**新会话无需重设环境变量**。

| 变量名 | 来源 | 用途 |
|--------|------|------|
| `WECHAT_APP_ID` | 微信公众平台 → 设置与开发 → 基本配置 | 发布草稿 |
| `WECHAT_APP_SECRET` | 同上（只显示一次，立即保存） | 发布草稿 |
| `LLM_LINK_API_KEY` | llm-link.top 个人中心 | AI生图（主力配图） |

```bash
cd wechat-makeup
cp .env.example .env
# 编辑 .env，填入 WECHAT_APP_ID / WECHAT_APP_SECRET / LLM_LINK_API_KEY
```

> `.env` 已被 `.gitignore` 忽略；脚本从自身向上查找加载，从哪运行都能读到。

### 3. IP 白名单（每次换网络重做）

```bash
python -c "import urllib.request; print(urllib.request.urlopen('https://api64.ipify.org').read().decode())"
```

把打印的 IP 填入：微信公众平台 → 设置与开发 → 基本配置 → IP白名单。
等 3-5 分钟后生效。若发布报错 `40164`，看报错里的 IP 加白名单（以报错为准）。

---

## 全流程 SOP

```
选题 → ①研究爆款 → ②写作(8段式) → ③配图(GPT生图为主,HTML兜底) → ④生成publish.md → ⑤发布草稿
```

---

## 第一步：研究同主题爆款（30分钟内）

目的：学叙事角度、标题风格、配图思路，不是照抄。

**方法一：抓取公众号文章**
```bash
cd wechat-makeup
python sub-skills/cloakbrowser-scraper/scripts/scrape.py "<公众号文章URL>" --out-dir ref_01
# 正文在 ref_01/body.txt，元数据在 ref_01/meta.json
```

**方法二：AI 搜索（当无具体URL时）**

让 AI 用 WebSearch 搜索主题，搜索词示例（根据当前系列调整）：
- AI编程系列：`"零基础 AI 编程 公众号 爆款 前端后端"`
- 育儿系列：`"亲子沟通 育儿方法 公众号 爆款 幼儿"`

研究重点提炼：标题句式、开篇场景、核心类比、金句、图片类型。

---

## 第二步：写作——8 段式骨架（硬规范）

每篇**严格**按以下 8 段结构写，不可跳过：

| 段落 | 内容要求 |
|------|---------|
| ①开篇·共鸣 | 用读者熟悉的困境切入，"说的就是我"的感受 |
| ②本篇你能学到 | 3-4 条具体收获，设定预期 |
| ③理论·够用就好 | 必要原理，全用生活类比，篇幅 ≤ 全文 1/3 |
| ④实操·跟着做 | 可操作步骤；**必须给可直接复制的提示词** |
| ⑤成果·看得见 | 5-30 分钟能跑出可见成果，立刻给成就感 |
| ⑥避坑·真实经验 | 最易踩的坑 + 解决思路；把报错正常化 |
| ⑦本篇小结 | 3 条核心要点，可截图保存 |
| ⑧下一篇预告+互动 | 悬念引导 + 一个能引发评论的具体问题 |

**写作铁律（必须遵守）：**
- 不用"在当今这个X时代"开头，用具体数字或反常识陈述
- 每段不超过 3 句话
- 类比必须落地（"AI 像副驾"比"AI 像智能助手"好）
- 反模式优先：先展示❌错误，再给✅正确
- 删掉所有"非常""极其""十分"
- 结尾不写总结，写能引发评论的问题

**系列类比库（从当前系列的 `00-series-outline.md` 读取，保持全系列一致）：**

> 每个系列有自己的类比库，AI 接手时必须先读 `00-series-outline.md` 获取该系列的专属类比。

**产出文件：** `series/<系列名>/articles/<YYYYMMDD-slug>/final.md`

图片位置用占位注释标记（实际图片后续步骤生成）：
```markdown
<!-- IMAGE:01 type=cover -->
<!-- IMAGE:02 type=infographic path=images/02-xxx.png -->
```

**文章命名规范：**
- 文件夹：`articles/<YYYYMMDD-主题英文slug>/`
- 标题前缀：`【序号】标题`（如 `【06】看懂技术地图——...`）
- 作者：`不懂技术的技术号`

---

## 第三步：配图——GPT 生图为主，HTML 截图兜底

### 配图选型（先选方式，再动手）

**默认首选 gpt-image-2-pro 生图**——封面、概念图、场景插画、纯英文/无文字信息图，一律先用 AI 生图，最美观高效。只有以下三类才退回 HTML 模板截图：

| 情况 | 为什么不用 GPT | 用什么 |
|------|---------------|--------|
| 文字必须分毫不差的中文信息图/架构图 | gpt-image-2-pro 中文易乱码 | HTML 模板截图 |
| 动态对比 / 逐字演示 / 动效（GIF） | AI 生不了动图 | HTML 模板 → `html_to_gif.py` |
| 图片难以表达、需精确结构（矩阵/流程/带标注界面） | AI 难以精确控制布局文字 | HTML 模板截图 |
| 真实运行成果 | 不能 AI 编造 | 截真实页面 |

> 一句话：**能交给 GPT 就交给 GPT；只有简单精确文字图、动态 GIF、AI 表达不好的，才用 HTML。**

### 3a. GPT 生图（主力）

把每张图的提示词写进 `images/prompts.md`（按 section 分块），再调用：

```bash
cd wechat-makeup
LLM_LINK_API_KEY="sk-..." python sub-skills/article-writing-pipeline/scripts/generate_image.py \
  --prompt-file <文章目录>/images/prompts.md \
  --section cover \
  --output <文章目录>/images/01-cover.png \
  --size 1536x1024
```

> ⚠️ **凭证加载注意（重要踩坑）**：
> - `wechat-makeup` 版脚本（`generate_image.py`）**不含 load_dotenv()**，直接读 `os.environ`。
>   必须在命令行前缀注入 key：`LLM_LINK_API_KEY="sk-..." python ...`
> - `wechat-article-publish` 版脚本有 load_dotenv()，但从脚本文件所在目录向上找 `.env`，
>   不是从运行目录找——`.env` 放在技能包根目录时可能找不到。
>   **最保险做法：始终用命令行前缀注入**，不依赖 .env 自动加载。

> ⚠️ **网络环境注意（重要踩坑）**：
> - LLM-Link 的 gpt-image-2-pro 走 `/v1/chat/completions` 端点（不是 `/v1/images/generations`）
> - 若出现 `RemoteDisconnected`（而非 401/403），**不是 key 问题，是出口 IP 被 Cloudflare 拦截**
> - 代理开着时生图请求会被拦截；**关闭代理后恢复正常**
> - 服务器/云主机环境的 IP 也可能被拦，此时需在本地机器执行生图命令

提示词格式要求（脚本用正则解析，格式必须精确）：
```markdown
## #section名称

完整提示词：
\```
...提示词内容...
\```
```

提示词里写明"no text, no words, no letters"；若中文反复出乱，再退回 3b。

### 3b. HTML 截图（兜底：精确文字 / 难表达的结构图）

```bash
cd wechat-makeup
python sub-skills/cloakbrowser-scraper/scripts/screenshot.py \
  "<HTML文件路径>" \
  "<输出PNG路径>" \
  "body"           # CSS选择器，截 body 元素
  2000             # 等待渲染毫秒
  900              # 视口宽度
  500              # 视口高度
```

模板在 `sub-skills/cloakbrowser-scraper/templates/`，复制改文案即用。

### 3c. 动态 GIF（GPT 做不了的）

```bash
python sub-skills/cloakbrowser-scraper/scripts/html_to_gif.py <动画html> images/xx.gif 30 280 720 400
```

### 每篇标准配图清单（4张，按上面的选型决定每张用 GPT 还是 HTML）

| 编号 | 类型 | 内容 | 文件名 | 默认方式 |
|------|------|------|--------|---------|
| 01 | 封面 | 标题+核心要点卡片，深蓝背景，紫色强调色 | `01-cover.png` | GPT 生图 |
| 02 | 信息图 | 本篇核心原理/架构/流程 | `02-xxx.png` | 中文多→HTML；否则 GPT |
| 03 | 信息图 | 选择理由/对比/方法论 | `03-xxx.png` | 中文多→HTML；否则 GPT |
| 04 | 演示图 | AI对话/实操结果/效果展示 | `04-xxx.png` 或 `.gif` | 动态→GIF；真实成果→真截图 |

### HTML 模板设计要点

- **封面**：`width:900px; height:500px`，深蓝渐变背景，左侧主文案，右侧卡片
- **信息图（深色）**：`width:900px`，深蓝黑背景 `#0a1628`，彩色分节
- **信息图（浅色）**：`width:900px`，浅灰背景 `#f4f6fa`，适合对比类图
- **演示图**：模拟真实界面，包含标题栏/对话气泡/结果展示

参考样板：`data/ai-programming/samples/` 与 `sub-skills/cloakbrowser-scraper/templates/`

---

## 第四步：生成 publish.md（发布用文件）

publish.md 是从 final.md 派生的发布版本：
- 去掉 mermaid 代码块
- 去掉 `<!-- IMAGE:xx -->` 注释
- 把图片占位替换为实际 Markdown 图片语法
- 添加 frontmatter（标题/作者/摘要/封面）

**frontmatter 格式：**
```yaml
---
title: 【序号】完整标题
author: 不懂技术的技术号
summary: ≤120字的摘要，含主要收获，让读者决定是否值得点开
cover: images/01-cover.png
---
```

**图片引用格式（publish.md 中）：**
```markdown
![图片描述](images/02-architecture.png)
```

---

## 第五步：发布到微信草稿箱

```bash
cd wechat-makeup
# 凭证自动从 .env 读取，无需在命令前设环境变量
python sub-skills/wechat-publisher/scripts/publish.py "<publish.md 的绝对路径>"
```

**发布成功标志：**
```
[OK] 草稿已保存! media_id=dGPp3Khw-...
登录 mp.weixin.qq.com -> 内容管理 -> 草稿箱 查看
```

脚本自动完成：获取 access_token → 上传封面（永久素材）→ 上传正文图片 → 创建草稿。
**只存草稿，不群发**，人工在后台审核后再推送。

---

## 实战避坑速查表

| 现象 | 原因 | 解法 |
|------|------|------|
| `40164 invalid ip` | 当前 IP 不在白名单 | 用报错里的 IP 去后台加白名单，等3-5分钟 |
| cloakbrowser 截图失败/超时 | Chromium 未下载完成 | 首次运行等待自动下载完（535MB） |
| AI 生图 504 | LLM-Link 上游超时 | 重试3-5次；仍失败再退回 HTML 截图 |
| AI 生图中文乱码 | gpt-image-2-pro 中文渲染差 | 该图退回 HTML 模板截图（仅中文必精确的图才退） |
| Windows 控制台中文乱码 | GBK 编码问题 | 脚本 stdout 只用 ASCII，文件用 utf-8 |
| publish.py 找不到图片 | 路径问题 | publish.md 和 images/ 需在同一目录；脚本从 md 文件所在目录解析图片相对路径 |
| LLM-Link 403/1010 | Cloudflare 拦截 | 请求头必须带浏览器 User-Agent |

---

## 完整示例：从零到发布

```
1. 建目录
   mkdir -p data/<系列>/articles/<YYYYMMDD-slug>/images

2. 写 final.md
   按 8 段式骨架写完整内容
   图片位置用 <!-- IMAGE:xx --> 标记

3. 配图（GPT 生图为主）
   - 把每张图提示词写进 images/prompts.md（按 section 分块）
   - 封面/插画/无中文图 → generate_image.py 调 GPT：
     python sub-skills/article-writing-pipeline/scripts/generate_image.py \
       --prompt-file <文章目录>/images/prompts.md --section cover \
       --output <文章目录>/images/01-cover.png --size 1536x1024
   - 中文必精确的信息图 / 动态 GIF / AI 画不准的 → HTML 模板 + screenshot.py / html_to_gif.py

4. 写 publish.md
   加 frontmatter（title/author/summary/cover）
   把 IMAGE 注释改成 ![描述](images/xx.png)

5. 发布（凭证自动读 .env）
   python sub-skills/wechat-publisher/scripts/publish.py "<文章目录>/publish.md"
   → [OK] 草稿已保存! media_id=...
```

---

## 系列进度追踪

> 进度追踪在各系列的 `00-series-outline.md` 里维护，不在本文档。
> 接手任务时读该系列的大纲确认当前篇号和状态。

---

## AI 接手任务时的标准动作

收到"继续写第X篇"或"写新文章"指令时，按顺序执行：

1. **读当前系列的 `00-series-outline.md`** — 确认该篇定位、内容方向、类比库、语言风格
2. **读当前系列的 `samples/`** — 找1篇成品照抄结构
3. **用 WebSearch 搜索同主题爆款** — 2-3个搜索词，提炼叙事角度
4. **写 final.md** — 严格 8 段式，图片用占位注释
5. **生成配图** — 按第三步选型：封面/插画/无中文图用 `generate_image.py` 调 GPT；中文必精确的信息图、动态 GIF、AI 难表达的结构图才写 HTML 模板截图
6. **写 publish.md** — frontmatter + 正文（图片注释替换为实际路径）
7. **发布** — 运行 publish.py（凭证自动读 .env），确认返回 `[OK] 草稿已保存`
8. **更新系列大纲进度** — 在 `00-series-outline.md` 把该篇状态改为 ✅ 已发布
