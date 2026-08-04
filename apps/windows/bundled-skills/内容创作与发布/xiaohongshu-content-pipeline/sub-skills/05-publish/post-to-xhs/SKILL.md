---
name: post-to-xhs
description: >
  小红书内容发布技能。支持两种发布模式：(1) 上传图文模式 - 图片+短文；(2) 写长文模式 - 长篇文章+排版模板。
  支持两种输入方式：用户提供完整内容和图片/图片URL，直接发布；或提供网页URL，自动提取内容和图片。
  用户说"发长文"时使用长文模式，否则默认图文模式。
---

# 小红书内容发布

根据用户输入自动判断发布方式和发布模式，简化发布流程。

## 发布模式

- **上传图文**（默认）：图片 + 短文，适合日常分享
- **写长文**：长篇文章 + 排版模板选择，适合深度内容。用户明确说"发长文"时使用

## 工作流程

```
用户输入
    │
    ├─ 完整内容 + 图片/图片URL → 判断模式 → 发布流程
    │
    └─ 网页 URL → WebFetch 提取内容和图片
                      │
                      ├─ 有图片 → 适当总结内容 → 判断模式 → 发布流程
                      │
                      └─ 无图片 → 提示用户手动下载图片
                                  │
                                  └─ 用户提供图片后 → 发布流程
```

## Step 1: 判断输入类型

根据用户输入判断：

- **完整内容模式**：用户提供了标题、正文内容、以及图片（本地路径或URL）
- **URL 提取模式**：用户只提供了一个网页 URL

如果不确定，询问用户。

## Step 2: 处理内容

### 完整内容模式

直接使用用户提供的标题和正文，跳到 Step 3。

### URL 提取模式

1. 使用 WebFetch 提取网页内容
2. 提取关键信息：标题、正文、图片URL
3. 适当总结内容，保持：
   - 关键信息完整
   - 语言自然流畅
   - 适合小红书阅读习惯

#### 图片提取失败处理

如果从网页中提取不到图片URL，或图片URL无法访问，**必须**：

1. 告知用户图片提取失败
2. 提供原网页链接，请用户手动访问
3. 指导用户：
   - 在浏览器中打开原网页
   - 右键点击想要的图片 → "图片另存为" 或 "复制图片地址"
   - 将保存的图片路径或复制的图片URL提供给我
4. 等待用户提供图片后再继续发布流程

**示例提示语**：
```
从网页中未能提取到可用的图片。请手动获取：

1. 打开原文链接：[URL]
2. 找到合适的配图，右键另存为本地，或复制图片地址
3. 将图片路径或URL发给我

拿到图片后我们继续发布。
```

## Step 3: 内容检查

### 标题检查

标题长度必须 **≤ 20 个字**（中文字数），包括标点和 emoji。

如果超长，自动简化，保持语义完整和有吸引力。

#### 系列文章命名规范

同一系列的文章，标题格式为：**`序号：标题`**，例如：

```
02：一个kubectl apply背后站着6个打工仔
```

- 序号统一用两位数字（01、02、03...）
- 序号和标题之间用中文冒号 `：` 或空格均可
- 整条标题（含序号）仍遵守 ≤20 字约束

### 正文格式

- **正文长度 ≤ 1000 个字符**（含空格和标点），超出则精简
- **结构化分段**：每段 1-3 句，段落间用空行分隔
- **适当使用图标**：每段开头用 emoji（🏃🏛️⚡🎯⚠️📌✅等）辅助识别
- **适合收藏阅读**：短句为主，关键信息用标记（✔️ ▸ ⚠️）突出，避免大段文字墙
- 语言自然口语化，避免机器翻译感
- 简体中文

#### 正文示例

```
第一棒：API Server（银行前台👩‍💼）

集群唯一入口！负责三件事：
✔️ 认证你是谁（kubeconfig 证书）
✔️ 检查权限够不够（RBAC）
✔️ 验证 yaml 格式对不对（准入控制）

三关过了才接收请求，不干活只调度～

第二棒：etcd（数据中心🏛️）

K8s 唯一数据存储！所有集群状态（Pod、Service 等）都存在这，分布式高可用，用 Raft 协议保数据一致。

⚠️ 只有 API Server 能读写它，这是 "一切皆 API" 的根基～
```

