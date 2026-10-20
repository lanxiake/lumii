# weixin-multi — Windows 微信 4.x 多开器

关闭微信的**单实例互斥体句柄**后再启动 `Weixin.exe`。不修改文件、不注入 DLL、不改内存。

## 用法

```bat
:: 多开一个（同一数据目录，可同时在线）
weixin-multi.cmd

:: 再开两个（总共三个）
weixin-multi.cmd -Count 2

:: 第二个账号：独立数据目录（会先关闭当前微信）
weixin-slot2.cmd
:: 等价于
weixin-multi.cmd -DataDir "C:\myself\my-soft\Weixin2"

:: 只查看当前微信进程持有的单实例互斥体
weixin-multi.cmd -ListOnly

:: 指定安装路径（默认读 HKCU\Software\Tencent\Weixin\InstallPath）
weixin-multi.cmd -Count 1 -ExePath "C:\myself\my-soft\Weixin\Weixin.exe"

:: 微信本身以管理员身份运行时才需要
weixin-multi.cmd -Elevate

:: 自检：验证“枚举 + 关闭”这条链路（不需要管理员）
powershell -NoProfile -ExecutionPolicy Bypass -File .\weixin-multi.ps1 -SelfTest
```

## 原理

微信 4.x 在 `Weixin.dll` 里调用 `CreateMutex` 创建命名互斥体。4.1.15.13 的二进制里同时有：

- `XWeChat_App_Instance_Identity_Mutex_Name`
- `XWeChat_XWEB_Instance_Identity_Mutex_Name`（运行时实际创建的是这个）

所以脚本按子串 `Instance_Identity_Mutex_Name` 匹配，两个变体都能命中。
创建失败时微信会找已有窗口并退出，因此只要把这个互斥体的句柄关掉，下一次启动就能通过检查。

工具流程：

1. `NtQuerySystemInformation(SystemExtendedHandleInformation)` 枚举全系统句柄；
2. 过滤出 `Weixin.exe` 的句柄，先查对象类型，只保留 `Mutant`；
3. 查对象名，匹配 `Instance_Identity_Mutex_Name`；
4. 用 `DuplicateHandle(..., DUPLICATE_CLOSE_SOURCE)` 关闭源进程里的那个句柄；
5. 启动新的 `Weixin.exe`，并在启动窗口内持续清理新实例创建出的互斥体。

关的是**句柄**，不是内核对象本身；已经登录的实例不受影响，只是它不再阻止后续实例启动。

## 权限

同用户、同完整性级别下，普通权限即可复制并关闭微信的句柄（本机自检已验证）。
只有当微信本身以管理员身份运行、普通权限拿不到句柄时，才需要 `-Elevate` 提权重启。

## 账号隔离（独立数据目录）

微信 4.x 支持 `/d <目录>` 启动参数：会把 `xwechat_files`（登录态 + 聊天数据）建在该目录下。
`weixin-slot2.cmd` 用 `C:\myself\my-soft\Weixin2` 作为第二个槽位。

**关键限制（实测）**：不同数据目录的两个实例**不能同时在线**。已有实例在跑时，
带 `/d` 启动的新进程会建好目录然后退出（疑似被现有实例的 IPC 转发截住）；
把互斥体也关掉、换可执行文件路径（目录联接）都不解决。所以脚本会先关闭所有微信实例再启动。

想要“同时在线 + 各自独立登录态”，目前只有两条路：

1. **改微信二进制 / 注入 DLL**（BetterWX、MutiWeixinTools 的做法）——能实现，但有版本强绑定和封号风险；
2. **系统级隔离**（另一个 Windows 用户 / 沙箱）——不改微信，代价是使用麻烦。

本工具默认走“不改程序文件”的路线：同数据目录原生多开（可同时在线），
或不同数据目录轮换（各自记住账号，但一次只开一个）。

## 封号风险

- 多开本身：微信 4.1.8+ 已原生支持多开，本工具在 4.1.15.13 上实测**不关互斥体也能开第二个窗口**；
  只有在老版本上才需要关闭互斥体句柄。
