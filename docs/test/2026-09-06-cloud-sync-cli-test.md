# 云同步（GitCode）CLI 测试用例

> **前置条件**：
> 1. 应用已启动（`pnpm dev`），控制口可达（`~/.lumii/runtime/app-ui.json` 存在且端口可连）。
> 2. CLI：`node resources/app-ui-cli/lumii-ui.mjs`（或已软链为 `lumii-ui`）。
> 3. **Track B（真实同步）需要**：一个真实 GitCode 私有仓库 + 有 push 权限的访问令牌。
> 4. **隔离建议**：用 `LUMII_CLIENT_DATA_DIR=<拷贝目录>` 指向干净数据目录，避免污染主库。
>
> 退出码约定：`0` 成功 / `2` 参数错 / `3` 应用未运行 / `4` 认证失败 / `5` 被拒绝。

---

## 0. 测试范围与分层

云同步链路分四层，本用例逐层验证，最后做端到端：

| 层 | 验证点 | 手段 |
|---|---|---|
| 核心 git 逻辑 | push/fetch/merge/conflict/adoptRemote/criss-cross 共 14 场景 | 已由 `sync-manager.test.ts` 单测覆盖（本地双目录互推，不联网） |
| 配置加解密 | token safeStorage/plain 兜底、掩码回显 | 已由 `sync-config.test.ts` 覆盖 |
| **IPC/preload/设置页接线** | 配置往返、状态推送、同步触发 | **本用例 Track A（CLI + UI 自动化）** |
| **真实多设备流转** | 真实 GitCode 推/拉/冲突 + Agent 落决 | **本用例 Track B（需真实仓库）** |

> 核心 git 逻辑已在单测层充分覆盖；CLI 用例聚焦「真实用户操作路径 + 接线正确性」，不重复单测已覆盖的分支。

---

## Track A — 无需真实远程（接线与 UI 验证）

### A1. 打开设置页并确认「云同步」区块渲染

```bash
lumii-ui goto --view settings --category workspace
lumii-ui screenshot --annotate
```

**预期**：截图 refs 里出现 `section_title` =「云同步」，其下含 label 为
「启用云同步」「平台」「仓库地址」「访问令牌 (Token)」「分支」「同步间隔（分钟）」
的控件，以及「测试连接」「立即同步」「保存配置」三个按钮。

**验证点**：区块完整渲染，无红屏/报错；平台下拉只有 GitCode 可选（GitHub/Gitee 置灰）。

### A2. 未启用时的同步行为

```bash
lumii-ui cloudsync status
# 预期：{ "ok": true, "status": { "state": "idle", ... } }

lumii-ui cloudsync sync
# 预期：{ "ok": true, "success": false, "state": "idle" }（未配置 → 云同步未启用）
```

**验证点**：`sync` 在未启用/未配置时静默返回，不抛错、不改状态为 error。

### A3. 启用开关 + 填写无效地址（测试连接的失败路径）

```bash
# 用 UI 自动化：screenshot 拿到「启用云同步」开关 ref → click 打开
lumii-ui act --action click --ref <开关ref>

# 拿到「仓库地址」输入框 ref → 写入一个非 GitCode 地址
lumii-ui act --action type --ref <仓库地址ref> --text "https://github.com/a/b.git"

# 点「测试连接」
lumii-ui act --action click --ref <测试连接ref>
lumii-ui screenshot
```

**预期**：toast 提示「连接失败」，错误为 GitCode 地址校验拒绝（`仓库地址应形如 https://gitcode.com/...`）。

**验证点**：`validateUrl` 在真实 UI 里生效，错误文案人话可见。

### A4. 保存配置 + 掩码回显（不泄露明文）

```bash
# 填入合法 GitCode 地址 + token（token 用假值即可测掩码回显，不真连网）
lumii-ui act --action type --ref <仓库地址ref> --text "https://gitcode.com/alice/notes.git"
lumii-ui act --action type --ref <token ref> --text "secret-token-1234"
lumii-ui act --action click --ref <保存配置ref>
lumii-ui screenshot
```