## Step 4: 发布到小红书

完整发布流程参考: [references/publish-workflow.md](references/publish-workflow.md)

### 4.1 用户确认内容

通过 `AskUserQuestion` 向用户展示即将发布的内容（标题、正文、图片），获得明确确认后再继续。

### 4.2 定时发布推荐（可选）

若用户需要定时发布，或内容有明确流量规律：

1. 根据内容目标确定 `content_type`（干货→`knowledge`、美食→`food`、种草→`beauty`、情感→`lifestyle`）
2. 运行推荐脚本：

```bash
python "scripts\schedule_advisor.py" --type knowledge --json
```

3. 用 `AskUserQuestion` 展示 3–5 个推荐时段供用户选择
4. 将选定时间写入 `publish-options.json` 的 `schedule` 字段

策略详情见 [references/schedule-strategy.md](references/schedule-strategy.md)。

### 4.3 选择发布模式

通过 `AskUserQuestion` 让用户选择发布模式：

- **无头模式**（推荐）：后台运行，速度快，无浏览器窗口。发布完成后直接报告结果。
- **有窗口模式**：显示浏览器窗口，可以预览内容。需要用户确认后再点击发布。

```
AskUserQuestion 示例：
问题：选择发布模式
选项：
  - 无头模式（推荐）：后台快速发布，无需预览
  - 有窗口模式：显示浏览器，可预览确认
```

### 4.4 写入临时文件

将标题和正文写入临时 UTF-8 文本文件。不要在 `python -c` 中内联中文文本。

### 4.5 运行发布（根据模式分流）

#### A. 上传图文模式（默认）

根据用户选择的模式执行发布脚本：

**无头模式**（添加 `--headless` 参数）：
```bash
python "scripts\publish_pipeline.py" --headless --title-file title.txt --content-file content.txt --image-urls "URL1" "URL2"
```

**有窗口模式**（不添加 `--headless`）：
```bash
python "scripts\publish_pipeline.py" --title-file title.txt --content-file content.txt --image-urls "URL1" "URL2"
```

**其他参数**：
```bash
# 发布到指定账号
python ... --account myaccount ...

# 使用本地图片
python ... --images "C:\path\to\image.jpg"
```

处理输出：
- `NOT_LOGGED_IN` (exit code 1) → 脚本自动切换到有窗口模式，提示用户扫码登录，确认后重新运行
- `READY_TO_PUBLISH` (exit code 0) → 根据模式进入下一步
- Exit code 2 → 报告错误

#### B. 写长文模式

**Step B.1 — 填写长文内容 + 一键排版：**

```bash
python "scripts\cdp_publish.py" long-article --title-file title.txt --content-file content.txt
```

图片插入有两种方式：

- `--images img1.jpg img2.jpg`：简单把图片**全部追加到正文末尾**。
- `--placements placements.json`：按**正文图片占位符**把图片插到对应文字段后（**推荐**，图文位置对齐）。

`placements.json` 格式（`where` 可选 `top`/`before`/`after`，`anchor` 为目标段落里的一小段文字）：

```json
[
  {"path": "images/02-content-1.png", "anchor": "谁该重启", "where": "after"},
  {"path": "images/03-content-2.png", "anchor": "定目标，别管过程", "where": "after"}
]
```

> **封面图不要放进正文**。小红书长文的封面是在「一键排版」页单独上传的（见 Step B.3a），正文 `placements` 里只放正文配图。

输出中包含 `TEMPLATES: [...]` JSON 数组，为可用的排版模板名称列表。

**Step B.2 — 让用户选择模板：**

使用 `AskUserQuestion` 将模板名称作为选项展示给用户选择（从 TEMPLATES 输出中解析）。

**Step B.3 — 选择模板：**

```bash
python "scripts\cdp_publish.py" select-template --name "用户选择的模板名"
```

**Step B.3a — 上传自定义封面（可选）：**

封面入口在「一键排版」页**最左侧第一页预览**上：鼠标悬停会浮出两个按钮「Ai 换配图」和「从本地上传」。脚本已封装该流程：

