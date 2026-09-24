---
name: wordsmith
description: Count and analyze word/line/char statistics of text or files. Use when the user asks to count words, characters, lines, or measure text length.
---

# Wordsmith

给这段文字做统计时遵循以下步骤：

1. 判断输入是字面文本还是文件路径；文件用 `node scripts/wordcount.mjs <path>` 统计。
2. 汇报 words / chars / lines 三个指标，用户没要的指标不要展开。
3. 如果用户要求"字数"而语境是中文，补充说明中文按空白分词会低估，建议按字符数解读。

支持脚本 `scripts/wordcount.mjs` 是无依赖 Node 脚本，可直接执行。
