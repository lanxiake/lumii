# 用户指南（源文件）

> ⚠️ **本目录是源文件，不要直接改产物。**
> `pnpm --filter ./apps/windows sync:guides` 会把这里的 `.md` 与 `assets/` 同步到 `apps/windows/resources/user-guides/`，随安装包分发。改路径或文件名须同步修改 `apps/windows/scripts/sync-user-guides.mjs` 的 `SOURCE_DIR` 与 `GUIDE_CATALOG`。

| 文件 | 说明 |
| --- | --- |
| [`Lumii-Desktop-User-Guide.md`](Lumii-Desktop-User-Guide.md) | 桌面端用户手册正文 |
| [`wiki-user-guide.md`](wiki-user-guide.md) | Wiki 知识库使用指南 |
| [`assets/`](assets/) | 手册配图（20 张界面截图，按章节编号） |

应用内通过「帮助」抽屉（`WikiHelpDrawer`）读取同步后的产物；`manifest.json` 由脚本生成，记录标题、分类、标签与 `seedToWiki` 等元信息，**不要手工编辑**。