```bash
python "scripts\cdp_publish.py" upload-cover --cover images/01-cover.png
```

成功输出 `COVER_UPLOADED`。若不上传自定义封面，平台会用正文图自动生成「有图封面1/2」或「无图封面」，可在右侧「封面设置」里选。

**Step B.4 — 点击下一步并填写发布页正文描述：**

```bash
python "scripts\cdp_publish.py" click-next-step --content-file content.txt
```

注意：发布页有独立的正文描述编辑器，必须通过 `--content` 或 `--content-file` 传入内容填写。
图文格式的正文内容不超过 1000 个字符（含空格和标点），超出则精简到 1000 字符以内，保持语义完整。

**Step B.5 — 用户预览确认并发布：** 进入下方 4.5 步骤。

### 4.5 用户预览确认（仅有窗口模式 / 长文模式）

**仅当用户选择有窗口模式或使用长文模式时**，使用 `AskUserQuestion` 请用户在浏览器中检查预览，确认后再发布。

无头模式的图文发布跳过此步骤，直接进入 4.6。

### 4.6 设置定时（可选）

在点击发布前，若用户选择了定时发布：

```bash
# 仅设置定时
python "scripts\cdp_publish.py" set-schedule --schedule "2026-06-13 20:00"

# 或在与 click-publish 合并执行
python "scripts\cdp_publish.py" click-publish --schedule "2026-06-13 20:00"
```

也可通过 `publish-options.json` 或 `--options` 传入：

```bash
python "scripts\publish_pipeline.py" --options publish-options.json --auto-publish ...
```

### 4.7 点击发布

点击发布按钮：

```bash
python "scripts\cdp_publish.py" click-publish
# 定时发布
python "scripts\cdp_publish.py" click-publish --schedule "2026-06-13 20:00"
```

### 4.8 报告结果

根据命令输出告知用户发布是否成功。

## 重要提示

- **绝不自动发布** - 必须获得用户确认
- **定时发布** - 推荐时段用 `schedule_advisor.py`；执行用 `--schedule` 或 `publish-options.json`
- **定时格式** - `YYYY-MM-DD HH:MM`（24 小时制）
- **图片要求** - 上传图文模式必须有图片；写长文模式图片可选
- **长文图文对齐** - 正文配图优先用 `--placements`（按占位符插入），不要用 `--images` 全堆在末尾
- **长文封面** - 封面单独上传，不放进正文；用 `upload-cover` 命令（悬停第一页 → 从本地上传）
- **长文模式** - 必须让用户选择模板，不要自动选择
- **正文描述** - 图文格式正文内容不超过 1000 个字符（含空格和标点），超出则精简到 1000 字符以内
- **系列标题** - 系列文章按 `序号：标题` 格式命名，整条 ≤20 字
- **正文结构** - 图文正文必须结构化：短段 + emoji 图标 + ✔️/▸ 标记，适合收藏快速阅读
- **笔记风格配图** - 知识干货/教程系列（如 K8S）优先使用笔记风格生图：方格笔记本纸背景 + 手写笔触 + 彩色荧光标记 + 箭头标注 + 简笔画图表，专业术语保留英文其余用中文
- **无头模式**：使用 `--headless` 参数自动化发布。如需登录，脚本自动切换到有窗口模式
- 如果页面结构变化导致选择器失效，参考 `references/publish-workflow.md` 更新

## 账号管理

系统支持多个小红书账号，每个账号有独立的 Chrome profile。

### 列出账号

```bash
python "scripts\cdp_publish.py" list-accounts
```

### 添加账号

```bash
python "scripts\cdp_publish.py" add-account myaccount --alias "我的账号"
```

### 登录

```bash
# 默认账号
python "scripts\cdp_publish.py" login

# 指定账号
python "scripts\cdp_publish.py" --account myaccount login
```

### 切换账号

```bash
python "scripts\cdp_publish.py" switch-account
python "scripts\cdp_publish.py" --account otheraccount switch-account
```

### 设置默认账号

```bash
python "scripts\cdp_publish.py" set-default-account myaccount
```
