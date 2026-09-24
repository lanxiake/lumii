# 第 3 章实践 · 人设幻觉与提示词进化

两个实验，全部**纯 Python 标准库（3.8+）、完全离线**可跑。

## 文件

| 文件 | 说明 |
|---|---|
| `fewshot_pipeline.py` | 实验 A：失败案例 → 错误分类学 → top-3 纠正卡 |
| `runlog_sample.json` | 样例运行日志：工单字段抽取 Agent，36 条（14 通过 / 22 失败，六类错误）。合成数据 |
| `persona_ab.py` | 实验 B：无 persona / 专家 persona / 超长 persona 三组 A/B 测试模板 |
| `error_taxonomy.json`、`fewshot_cards.md`、`persona_ab_results.md` | 运行后生成的产物（仓库里已带一份示例输出） |

## 实验 A：失败案例驱动的 few-shot 流水线

```bash
python fewshot_pipeline.py runlog_sample.json
# 可选: --top 4 改纠正卡数量; --outdir out 改输出目录
```

流程与论文对应关系：

1. **失败聚类**：按校验器报错文本的规则匹配归类（对应 ETGPO, arXiv:2602.00997 的 taxonomy creation，这里用规则替代 LLM 打标，确定且可审计）。
2. **分类学统计**：每类条数、占失败比例、样本 ID。
3. **纠正卡**：为 top-N 错误类各生成一张「规则一句话 + 错误例 + 正例」卡，并附可粘贴进系统提示词的 few-shot 片段（对应 ETGPO 的 guidance generation：negative example + positive example + advice）。

### 你应该观察到

- 22 条失败聚成 **6 类**，前三类（日期 6 条、JSON 格式 5 条、金额 5 条）覆盖 **73%** 的失败——这就是"先解决错误分类学，再动提示词"的依据。
- 你不需要优化器、不需要 200 条数据：给三类错误各补一张 few-shot 卡（共 3 条示例），就是最便宜的改进路径。
- 想验证效果？把 `fewshot_cards.md` 的片段贴进 Agent 的系统提示词，重放这 22 条失败样本，看逐类翻转情况。

## 实验 B：人设 A/B 测试模板

```bash
python persona_ab.py                    # 桩模式（默认，不调 API）
python persona_ab.py --mode api         # 真实调用 OpenAI 兼容接口
```

API 模式环境变量：

| 变量 | 默认 |
|---|---|
| `OPENAI_API_BASE` | `https://api.openai.com/v1` |
| `OPENAI_API_KEY` | （必填） |
| `OPENAI_MODEL` | `gpt-4o-mini` |

### 桩模式说明（重要）

桩模式的答案由写死的查表函数生成，**数字全是模拟的**。它的唯一目的是让你在
不花一分钱 API 费用的前提下，看懂三件事：三组对照怎么搭、报表长什么样、
"基线对而人设错"的逐题明细为什么才是重点。

### 你应该观察到

- 三组系统提示词长度 34 / 81 / 319 字符——长度本身就是实验变量（PRISM 的研究维度之一）。
- 桩模式刻意模拟了文献方向（Zheng et al. arXiv:2311.10054；PRISM arXiv:2603.18507）：
  加专家头衔不涨分，甚至掉分；人设越长掉得越多。真实接口上你可能得到不同数字——
  这正是第 3 章正文说的：人设效应**基本是随机的**，所以你必须自己测，而不是信宣传。
- 12 题只够看形态。真实结论至少要上百条、温度 0、固定随机种子，并报告差值的抽样波动。

## 已知边界

- 样例日志的错误模式为合成，勿与任何真实产品对号入座。
- `classify()` 是规则打标：你的日志格式不同就改 `RULES`；规则写不动了，
  下一步才是让 LLM 做聚类（记得人工抽查聚类结果，ETGPO 消融显示"成体系归类"本身有增益）。