**预期**：token 输入框清空，hint 显示 `当前已保存：secr****1234`（前 4 + `****` + 后 4），
截图/refs 里不出现完整 token。

**验证点**：token 掩码回显；`saveConfigFromView` 落盘密文（非明文）——可另验证
`~/.lumii/config/cloud-sync.json` 里 `tokenEnc` 不以明文 token 开头（`plain:` 兜底除外）。

### A5. 禁用后调度停止

```bash
lumii-ui act --action click --ref <启用开关ref>   # 关闭
lumii-ui cloudsync status
# 预期：state=idle；后台 30s 冷启动同步不再触发（观察日志无「开始同步」）
```

**验证点**：开关与 `SyncScheduler.start({enabled})` 联动正确。

---

## Track B — 真实远程全流程（需 GitCode 仓库 + token）

> 以下步骤假设已在 `~/.lumii/config/cloud-sync.json` 配好（或用 A4 的 UI 路径配置）：
> `enabled=true`、`repoUrl=https://gitcode.com/<user>/<repo>.git`、`tokenEnc` 为已加密 token。

### B1. 测试连接（真实鉴权）

```bash
# 通过设置页点「测试连接」，或直接触发同步观察认证结果
lumii-ui cloudsync sync
lumii-ui cloudsync status
```

**预期**：`sync` 返回 `success:true, state:idle`；`status.lastSyncAt` 更新；无 `lastError`。

**验证点**：真实 GitCode 鉴权头（`username=token, password=x-oauth-basic`）可被接受，
首次推送（远程空仓库）成功。

### B2. 首推后远端收到内容

在另一台机器/另一个数据目录 `git clone https://gitcode.com/<user>/<repo>.git` 后核对：
- 工作空间文件（排除 `projects/`、`temp/`、`.gitignore` 项）已出现在远端。
- 远端分支为 `main`，含「云同步自动提交」等提交。

**验证点**：排除规则生效（`projects/`、`temp/` 不出现）。

### B3. 第二设备拉取（仅远程新 → 本地快进）

```bash
# 设备 B（另一数据目录）先 ensureInit 再同步
LUMII_CLIENT_DATA_DIR=<设备B数据目录> lumii-ui cloudsync sync
lumii-ui cloudsync status
```

**预期**：设备 B 工作空间出现设备 A 的文件；`state=idle`；本地不产生多余 push。

### B4. 双方改不同文件 → 自动 merge

- 设备 A 改 `a.md`，设备 B 改 `b.md`，各自 `cloudsync sync`。
- 两边最终 `a.md`、`b.md` 都是最新；`cloudsync status` 均 `idle`，无 conflict。

**验证点**：自动合并成功，工作树被 checkout 物化（非仅 index）。

### B5. 双方改同一文件 → conflict + Agent 落决

```bash
# 制造冲突：设备 A 与设备 B 同时改 shared.md 不同内容，各自 sync
lumii-ui cloudsync status
# 预期：{ state: "conflict", conflict: { files: ["shared.md"], bothModified: ["shared.md"], ... } }
lumii-ui screenshot   # 设置页显示「冲突待处理」+ 冲突文件列表
```

然后在对话中让 Agent 处理（Agent 侧已注册 `resolve_sync_conflict` 与 `cloud_sync_read_file` 工具）：

```
用户：云同步有冲突，帮我解决。
Agent：先用 cloud_sync_read_file 读 shared.md 的 local/remote/base，再 resolve_sync_conflict 选 keep-local/keep-remote/per-file。
```

**验证点**：
- `cloud_sync_read_file` 能读到三侧内容（local/remote/base）。
- `resolve_sync_conflict` 返回 `{ status:"ok" }`，随后 `cloudsync status` 回到 `idle`，冲突文件落为所选侧。

### B6. 冲突期间 sync 不重试（防覆盖）

