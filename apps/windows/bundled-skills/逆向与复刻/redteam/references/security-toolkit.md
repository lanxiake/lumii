# 安全测试工具与知识库索引

**索引不是装工具清单**。每条都标了本机有没有——没有的写清手工替代路径，
因为下面绝大多数工作**不需要那些工具**也能完成（`browser_eval` + 真实登录态就够）。

本机实测基线（2026-11-03）：**除浏览器自带 DevTools 外，没有任何安全工具**——
nmap / nuclei / ffuf / sqlmap / nikto / hydra / hashcat / semgrep / trivy 全未安装。

这不是障碍。见 §1 的判据。

---

## 1. 先问：这个工具真的能帮我吗

按价值排序，**从下往上才是对的顺序**：

| 层次 | 手段 | 能发现什么 | 本机 |
|---|---|---|---|
| 4 | 手动业务分析 | 业务逻辑、越权、状态机、资金 | ✅ 只需要浏览器 |
| 3 | 手工重放与构造 | 认证绕过、IDOR、注入 | ✅ `browser_eval` |
| 2 | 静态代码审计 | 硬编码凭据、危险调用、依赖 | ✅ `grep` + `file_read` |
| 1 | 自动化扫描器 | 已知 CVE、常见配置错误 | ❌ 本机没有 |

**扫描器排在最后不是因为它弱，是因为它只能发现「别人也遇到过的问题」。**
自有系统的真正风险几乎都在第 3、4 层——那里没有现成工具能替你判断。

---

## 2. 侦察与枚举

| 工具 | 用途 | 本机 | 手工替代 |
|---|---|---|---|
| ffuf / gobuster / feroxbuster | 目录与端点枚举 | ❌ | `browser_eval` 里 `Promise.all` 并发试；**只打 scope 内目标** |
| nuclei | 基于模板的已知漏洞扫描 | ❌ | 按 playbook §13 的表逐项试 |
| nmap | 端口与服务识别 | ❌ | 只测 scope 声明的端口；`browser_eval` 试 `fetch('http://host:port')` 看连通 |
| whatweb / wappalyzer | 指纹识别 | ❌ | 看响应头、`/_next/`、`/wp-content/`、favicon hash |
| subfinder / amass | 子域枚举 | ❌ | 证书透明度日志（crt.sh）、DNS 记录 |

**这些工具的诱惑在于「扫一下就有结果」。** 但对着自有系统扫出来的，九成是你已经知道的
配置问题；真正值钱的是手工分析业务。

---

## 3. Web 漏洞验证

| 工具 | 用途 | 本机 | 手工替代 |
|---|---|---|---|
| sqlmap | SQL 注入自动化 | ❌ | playbook §6：报错 / 布尔 / 时间差，三种判据手工试 |
| Burp Suite | 拦截改包、重放、扫描 | ❌ | DevTools 的 Network → 右键 Replay；或 `browser_eval` fetch |
| XSStrike | XSS payload 生成 | ❌ | playbook §1 的几种 payload 手写即可 |
| jwt_tool | JWT 分析 | ❌ | 手工 base64 解 + playbook §12 的六种手法 |
| hashcat / john | 令牌与哈希破解 | ❌ | 手工试常见弱密钥（`secret`/`changeme`/应用名） |

**`browser_eval` 是被低估的**：它在**真实页面**里执行，带着真实登录态与同源上下文，
比外部工具更接近攻击者的真实条件。并发、重放、改参数都能做：

```js
// 并发 10 次同一请求（测竞态/限流）
await Promise.all([...Array(10)].map(() => fetch('/api/coupon/claim', {method:'POST'})))
```

---

## 4. 代码与依赖审计

| 工具 | 用途 | 本机 | 手工替代 |
|---|---|---|---|
| semgrep | 静态规则扫描 | ❌ | `grep` 按 playbook 的危险模式找；**blue team 的规则就是这么写的** |
| trivy / grype | 依赖与镜像漏洞 | ❌ | `npm audit` / `pnpm audit` |
| gitleaks / trufflehog | 硬编码凭据 | ❌ | `grep -rE '(api[_-]?key|secret|password|token)\s*[:=]'` |
| ESLint security 插件 | 前端危险调用 | 部分 | `grep -rn 'dangerouslySetInnerHTML\|innerHTML =\|eval('` |

**`grep` 在这里不是将就**：自有代码库你比任何扫描器都了解，
知道该搜什么比让它全量扫一遍更有用。blue team 写的 Semgrep 规则本质也是模式匹配。

---

## 5. 知识库（遇到不懂的先去这里）

| 主题 | 链接 | 什么时候看 |
|---|---|---|
| **OWASP WSTG** | [owasp.org/www-project-web-security-testing-guide](https://owasp.org/www-project-web-security-testing-guide/) | **权威测试清单**，§10–§16 的每一类它都有更细的版本 |
| **PortSwigger Web Security Academy** | [portswigger.net/web-security](https://portswigger.net/web-security) | 免费 + 带可实操的靶场。业务逻辑与提权讲得最好 |
| OWASP Top 10 | [owasp.org/Top10](https://owasp.org/Top10/) | 需要「这属于哪一类」时 |
| OWASP Cheat Sheets | [cheatsheetseries.owasp.org](https://cheatsheetseries.owasp.org/) | **写加固建议时**——别自己发明，抄官方 |
| HackTricks | [book.hacktricks.wiki](https://book.hacktricks.wiki/) | 具体手法想不起来时的速查 |
| PayloadsAllTheThings | [github.com/swisskyrepo/PayloadsAllTheThings](https://github.com/swisskyrepo/PayloadsAllTheThings) | payload 形态参考（**只用于验证，不用于批量投放**） |
| JWT 攻击 | [PortSwigger — JWT](https://portswigger.net/web-security/jwt) | 令牌类发现 |
| CVE 数据库 | [nvd.nist.gov](https://nvd.nist.gov/) | 确认某个依赖版本是否真受影响 |

**引用时写清出处**：报告里写「按 OWASP WSTG §4.5 判定」比「我认为这是高危」可信得多。

---

## 6. 报告与规则

| 用途 | 工具 | 本机 |
|---|---|---|
| 检测规则（静态） | semgrep 语法，**规则照写，不要求装** | ❌ 但规则是文本，写了就能交付 |
| 检测规则（运行时） | Sigma（日志） | ❌ 同上 |
| 证据固化 | 截图 + 原始请求响应文本 | ✅ |
| 加固对照 | OWASP Cheat Sheets | ✅（网页） |

**规则写了但没装工具跑，不是失败**：在 VERIFY.md 里写 `UNRUNNABLE + 原因`，
并把手写的 grep 判据贴进去。**别为了表格好看编一个 CAUGHT。**

---

## 7. 绝对不做

| 不做 | 为什么 |
|---|---|
| 对未授权目标做任何测试 | 违法，且是这条能力唯一的存在前提 |
| 自动下载/安装扫描或爆破工具 | 除了速度还带来「顺手扫一下别人」的诱惑 |
| 把授权目标当跳板打别处 | 那是扩面，不是深度 |
| 产出免杀 payload / C2 / 可分发 exploit | 那不是「验证自有目标」需要的 |
| 拿 PayloadsAllTheThings 做批量投放 | 验证用 payload 一次就够，批量是攻击 |

**这些不是保守，是专业**：真正的红队交付的是「你的系统有多脆弱」的判断，
不是「我有多能打」的证明。
