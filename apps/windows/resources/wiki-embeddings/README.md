# Wiki 多语言嵌入模型（运行时下载）

Wiki 向量检索使用 `Xenova/multilingual-e5-small`（量化版合计约 **140 MB**），**不打包进安装包**。

## 下载时机

1. **应用启动**：后台从国内镜像 [hf-mirror.com](https://hf-mirror.com) 预下载到用户目录  
2. **首次 Wiki 搜索**：若预下载未完成，会再次尝试下载后再加载  
3. **手动预下载**（可选）：

```bash
pnpm --filter ./apps/windows download:wiki-embedding-model
```

## 缓存路径

```
~/.lumii/models/wiki-embeddings/Xenova/multilingual-e5-small/
```

可通过 `LUMII_CLIENT_DATA_DIR` 修改数据根目录。

## 镜像配置

| 环境变量 | 说明 |
|----------|------|
| `HF_ENDPOINT` | 优先使用的 Hugging Face 镜像（如 `https://hf-mirror.com`） |
| `LUMII_HF_ENDPOINT` | 同上，Lumii 专用别名 |
| `LUMII_WIKI_VECTOR=0` | 关闭向量检索，跳过下载 |

未配置时默认使用 **hf-mirror.com**，官方 huggingface.co 仅作回退。

## 失败行为

下载或加载失败时，Wiki 搜索降级为 **bigram 哈希向量 + 全文检索**，并在 UI 显示降级原因。
