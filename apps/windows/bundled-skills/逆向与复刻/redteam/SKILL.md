---
name: redteam
description: 对**你自己拥有或已获授权**的 Web 应用做安全验证，找出可复现的漏洞并写成 Findings。用于上线前自测、验证加固是否生效、复刻/自建产物的安全检查。只产出 Findings 报告（洞在哪、怎么复现），不做免杀 payload、不写 C2、不产出可直接分发的 exploit。不含网页复刻（用 clone）与纯逆向分析（用 reverse）。
metadata: { "mtbot": { "emoji": "🛡️" } }
activation_scope: on_demand
---

# 红队：验证自有目标的安全性

## 第一步永远是确认授权（不接受跳过）

动手之前必须能回答：**这个目标是你的吗？**

| 情况 | 怎么办 |
|---|---|
| 我自己写的 / 我刚复刻的 / 公司内部系统且有书面授权 | 继续，把依据写进 `security/scope.md` |
| 第三方站点或别人的产品 | **停**。引导用户改走两条路：① 用 `clone` 做**公开信息**层面的观察；② 拿到书面授权后再来，并把授权范围写进 scope.md |
| 不确定 | 按「不是你的」处理 |

`security/scope.md` 至少写四行：

```markdown
target: http://localhost:3000
ownership: self-built (projects/qx) / 授权编号 ...
window: 2026-11-02 20:00 ~ 23:00
out-of-scope: 支付网关、第三方登录回调
```

**没写 ownership 就不开局。** 这不是流程洁癖——它是这条能力唯一的分界线。

## 什么时候不该用它

- 目标在跑，但你不知道它是谁的——先问，别先扫。
- 只想看懂实现——用 `reverse`。
- 想重建一个页面——用 `clone`。
- 想「找一个能打的站点练手」——不做。这是给别人添麻烦，不是验证。

## 五步

1. **定范围** —— 写 `security/scope.md`：目标、归属、时间窗、明确排除项（第三方依赖、支付、短信）。
2. **摸面** —— 先做**只读**的结构观察：有哪些路由、表单、鉴权边界、上传点、参数。用 `browser_navigate` +
   `browser_snapshot` + `browser_requests` 看真实请求，不用端口扫描器。
3. **逐类验证** —— 按 [`references/attack-playbook.md`](references/attack-playbook.md) 一节一节过，
   **每类都要问「我这个功能有没有」**，没有就记「不适用 + 为什么」，不要跳。
4. **写成 Finding** —— 每个洞一份，格式固定（见下）。**复现不出来的一律不写**。
5. **交回蓝队** —— Findings 落 `security/findings/`，`/blueteam` 吃它产出规则与加固。

## Finding 的格式（不按这个写就不算完成）

`security/findings/F-<序号>-<短名>.md`：

```markdown
# F-01 留言板存储型 XSS

- **位置**：POST /api/comments → 渲染在 /comments 页
- **影响**：任意访客可执行脚本，可窃取同源 cookie / 以访客身份发起请求
- **前提**：仅需已登录的普通账号（无需管理员）
- **复现**（可直接照做，含完整输入）
  1. 以 alice 登录
  2. 提交评论正文：`<img src=x onerror="alert(document.domain)">`
  3. 打开 /comments，脚本执行
- **证据**：`evidence/F-01-request.txt`（原始请求与响应）、`evidence/F-01-render.png`
- **根因**：`app/comments/page.tsx:42` 用 `dangerouslySetInnerHTML` 直接渲染未过滤内容
- **建议方向**：输出编码（交给 blueteam 定具体规则）
```

三条硬要求：

1. **每条都要有证据文件**。截图或原始请求响应，落 `security/evidence/`。
2. **只说复现出来的**。理论可能性写进「未验证的怀疑」小节，明确标注未复现。
3. **不写利用链**。一条 Finding 说清一个洞就够；把它们串成完整攻击链**不做**——
   那不是「验证我的防御」需要的，只会让这份报告变成别的东西。

## 边界的正面表述

| 不做 | 做 |
|---|---|
| 生成免杀 payload / 绕过 EDR | 验证「我的检测规则能不能抓到这种手法」 |
| 写 C2、做持久化 | 检查「我的凭据存储有没有明文」 |
| 产出可直接分发的 exploit 二进制 | 写清楚「怎么手工复现」，让开发者自己修 |
| 打第三方目标 | 打自己刚复刻/自建的东西 |

**这是自律约束，不是技术强制。** 但它是这条能力能不能存在的前提。

## 工具的用法

| 目的 | 工具 | 注意 |
|---|---|---|
| 打开目标 | `browser_navigate` | 先确认能访问，非 200 就停 |
| 看结构 | `browser_snapshot` | 拿可交互元素的 ref |
| 填表单 / 点击 | `browser_type` / `browser_click` | 用真实浏览器路径，别手搓请求 |
| 看请求 | `browser_requests` | 过滤是 URL 子串 |
| 读响应 | `browser_response_body` | 只看调用之后的响应 |
| 构造特殊输入 | `browser_eval` | 优先用页面自己的能力（fetch + 已登录态） |
| 读源码定位根因 | `grep` / `file_read` | 有源码时**必须**定位到文件行号 |

**不用端口扫描器、不做大规模爆破。** 验证一个洞不需要打一万次请求——
真要证明「限流没生效」，构造 5-10 次就够，并且写清次数。

## 产物

```
<target>/security/
  scope.md              # 归属与范围（没这个就不开工）
  findings/F-*.md       # 每个洞一份
  evidence/             # 截图与原始请求响应
```

`<target>` 是项目根（如 `projects/qx`）。目标不是本地项目时用 `projects/_redteam/<slug>/security/`。

**收尾必须写一句总数**：`N 个 Finding（高危 a / 中危 b / 低危 c），M 类不适用`。
