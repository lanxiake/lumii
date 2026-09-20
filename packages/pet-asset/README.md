# @mtbot/pet-asset

宠物素材工具链 CLI。**构建期与 Agent 侧使用，不进运行时**（依赖 sharp）。

设计与分期见 [`docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md`](../../docs/design/客户端UI/2026-09-20-虚拟人精灵图渲染后端设计.md)、[`docs/plans/客户端UI/2026-09-20-宠物自制系统P0-a实施计划.md`](../../docs/plans/客户端UI/2026-09-20-宠物自制系统P0-a实施计划.md)。

## 子命令

```bash
pet-asset dir                                   # 打印用户宠物目录
pet-asset validate <包目录>                      # 只读校验，一次报出全部问题
pet-asset install  <包目录> [--target <目录>]    # 校验通过才搬运（两段式安装）
pet-asset cutout   <输入图> <输出图> [--bg #rrggbb] [--tSolid N] [--tLow N]
```

全局 `--json` 输出机器可读结果。退出码：`0` 成功 / `1` 校验未通过或执行失败 / `2` 用法错误。

## 安装包结构

```
<包目录>/
  manifest.json   渲染清单（必填，schema 见 pet-core 的 sprite-manifest.ts）
  pet.json        可选信封：注册表侧字段（name / scale / 动作组 / 表情映射 / personaAddon…）
  atlas.png       图集（必须已抠底）
  atlas.json      图集索引（TexturePacker / Aseprite 格式均可）
```

`pet.json` 里的 `id` / `rendererType` / `modelUrl` **会被忽略**——它们由清单与安装结果决定，
信封不得把模型指向别的目录或冒用别的 id。

## 两段式安装

```
validate  只读，不写任何字节
install   先跑 validate，通过才搬
```

「校验不通过 → 装不上，但绝不影响渲染稳定性」由三件事保证：

1. 与运行时**共用同一份** `validateSpriteManifest`（安全边界单一落点，在 pet-core）
2. 先写 `<目标>/.installing-<id>-<ts>/`，写全了再 `rename` 成正式目录——扫描侧永远看不到半成品
3. 覆盖安装时先把旧目录改名为 `.bak-...`，失败则改回；上次中断留下的残留会在下次安装时自动清理与恢复

清单引用的路径全部经过越界检查：`atlas: "../../secret.png"` 这类会在 `validate` 阶段被拒绝，
不会因为一次安装而把包外文件暴露给渲染层。

## 构建

CLI 需先构建（pet-core 的源码用 `./x.js` 指代 `./x.ts`，Node 的类型擦除不做这个改写）：

```bash
pnpm --filter @mtbot/pet-asset build     # → dist/cli.mjs
```

开发期直接用源码：

```bash
pnpm --filter @mtbot/pet-asset test
pnpm --filter @mtbot/pet-asset typecheck
```

## 环境变量

| 变量 | 作用 |
| --- | --- |
| `PET_MODELS_DIR` | 覆盖用户宠物目录（优先级：`--target` > `PET_MODELS_DIR` > 默认） |
| `LUMII_CLIENT_DATA_DIR` | 覆盖客户端数据根（默认 `~/.lumii`），宠物目录随之改变 |

默认用户宠物目录 = `<客户端数据根>/pet-models` = `~/.lumii/pet-models`。

**不要改用 `app.getPath('userData')`**：`app.setName('Lumii')` 在 `whenReady()` 之后才调用，
而 userData 在更早的启动阶段就按 `app.getName()` 算好并缓存——dev 下是
`%APPDATA%/lumii-windows`（package.json 的 name），打包才是 `%APPDATA%/Lumii`（productName）。
CLI 不依赖 Electron，无从得知当前是哪种模式，两边必然对不上（这一点在实施时实测撞到过）。
数据根没有这个问题，dev 与打包都落在 `~/.lumii`。

> 这段规则在客户端侧另有一份实现（`apps/windows/src/main/client-data-root.ts` 与
> `main/pet/pet-asset-protocol.ts`）。用的是 node 内置模块，无法提到零依赖的 pet-core
> 里——那会被渲染层打包时牵连进 node 内置模块。**改动须两边同步**，
> 两侧各有用例锁住取值。