- `/d` 是客户端自己的参数，不修改文件、不注入、不改内存。
- 本工具**不做**二进制补丁、不做 DLL 注入、不改 `Weixin.dll`。这是刻意的。

## 其他多开器的前后端实现

| 工具 | 前端 | 后端 |
|---|---|---|
| BetterWX（Rust） | 终端 TUI + 子命令 | 扫描符号/字符串定位函数，用 iced-x86 打字节补丁；备份原文件可还原；coexist 用目录联接 + 补丁 `InitDirs` / `ForwardExistedProcessExceptSelf`，每个入口独立的 `global_confXg` |
| RevokeMsgPatcher MultiInstance（C#） | WinForms 小窗口（启动多开 / 清理所有互斥体 / 进程数） | `NtQuerySystemInformation` 枚举句柄 → `NtQueryObject` 查名 → `DuplicateHandle(DUPLICATE_CLOSE_SOURCE)`；500ms 定时器 |
| multi-wechat-rs | Rust CLI | 同样是关 Mutex 句柄；macOS 走 Mach-O 补丁 |
| MutiWeixinTools | 选择路径 + 生成不同桌面快捷方式 | 启动后暂停进程、注入 DLL、改内存里的互斥体名和 `global_config` 字符串、Hook `CreateMutex`，创建完恢复并卸载 Hook |
| uTools 插件（iWechatX 等） | uTools 面板（HTML/JS） | 调 `handle.exe` 释放互斥体 + 备份/还原 `global_config`；按账号保存登录态 |
| WeChat-Split（macOS） | 脚本 | 复制 App、改 Bundle ID、重签名，靠沙盒容器隔离 |

共同点：多开都是打互斥体；真正的账号隔离要么改程序/内存，要么靠系统容器。
**不改微信程序文件的方案，很难同时做到“多账号同时在线 + 各自免扫码”。**

## 实测记录

- **2026-10-20，微信 4.1.15.13（本机）**：原有 1 个已登录实例（1 个主窗口），
  `-Count 1` 后变成 **2 个主窗口**；关闭新实例后原实例仍正常响应。
- **4.1.15.13 原生多开**：不关互斥体、直接再启动一次 `Weixin.exe`，同样出现第二个主窗口。
  说明该版本已内置多开；关互斥体只对老版本必要。
- **`/d` 数据目录**：没有实例时，`Weixin.exe /d C:\myself\my-soft\Weixin2` 会启动并创建
  `Weixin2\xwechat_files\all_users\...`；有实例时会在建目录后退出。
- 互斥体句柄在普通权限下就能关闭（同用户、同完整性级别），不需要 UAC。
- 一个微信实例会创建 5 个左右 `Weixin.exe` 进程（主进程 + 辅助进程），
  判断实例数要看 `MainWindowHandle`，不能数进程。

## 已知限制

- **只解决“能不能再开一个”**。微信 4.x 的登录配置 `xwechat_files\all_users\config\global_config`
  由所有实例共用且在运行中被锁住；如果要**多个账号同时在线并免扫码**，还需要按账号隔离配置
  （启动前换 `global_config`，或使用 BetterWX 的 co-existence 那类改名重定向方案）。本工具不做这件事。
- 微信升级后互斥体名称若变化，需要更新 `$MutexNeedle`。
- 第三方句柄操作可能被安全软件拦截；本工具不需要常驻，启动完即退出。

## 参考

- [anyiblog/WeixinUnlockMutex](https://github.com/anyiblog/WeixinUnlockMutex) — 4.0 版 `XWeChat_...` 名称与 `ZwQuerySystemInformation` 实现
- [huiyadanli/RevokeMsgPatcher](https://github.com/huiyadanli/RevokeMsgPatcher) — 运行时关闭互斥体、版本无关
- [jiusanzhou/multi-wechat-rs](https://github.com/jiusanzhou/multi-wechat-rs) — Windows 端 Mutex Kill
- [zetaloop/BetterWX](https://github.com/zetaloop/BetterWX) — 多开补丁与多账号共存（`global_config` 隔离）
- [微信 PC 端多开的秘密](https://developer.aliyun.com/article/917513) — 早期互斥体逻辑分析
