# -*- coding: utf-8 -*-
"""技能包自测：`skills/wechat-mcp-{pro,lite}/SKILL.md` 与**真实产物**对不对得上。

跑法：`python test_skills.py`（需要先 build 出 dist 里的两个 exe；没 build 就跳过）。

为什么要它：技能是**给别的 Agent 看的文档**，里面写错一个工具名，那个 Agent 会去调一个
不存在的工具（报 tool not found），**而写文档的人看不见**——文档漂移永远不会自己报警。
这里把三件事钉住：
  ① 本档每个工具名都在技能里出现过（漏一个 ⇒ Agent 不知道它存在）；
  ② 技能里不出现**本档没有**的工具名（写了 ⇒ Agent 会去调然后失败）；
     lite 允许提 pro 独有的那几个，但必须在「本版没有」的语境里；
  ③ frontmatter 的 `name`/`description` 合规（客户端按目录名认技能，靠 description 判场景）。
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
DIST = os.path.join(HERE, "dist")
sys.stdout.reconfigure(encoding="utf-8")
fails = []
skipped = 0


def check(label, cond, extra=""):
    if not cond:
        fails.append(label)
    print(("  OK  " if cond else "  FAIL") + f"  {label}" + (f"  [{extra}]" if extra else ""))


def exe_of(edition):
    return os.path.join(DIST, "wechat-mcp.exe" if edition == "pro" else "wechat-mcp-lite.exe")


def tools_of(exe):
    """跑一次 initialize + tools/list 取工具名。

    ⚠️ 必须先拷到带 `.lumii-bundled` 标记的目录：dist 里那份 pro 产物既没有灵栖的豁免标记、
    也没配授权，`effective_edition` 会把它**降级成 lite**（只出 12 个工具）——那是授权设计、
    不是 bug，但会让「pro 该有 19 个」这条断言假红。拷一份加标记，等价于灵栖的部署环境。
    """
    with tempfile.TemporaryDirectory(prefix="skill-check-") as d:
        staged = os.path.join(d, os.path.basename(exe))
        shutil.copyfile(exe, staged)
        open(os.path.join(d, ".lumii-bundled"), "w").close()
        req = "\n".join([
            json.dumps({"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {
                "protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "skill-check", "version": "0"}}}),
            json.dumps({"jsonrpc": "2.0", "id": 2, "method": "tools/list", "params": {}}),
        ]) + "\n"
        # errors="replace"：exe 的 stderr 是 GBK 日志，按 utf-8 硬解会在读线程里抛 UnicodeDecodeError
        p = subprocess.run([staged], input=req, capture_output=True, text=True,
                           encoding="utf-8", errors="replace", timeout=180)
    for line in (p.stdout or "").splitlines():
        if line.strip():
            m = json.loads(line)
            if m.get("id") == 2:
                return [t["name"] for t in m["result"]["tools"]]
    raise RuntimeError(f"拿不到 tools/list：stdout={p.stdout!r} stderr={p.stderr!r}")


missing_exe = [e for e in ("pro", "lite") if not os.path.exists(exe_of(e))]
if missing_exe:
    print(f"跳过：dist 里还没有 {'、'.join(missing_exe)} 的 exe，先跑 `pnpm build:wechat-mcp`。")
    sys.exit(0)

by_edition = {e: tools_of(exe_of(e)) for e in ("pro", "lite")}

for edition, want_n in (("pro", 19), ("lite", 12)):
    print(f"=== {edition} ===")
    names = by_edition[edition]
    check(f"{edition} 工具数 = {want_n}", len(names) == want_n, f"got {len(names)}")

    skill_path = os.path.join(HERE, "skills", f"wechat-mcp-{edition}", "SKILL.md")
    check(f"{edition} 技能文件存在", os.path.isfile(skill_path), skill_path)
    if not os.path.isfile(skill_path):
        continue
    text = open(skill_path, encoding="utf-8").read()

    fm = re.match(r"^---\n(.*?)\n---\n", text, re.S)
    check(f"{edition} 有 frontmatter", bool(fm))
    if fm:
        head = fm.group(1)
        check(f"{edition} frontmatter 的 name 与目录名一致", f"wechat-mcp-{edition}" in head)
        desc = re.search(r"^description:\s*(.+)$", head, re.M)
        check(f"{edition} description 够长（靠它判触发场景）",
              bool(desc) and len(desc.group(1)) > 40, f"{len(desc.group(1)) if desc else 0} 字")

    # ① 本档的工具一个都不能漏写
    missing = [n for n in names if f"`{n}`" not in text]
    check(f"{edition} 技能提到了全部 {len(names)} 个工具", not missing, f"漏：{missing}")

    # ② 别档独有的工具不许被当成自己的
    other = by_edition["lite" if edition == "pro" else "pro"]
    extra = [n for n in other if n not in names and f"`{n}`" in text]
    if edition == "lite":
        ok = all(re.search(r"(没有|不在你的工具列表|换高级版)", text) for _ in extra)
        check("lite 提到 pro 独有工具时，是在「本版没有」的语境里", ok, str(extra))
    else:
        check("pro 技能不含别档独有工具（本档应是全集）", not extra, str(extra))

print()
if skipped:
    print(f"（跳过 {skipped} 项）")
print("结果：" + ("全部通过" if not fails else f"{len(fails)} 项失败 -> {fails}"))
sys.exit(1 if fails else 0)
