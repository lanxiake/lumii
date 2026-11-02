# 检测规则怎么写

目标：**这条规则能抓住 Finding 里的真实 payload，且不淹没在误报里**。

一条 Finding 通常要写两类：**静态**（扫代码，防同类再犯）与**运行时**（扫日志/请求，防线上再发生）。
两类都写不起就至少写一类，并在 VERIFY.md 里说明为什么缺另一类。

---

## 1. 静态规则：Semgrep

### 基本形

```yaml
# security/rules/no-raw-html.yml
rules:
  - id: no-unencoded-html-render
    message: 用户输入直接进 innerHTML，可能导致 XSS
    severity: ERROR
    languages: [typescript, javascript]
    # 用元变量 $X 匹配任意表达式
    pattern-either:
      - pattern: $EL.innerHTML = $X
      - pattern: $EL.insertAdjacentHTML($POS, $X)
      - pattern: <div dangerouslySetInnerHTML={{__html: $X}} />
    # 排除已经过编码的情况：值本身来自这些函数就不报
    pattern-not: $EL.innerHTML = DOMPurify.sanitize($X)
```

### 三条写法要点（决定规则是否可用）

1. **`pattern-not` 决定可用性**。只写 `pattern` 会报出所有合法调用，团队会直接关掉它。
   把「已经安全」的写法排除掉，规则才有机会活下去。
2. **`metavariable-regex` 做细化**。比如只想抓拼接：
   ```yaml
   pattern: $EL.innerHTML = $A + $B
   ```
3. **`paths.exclude` 别漏**。测试夹具、mock 数据里的 payload 会污染结果。

### 跑它

```bash
npx --yes semgrep --config security/rules/<name>.yml --error .   # 有命中即非零退出
```

本机没装 semgrep 时：**报「需要 semgrep，未运行」**，并把手写的 grep 判据贴进 VERIFY.md
（例如 `grep -rn 'innerHTML =' app/` 的输出），标明它比 semgrep 弱在哪。

---

## 2. 运行时规则：Sigma

```yaml
# security/rules/xss-comment-post.yml
title: 评论接口收到含脚本的正文
id: 3f2a-...
status: experimental
logsource:
  product: webapp
  service: http-access
detection:
  sel_path:
    url.path|startswith: '/api/comments'
  sel_method:
    http.request.method: POST
  sel_payload:
    http.request.body|contains:
      - '<script'
      - 'onerror='
      - 'javascript:'
  condition: sel_path and sel_method and sel_payload
falsepositives:
  - 富文本编辑器正常提交（应先经过白名单过滤再入库）
level: medium
```

写法要点：

1. **`contains` 用真实 payload 里出现过的字符串**，别用抽象描述。
2. **`falsepositives` 必须写**——不写就是「这条规则上线就会被关掉」。
3. 有合法业务会命中时，加 `filter_` 段排掉它，而不是放宽 `sel_payload`。

本机没有日志平台时：**规则照写，VERIFY.md 里标明「未在真实日志上验证」**，
用原始请求文本做一次手工匹配来证明判据成立。

---

## 3. 复跑验证怎么做（这是蓝队的验收）

**对原始 payload**：把 Finding 里的攻击输入，喂给规则（semgrep 扫一个最小样例文件 /
把请求文本按 Sigma 的字段名摆好，手工走一遍 `detection` 的布尔表达式）。

- 命中 ⇒ `CAUGHT`
- 不命中 ⇒ `NOT_CAUGHT`，然后**写清为什么**：判据写窄了？匹配的字段名不对？编码规避？

**对修复后的代码**：改完之后再跑一次，应该 `无命中`。
有命中说明补丁没覆盖全，或规则本身写宽了。

**两条都要做。** 只做第一条，规则可能是「对着这一个字符串硬编码的」。

---

## 4. 加固补丁怎么写

不要写「加强校验」。写**可以粘贴的改动**：

```markdown
### security/hardening/no-raw-html-patch.md

**位置**：`app/comments/page.tsx:42`

before:
```tsx
<div dangerouslySetInnerHTML={{ __html: comment.body }} />
```

after:
```tsx
import DOMPurify from 'isomorphic-dompurify'
<div dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(comment.body) }} />
```

**为什么不只是这一处**：全仓还有 2 处同样的写法（`app/profile/page.tsx:18`、
`components/Bio.tsx:9`），一并改，否则规则会把它们全报出来。
```

**「同类还有几处」用 `grep` 找全**，这是加固最容易漏的地方——
只修 Finding 点名的那个文件，等于承认其余几处继续存在。
