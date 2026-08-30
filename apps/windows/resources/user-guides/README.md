# 内置使用指南（user-guides）

本目录由 `scripts/sync-user-guides.mjs` 从仓库 `docs/guide/` 同步生成，随 `extraResources` 打入安装包。

- 不要手改 `.md`（会被同步覆盖）；请编辑 `docs/guide/` 后运行 `pnpm sync:guides`
- 新增指南：在 `docs/guide/` 添加文件，并在 `sync-user-guides.mjs` 的 `GUIDE_CATALOG` 登记
