# 主进程插件目录

一份代码只在一个地方：**插件的清单、接线、实现、测试都在 `builtin/<id>/` 下**。
`src/main/` 顶层只剩核心（kernel / ipc / agent-runtime / channel 等），不再散落插件代码。

```
plugins/
  registry.ts        唯一清单：BUILTIN_EXTENSIONS + hot 标记（HOT_SWAPPABLE_BUILTINS 由它派生）
  host.ts            createPluginHost：注册、校验 manifest、按禁用表排除启动
  control.ts         设置页的控制面：list / setEnabled / remove（运行期启停也在这里）
  active.ts          isExtensionActive 运行期门，核心调用点靠它判断插件在不在
  builtin/
    <name>/index.ts  插件定义（manifest + apply），接线全部写在这里
    <name>/*.ts      该插件独占的实现与测试
  external/
    loader.ts        外部扩展（~/.lumii/extensions/<dir>/main.js）加载与热重载
    official.ts      官方扩展同步（resources/extensions → 用户目录）
    paths.ts         用户插件目录 / 内置插件安装目录
    template.ts      新扩展脚手架
    dev-check.ts     扩展开发自检
    bootstrap.ts     依赖预安装（反检测浏览器等）
    bootstrap-config.ts
  external-src/      官方外部扩展的**源码**（构建成 resources/extensions/<id>/main.js）
    perf/ cloud-sync/ screen-record/
  install/           插件中心的运行时依赖安装（CloakBrowser / ffmpeg …），不是本系统的插件
```

`channel/` 不在这里：它是四个 channel-* 插件共享的子系统（Hub、适配器、Provider、
出站路由），被 agent-runtime 直接使用，搬进某个插件目录只会制造假边界。

## 生命周期

| 操作 | 要做的事 |
|---|---|
| **新增** | 建 `builtin/<name>/index.ts`（`export const xxxExtension = { manifest, definition }`）；`registry.ts` 加一行 import + 一行条目；需要即时启停就标 `hot: true`。核心若要在启动阶段取它的服务，通过 `S`（`kernel/services.ts`）交出去，不要让核心 import 实现。 |
| **修改** | 改 `builtin/<name>/` 下的文件即可。只改 `packages/*` 或主进程后必须重启 dev（见根 AGENTS.md）。 |
| **删除** | `rm -rf builtin/<name>/` + 删 `registry.ts` 里两行；`tsc` 会把残留引用全部列出来（核心通过 `isExtensionActive` 判门，删掉后功能自然消失）。再跑 `node scripts/check-wiring.mjs` 与 `scripts/ipc-owners.json` 对账。 |
| **升级** | 内置插件随应用发版；外部扩展改文件即热重载（1s 轮询）；官方扩展走 `external-src/` → `pnpm build:official-extensions` → 发布脚本。 |
| **卸载** | 内置不能卸（只能禁用，`manifest.disabled` 的代码留着但不激活）；外部扩展在设置页删除目录，或直接从 `~/.lumii/extensions/` 删。 |

## 运行期启停（`hot`）

`hot: true` 的含义不是「有 apply」，而是**禁用后功能真的消失**：接线全在 `apply(ctx)`
里（`ctx.registerIpc` / `ctx.effect`），停用时作用域整体拆掉。

没标 hot 的插件，设置页开关仍要求重启。给它们标 hot 之前先确认两件事：

1. 服务的**消费者**也走 `isExtensionActive` 判门，否则插件停了自己还在被核心调用；
2. 初始化不可逆时（如 ONNX 已绑某个运行时版本）要么能识别并拒绝，要么就别标 hot。

核心启动期**不要缓存**插件服务句柄（`const svc = S.xxx.get()`）：插件停用后变量仍指着旧实例，
表现为「关掉了但还在工作」。启动期取值的服务用 `LateRef`，或者每次现取。
