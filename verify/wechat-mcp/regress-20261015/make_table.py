# -*- coding: utf-8 -*-
"""把 results.jsonl 汇总成 Markdown 总表 + 覆盖率（剔除 `_probe` 探测行）。

运行：python make_table.py > table.md
覆盖率的工具全集取自 %TEMP%\\lumii-regress-20261015\\tools_<别名>.json（由 regress_one.py --list 生成）。
"""
import json
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(tempfile.gettempdir(), "lumii-regress-20261015")
ORDER = ["pro", "lite", "export", "crm", "recall"]
# 预期内的拒绝：错误路径用例返回 ok:false / 协议错误即为通过
EXPECT_FAIL_MARK = ("错误路径", "应拒绝", "回退")


def verdict(r):
    """通过 / 预期内拒绝 / 失败。label 标了错误路径的用例，拒绝才算对；否则 ok 才算对。

    另两类按业务语义判为预期内：批量里故意放了不存在的会话（整体 ok:false、单条 target_not_found）；
    语音音频已被微信清除（voice_unavailable，缺失是永久的）。
    """
    if "不存在会话" in (r.get("label") or "") and not r["ok"]:
        return "预期内（部分失败）"
    if r.get("error_code") == "voice_unavailable":
        return "预期内拒绝"
    expect_fail = any(m in (r.get("label") or "") for m in EXPECT_FAIL_MARK)
    if expect_fail:
        if "回退" in r["label"]:
            return "通过" if r["ok"] and "pdf_error" in r["summary"] else "失败"
        return "预期内拒绝" if not r["ok"] else "**未拒绝**"
    return "通过" if r["ok"] else "失败"


def main():
    """读结果行 → 打印总表与覆盖率。"""
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    rows = [json.loads(x) for x in open(os.path.join(HERE, "results.jsonl"), encoding="utf-8") if x.strip()]
    rows = [r for r in rows if r.get("label") != "_probe"]
    print("| # | 产品 | 工具 | 用例 | 结果 | 耗时 ms | 摘要 |")
    print("|---|---|---|---|---|---|---|")
    for i, r in enumerate(rows, 1):
        summ = re.sub(r"csv_path=\S+?(通讯录_)\S+?\.csv", r"csv_path=…\\\1*.csv", r["summary"])
        summ = summ.replace("|", "/").replace("\n", " ")[:90]
        print(f"| {i} | {r['product']} | `{r['tool']}` | {r.get('label') or '正常路径'} | {verdict(r)} | "
              f"{r['ms']} | {summ} |")
    print()
    print("| 产品 | 覆盖 | 未调用 |")
    print("|---|---|---|")
    for alias in ORDER:
        f = os.path.join(OUT, f"tools_{alias}.json")
        if not os.path.isfile(f):
            continue
        tools = json.load(open(f, encoding="utf-8"))["tools"]
        hit = {r["tool"] for r in rows if r["product"] == alias}
        miss = [t for t in tools if t not in hit]
        print(f"| {alias} | {len(tools) - len(miss)}/{len(tools)} | {', '.join(miss) or '—'} |")


if __name__ == "__main__":
    main()
