---
name: blueteam
description: 把红队 Findings（或人工写的漏洞描述）转成可执行的检测规则与加固补丁，并复跑验证「这条规则真的抓得住」。用于安全自查后的修复与回归、给已有漏洞补检测。产出是防御资产（规则 + 补丁 + 验证结果），不产出攻击工具。不含找洞（用 redteam）与纯逆向（用 reverse）。
metadata: { "mtbot": { "emoji": "🔵" } }
activation_scope: on_demand
---

# 蓝队：把 Findings 变成能抓住它的规则

## 什么时候不该用它

- 还没找到洞——先 `/redteam`。
- 只是想理解代码——用 `reverse`。
- 想要「绕过检测的方法」——不做。这条能力的方向是**让检测生效**，不是让绕过成立。

## 交给 `security` Agent 跑（有的话）

如果你的运行时里存在 `security`（灵栖安全）这个 Agent，红队与蓝队整条链都交给它：

```
spawn_agent({ agentType: "security", mode: "sync", prompt: "<Findings 路径与目标>" })
```

它按需加载、不进团队列表（避免被自动路由），所以只能显式用这个 id 调用。
没有它时按本文件做，结论一样有效。

## 输入是什么

三种都行，**不要求上游是红队**：

| 输入 | 例子 |
|---|---|
| `security/findings/F-*.md`（红队产出） | 本仓库标准格式 |
| 人工写的一段描述 | 「我们的搜索接口有存储型 XSS，用户输入直接进了 innerHTML」 |
| 扫描器报告 | 贴关键几行就行 |

**输入不完整就按不完整做**：缺复现步骤的，先自己补一次复现；补不出来就在产物里写
`UNVERIFIED`，不要假装它是有效的。

## 四步

1. **读 Finding，抽三样**：**触发特征**（什么样的输入/请求）、**落点**（哪段代码）、**影响**。
   缺一样就先补，补不出就写 `UNRESOLVED`。
2. **写检测规则** —— 按 [`references/detection-rules.md`](references/detection-rules.md)。
   一条 Finding 通常产出**两类**规则：静态的（代码层，Semgrep 类）+ 运行时的（日志/请求层，Sigma 类）。
3. **写加固补丁** —— 按 [`references/hardening-checklist.md`](references/hardening-checklist.md)
   对照，给出**具体到文件与行**的改法，不是「加强输入校验」这种话。
4. **复跑验证** —— 这是蓝队的验收标准（见下）。

## 验证：每条规则都要有 CAUGHT / NOT_CAUGHT

`security/rules/VERIFY.md`：

```markdown
| 规则 | 对应 Finding | 对着原始 payload 跑 | 对着修复后的代码跑 | 结论 |
|---|---|---|---|---|
| R-01 semgrep: dangerouslySetInnerHTML 未编码 | F-01 | **CAUGHT** | 无命中 | 有效 |
| R-02 sigma: 评论接口含 <script 的 POST | F-01 | **CAUGHT** | 无命中 | 有效 |
| R-03 semgrep: 图片上传未校验 magic bytes | F-02 | **NOT_CAUGHT** | —— | **规则没写对，见下** |
```

**`NOT_CAUGHT` 不是失败，是信息。** 它说明这条规则抓不住真实的攻击形态——
必须写清为什么没抓住、下一版怎么改。**不许为了让表格好看把它改成 CAUGHT。**

「对着修复后的代码跑」那一列跑不了时（比如运行时规则没法在这台机器复现），
写 `UNRUNNABLE + 原因`，不要留空。

## 边界的正面表述

| 不做 | 做 |
|---|---|
| 写「如何绕过这条规则」 | 写「这条规则覆盖了哪些变体，没覆盖哪些」 |
| 产出免杀/混淆后的 payload | 用原始 payload 证明规则能抓到 |
| 只给「建议加强校验」 | 给出可粘贴的代码改动 |

## 产物

```
<target>/security/
  rules/
    <name>.yml            # Semgrep / Sigma 规则
    VERIFY.md             # 上面那张表
  hardening/
    <file>-patch.md       # 逐文件改动说明（含 before/after）
  findings/               # 输入，不改动
```

收尾报一句：`N 条规则，CAUGHT a / NOT_CAUGHT b（b 条都写了原因），加固建议 c 处`。

## 工具的用法

| 目的 | 工具 | 注意 |
|---|---|---|
| 定位落点 | `grep` / `file_read` | 必须给到文件与行号 |
| 全仓找同类 | `grep` | **同一模式往往不止一处**，找全了再写规则 |
| 验证修复 | `bash`（跑测试/构建） | 补丁必须能过构建 |
| 复跑红队 | 引导用户 `/redteam` 再打一次 | 蓝队自己不发起攻击 |

**「同类还有几处」是这一步最容易被跳过、也最有价值的检查**：
一个 `dangerouslySetInnerHTML` 有洞，通常意味着仓库里还有别的。规则的价值在于覆盖全部。
