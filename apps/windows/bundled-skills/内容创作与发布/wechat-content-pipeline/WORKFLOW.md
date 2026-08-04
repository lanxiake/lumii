# 端到端工作流 SOP（照这个就能复现整套创作）

> 从「一句话主题」到「公众号草稿」的完整流程。每步给出实际命令，新环境照做即可。
> 配合 `SETUP.md`（环境）和 `wechat-makeup/*/SKILL.md`（各技能细节）使用。

---

## 全景流程

```
主题 → ①研究 → ②大纲(8段式) → ③写作 → ④配图(分层) → ⑤生成publish.md → ⑥发布草稿 → 人工审核推送
```

各阶段细节见 `wechat-makeup/sub-skills/article-writing-pipeline/SKILL.md`。本文件聚焦**可操作命令**。

---

## ① 研究（可选）

参考同主题高浏览量爆款，学其标题/叙事/配图思想（不照搬）。抓竞品文：

```bash
python wechat-makeup/sub-skills/cloakbrowser-scraper/scripts/scrape.py "<公众号文章URL>" --out-dir ref_x
# 正文在 ref_x/body.txt，图片URL在 ref_x/meta.json
```

---

## ② + ③ 大纲与写作

- 遵循大纲 `../00-series-outline.md` 的篇目规划和 8 段式骨架。
- 写作铁律、术语类比库、叙事进阶规则、内容深度标准，全在 `wechat-makeup/sub-skills/article-writing-pipeline/SKILL.md`。
- 产出 `articles/<日期-slug>/final.md`（带 `<!-- IMAGE:xx -->` 占位标记）。

**核心要点速记**：
- 8段式：共鸣→你能学到→理论(够用)→实操(给可复制提示词)→成果(看得见)→避坑→小结→预告互动
- 叙事：标题要狠、开篇场景化/数字背书、掺真实翻车细节、金句收尾
- 类比库：前端=脸面/后端=大脑/数据库=记忆(寄快递)、API=服务员、终端=和电脑打字聊天
- 深度：适度真术语(AI幻觉/提示词)+重类比、每篇沉淀一个方法论矩阵

---

## ④ 配图（分层策略）

**先想清"这张图要让读者一眼 get 什么"，再选类型。高级≠刷黑底，靠信息分层+结构表意+视觉引导。**

### 4a. 封面 / 信息图 → gpt-image-2-pro（首选，最美观）

**配图默认走 GPT 生图**，最美观高效。封面、插画、概念图、无中文/纯英文信息图都先用它。实测 gpt-image-2-pro **中文已基本可用**。用 chat completions 接口生成。
- 封面：专业科技/科幻/商务风，每篇换主色调+视觉隐喻，无卡通萌系
- 信息图：PPT 风，SVG/line icon（**不用 Emoji**），流程图/矩阵/卡片，霓虹描边玻璃质感
- **每张必人工核验中文**，错了或 504 就重试（3-5次）；中文反复出乱再退回 4b 的 HTML

推荐直接用脚本（凭证自动读 `.env` 的 `LLM_LINK_API_KEY`，提示词写进 prompts.md）：
```bash
cd wechat-makeup
python sub-skills/article-writing-pipeline/scripts/generate_image.py \
  --prompt-file <文章目录>/images/prompts.md --section cover \
  --output <文章目录>/images/01-cover.png --size 1536x1024
```

### 4b. 信息图 → HTML 兜底（仅在 GPT 表达不好时用）

**只有这三类才退回 HTML**：① 文字必须分毫不差的中文信息图/架构图（gpt 反复乱码）；② 需精确控制的结构图（矩阵/带标注界面）；③ 图片难以表达需手工绘制。其余一律优先 GPT。
```bash
# 模板在 wechat-makeup/sub-skills/cloakbrowser-scraper/templates/ :
#   dark-infographic.html(黑底高级) infographic.html(白底手绘) terminal.html(终端) ai-chat.html(对话) firework.html(动效)
python wechat-makeup/sub-skills/cloakbrowser-scraper/scripts/screenshot.py <改好的html> images/xx.png .wrap 2800 800 760
```

### 4c. 动态对比/演示 → GIF（gpt 做不了的）

```bash
python wechat-makeup/sub-skills/cloakbrowser-scraper/scripts/html_to_gif.py <动画html> images/xx.gif 30 280 720 400
```

### 4d. 真实运行成果 → 截真页面（绝不AI编）

```bash
python wechat-makeup/sub-skills/cloakbrowser-scraper/scripts/screenshot.py <本地html或URL> images/xx.png
```

---

## ⑤ 生成 publish.md（发布用）

从 final.md 派生：去 mermaid 代码块、去 `<!-- -->` 注释、去首个 H1（标题进 frontmatter），加 frontmatter。

```python
import re
src=open('final.md',encoding='utf-8').read().splitlines()
out=[];in_m=in_c=False
for ln in src:
    s=ln.strip()
    if s.startswith('<!--'):in_c=True
    if in_c:
        if '-->' in s:in_c=False
        continue
    if s.startswith('```mermaid'):in_m=True;continue
    if in_m:
        if s.startswith('```'):in_m=False
        continue
    out.append(ln)
body='\n'.join(out)
body=re.sub(r'^#\s+.*\n','',body,count=1)
body=re.sub(r'(^>.*\n)+','',body,count=1)
fm='---\ntitle: <标题>\nauthor: <公众号名>\nsummary: <≤120字摘要>\ncover: images/01-cover.png\n---\n\n'
open('publish.md','w',encoding='utf-8').write(fm+body.strip()+'\n')
```

---

## ⑥ 发布到草稿箱

```bash
cd articles/<日期-slug>
# 凭证自动从 wechat-makeup/.env 读取（WECHAT_APP_ID / WECHAT_APP_SECRET）
python <path>/wechat-makeup/sub-skills/wechat-publisher/scripts/publish.py publish.md
# 输出 [OK] 草稿已保存! media_id=... 即成功
# 登录 mp.weixin.qq.com → 内容管理 → 草稿箱 人工审核后再推送(脚本只存草稿,不群发)
```

**更新已发草稿**：脚本每次发布是新增草稿，要更新就先删旧的：
```python
# draft/delete 接口，传旧 media_id
```

---

## 实战避坑总表

| 现象 | 原因 / 解法 |
|------|------------|
| 微信抓取/发布 403 / "环境异常" | 用 cloakbrowser（穿透反爬），不用普通 requests |
| 发布 `errcode 40164 invalid ip` | 把报错里那个 IP 加白名单，等几分钟生效 |
| gpt 生图 504 | 上游超时，重试 3-5 次 |
| gpt 生图中文乱码 | 重生成；仍乱就退回 HTML 截图 |
| 控制台中文乱码/UnicodeEncodeError | Windows GBK 问题，脚本输出用纯 ASCII，文件一律 utf-8，不往 stdout 打印中文正文 |
| Python 路径 `/c/...` 找不到 | Windows 下 Python 不认 bash 路径，用 `C:\...` 或 `os.path.expandvars` |
| GIF 帧数比设定少 | Pillow optimize 去重静态帧，正常 |

---

## 已有样板（直接参考）

各系列的 `data/<系列名>/samples/` 下保留了完整成品样板，含正文结构与配图套路，是本套流程的活样板。新写文章时，照样板的结构和配图思路复制即可。

> 注：`articles/` 默认为空（每次新写的文章产出在这里），样板统一放在 `samples/`。