```bash
# 处于 conflict 态时连续两次 sync
lumii-ui cloudsync sync
lumii-ui cloudsync sync
# 预期：均返回 success:false, state:conflict，不产生新的 fetch/push（观察日志无「开始同步」重复）
```

**验证点**：冲突态阻断重入，等 Agent 落决，避免静默覆盖。

---

## 通过标准（自测清单）

- [ ] A1 云同步区块渲染完整，平台下拉仅 GitCode 可选
- [ ] A2 未启用时 `cloudsync sync` 静默返回 idle，不置 error
- [ ] A3 非 GitCode 地址被拒绝，错误文案可见
- [ ] A4 token 掩码回显（前4+****+后4），落盘非明文
- [ ] A5 禁用后后台调度停止
- [ ] B1 真实 GitCode 鉴权 + 首推成功，`lastSyncAt` 更新
- [ ] B2 首推后远端含工作空间文件，`projects/`、`temp/` 被排除
- [ ] B3 第二设备拉取成功，本地快进
- [ ] B4 改不同文件自动 merge，工作树物化
- [ ] B5 改同文件进 conflict，Agent 经工具读三侧 + 落决后回 idle
- [ ] B6 冲突期间 sync 不重试

---

## 反思与缺口（自查）

1. **单测与 CLI 的分工**：14 个 git 分支场景已由 `sync-manager.test.ts` 用本地双目录互推覆盖，CLI 用例不重复它们，避免「看似充分、实则同一层重复测」。CLI 只补单测够不到的接线与真实网络。
2. **真实网络依赖**：Track B 强依赖 GitCode 账号/token，无法在无凭据环境自动化；已把「能离线测」的 A 组（渲染/配置/错误路径/掩码）与「需真实远程」的 B 组拆开，保证 A 组始终可跑。
3. **缺口——Agent 端到端**：B5 的 Agent 落决依赖对话触发，需人工/真实 LLM 参与，未脚本化；单测层已覆盖 `resolveConflict` 三策略正确性，此处仅验证「工具注册 + 可读三侧」的接线。
4. **缺口——多设备并发**：真实双设备同时改同一文件的竞态，单测用 `enqueueWorkspace` 串行断言覆盖了进程内互斥，但跨设备并发（两个进程同时 push 到 GitCode）的 non-fast-forward 重试，需两台真机实测，未纳入本用例。
5. **缺口——24h 冲突超时升级**：`escalate` 事件到主窗口通知的接线未在 CLI 覆盖（需等 24h 或 mock 时间），建议后续用假时钟单测补。
6. **偏差风险**：UI 自动化的 `--ref` 依赖运行时截图编号，换版本/改布局会变；故 A 组每一步都先 `screenshot` 再按 label 找 ref，不用硬编码 ref。

---

## 附录：故障排查

- **`cloudsync status` 返回 `not_ready`**：云同步 manager 未初始化（应用初始化顺序问题），或控制口在 manager 创建前已就绪。
- **`cloudsync sync` 返回 `云同步未启用`**：`cloud-sync.json` 缺 `enabled/repoUrl/tokenEnc`，或 token 解密失败（safeStorage 密钥随系统/登录态变）。
- **`测试连接` 一直失败**：GitCode 令牌需 `repo` 权限；认证头为 `x-oauth-basic`，与 GitHub 一致，GitCode 实测确认。
- **首推后远端无文件**：确认 `projects/`、`temp/` 在 `.gitignore` 内被排除（`vcs-ignore.ts` 默认规则）；确认 `ensureInitialized` 已写入默认 `.gitignore`。
- **控制口不可达**：确认应用已启动、`~/.lumii/runtime/app-ui.json` 存在；隐私设置里 `allowAgentAppUiControl` 未关。

---

**执行时间估算**：Track A 约 10 分钟（纯 CLI）；Track B 约 20 分钟（含真实仓库准备 + Agent 对话落决）。
