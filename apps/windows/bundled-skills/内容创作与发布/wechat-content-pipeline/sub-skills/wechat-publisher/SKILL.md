---
name: wechat-publisher
description: |
  把 Markdown 文章发布到微信公众号草稿箱。纯 Python 实现,零第三方依赖,
  只调用微信官方 API(token / uploadimg / add_material / draft/add)。
  自带 markdown→公众号内联样式HTML 渲染器(标题/段落/加粗/引用/列表/代码块/图片/表格),
  自动上传正文图片和封面(支持 png/jpg/gif),最终存入草稿箱(绝不群发)。
  使用场景:用户要"发布公众号/存草稿/post to wechat",且已有 AppID+AppSecret+IP白名单。
type: tool
version: 1.0.0
tags:
  - wechat
  - publishing
  - markdown
  - official-account
required_env:
  - WECHAT_APP_ID
  - WECHAT_APP_SECRET
---

# WeChat Publisher · 公众号草稿发布

## 一、为什么自写而非用现成技能

社区的 baoyu-post-to-wechat 安全性没问题,但其 GitHub 脚本依赖**未发布到 npm 的新版 baoyu-md**,实测装到的 0.1.0 缺关键导出(`preprocessMermaidInMarkdown` 等),API 渲染走不通。故自写这个零依赖版本,只用微信官方 API,可控、可审。

## 二、前置条件

1. **AppID + AppSecret**:公众号后台「设置与开发→基本配置」。写入技能包根目录 `wechat-makeup/.env`(脚本自动加载),**不要硬编码**。
2. **IP 白名单**:同页「IP白名单」,加入你的**出口公网 IP**。
3. Python 3(标准库即可,无需 pip 安装任何包)。

## 三、用法

```bash
# 凭证写在 wechat-makeup/.env(WECHAT_APP_ID / WECHAT_APP_SECRET),脚本自动加载
python scripts/publish.py <article.md>
```

`<article.md>` 需含 frontmatter:

```markdown
---
title: 文章标题
author: 作者名/公众号名
summary: 摘要(≤120字,显示在转发卡片)
cover: images/01-cover.png    # 封面相对路径(news类型必需)
---

正文 markdown...
```

图片用相对路径(相对 md 文件所在目录),脚本自动上传换成微信 URL。

## 四、支持的 markdown 语法

| 语法 | 渲染为 |
|------|--------|
| `## ` / `### ` | 橙色侧边线标题 / 小标题 |
| `**加粗**` | 深蓝加粗 |
| `> 引用` | 浅灰底+橙色左边框引用块 |
| ` ```代码``` ` | 暗色代码块 |
| `![](path)` | 上传图片并内联(png/jpg/gif) |
| `- ` / `1. ` | 无序/有序列表 |
| `\| 表格 \|` | 带表头样式的表格 |
| `---` | 分隔线 |

样式全部内联(公众号会过滤 class 和外部 CSS),品牌色:深蓝 #1a3a5c / 橙 #ff6b35。

## 五、关键避坑(实测)

1. **GIF 可用**:微信 uploadimg 接受 gif,草稿里能动播放。但抖音不行(那是另一回事)。
2. **IP 白名单最易踩**:
   - 报错 `errcode 40164 invalid ip X.X.X.X not in whitelist` → 把报错里那个 IP 加进白名单。
   - **以微信报错里的 IP 为准**,不要信本地 `ipify` 探测——出口线路可能和探测线路不同(实测探测是 138.x,真实发请求走 117.x)。
   - 白名单保存后有**几分钟生效延迟**,加完等 3-5 分钟再试。
   - 动态宽带 IP 会变,频繁变就改用固定 IP 服务器中转(SSH 隧道,见"六")。
3. **只存草稿**:脚本调 `draft/add`,带 `need_open_comment=1`。**不会群发**,需登录后台人工审核后再发。
4. **控制台编码**:Windows GBK 控制台对 ✓ 等字符会报错,脚本输出已改用 [OK]/[FAIL] 纯 ASCII。

## 六、IP 不稳定时:服务器中转(可选)

若本机出口 IP 经常变,而你有固定公网 IP 的服务器:
- 白名单加服务器 IP
- 把 publish.py 拷到服务器跑,或本地渲染、仅最后的 HTTPS 调用经 SSH 隧道(`ssh -N -D`)从服务器出口
- AppSecret 不离开你掌控的机器

## 七、安全

- 凭证从 `wechat-makeup/.env` 读(或系统环境变量),不写入代码/日志;`.env` 已被 gitignore 忽略
- 全部网络请求目标硬编码为 `api.weixin.qq.com`,无任何第三方外联
- 建议:AppSecret 若曾在不可控渠道出现过,用后到后台重置

## 八、与其他技能协作

| 上游 | 衔接 |
|------|------|
| article-writing-pipeline | 产出 final.md → 生成带 frontmatter 的 publish.md → 本技能发布 |
| cloakbrowser-scraper | 产出封面/信息图/成果GIF → 放进 images/ → 本技能上传 |

**publish.md 生成要点**:从 final.md 去掉 mermaid 代码块和 `<!-- IMAGE -->` 注释、去掉首个 H1(标题进 frontmatter),加 frontmatter。

## 九、版本历史

- v1.0.0 (2026-05-31):初版。零依赖 Python 实现,实测发布第01篇成功(封面+架构图+2个GIF)。
