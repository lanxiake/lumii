# -*- coding: utf-8 -*-
"""校验导出 / 通讯录 CSV 产物：BOM、表头、行数、公式注入前缀；JSON 可解析；PDF 魔数。只打印结构与计数。

运行：python check_exports.py <文件或目录> [...]
"""
import csv
import glob
import io
import json
import os
import sys

RISKY = ("=", "+", "-", "@")


def check_csv(path):
    """CSV：UTF-8 BOM、表头、行数；统计以 = + - @ 开头却没加 ' 前缀的单元格（应为 0）。"""
    raw = open(path, "rb").read()
    rows = list(csv.reader(io.StringIO(raw.decode("utf-8-sig"))))
    cells = [c for r in rows[1:] for c in r]
    risky = [c for c in cells if c[:1] in RISKY]
    guarded = [c for c in cells if c[:1] == "'" and c[1:2] in RISKY]
    has_bom = raw[:3] == b"\xef\xbb\xbf"
    print(f"[csv] {os.path.basename(path)}  BOM={has_bom}  bytes={len(raw)}  "
          f"rows={len(rows) - 1}")
    print(f"      header={rows[0] if rows else []}")
    print(f"      未加前缀的危险单元格={len(risky)}  已加 ' 前缀={len(guarded)}  "
          f"危险样例首字符={[c[:2] for c in risky[:5]]}")


def check_json(path):
    """JSON：能否解析、顶层结构。"""
    try:
        data = json.load(open(path, encoding="utf-8"))
        shape = list(data)[:8] if isinstance(data, dict) else f"list[{len(data)}]"
        print(f"[json] {os.path.basename(path)}  ok  {shape}")
    except ValueError as e:
        print(f"[json] {os.path.basename(path)}  解析失败: {e}")


def check_pdf(path):
    """PDF：魔数与大小。"""
    head = open(path, "rb").read(5)
    print(f"[pdf] {os.path.basename(path)}  magic={head!r}  bytes={os.path.getsize(path)}")


def main():
    """按扩展名分派校验。"""
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    for arg in sys.argv[1:]:
        files = glob.glob(os.path.join(arg, "**", "*"), recursive=True) if os.path.isdir(arg) else [arg]
        for f in sorted(files):
            ext = os.path.splitext(f)[1].lower()
            if ext == ".csv":
                check_csv(f)
            elif ext == ".json":
                check_json(f)
            elif ext == ".pdf":
                check_pdf(f)
            elif os.path.isfile(f):
                print(f"[file] {os.path.relpath(f, arg) if os.path.isdir(arg) else f}  bytes={os.path.getsize(f)}")


if __name__ == "__main__":
    main()
