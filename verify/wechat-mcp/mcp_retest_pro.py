# -*- coding: utf-8 -*-
"""用打包好的 pro 版 exe 重测上一轮失败的工具：语音转写 + 四个发送预演（全部 dry_run）。

运行：python verify/wechat-mcp/mcp_retest_pro.py [exe 路径]
"""
import glob
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import mcp_e2e_all as M  # noqa: E402

FH = M.FH


def main():
    """拉起 exe → 找语音/图片 → 逐个重测并打印汇总与失败详情。"""
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    exe = sys.argv[1] if len(sys.argv) > 1 else sorted(
        glob.glob(os.path.join(M.RES, "wechat-mcp", "dist", "pro", "wechat-mcp-*.exe")))[-1]
    c = M.Client("wechat-mcp", cmd=[exe])
    print("exe:", exe, "→", c.info, len(c.tools), "工具")
    try:
        env, _ = c.call("check_env")
        print("asr:", json.dumps((env or {}).get("asr"), ensure_ascii=False))
        print("can_send:", (env or {}).get("can_send"), " foreground:", (env or {}).get("foreground"),
              " minimized:", (env or {}).get("minimized"))
        s, _ = c.call("list_sessions", {"query": ""})
        voices, imgs = [], []
        for tk in ["filehelper"] + [x.get("talker") for x in s or []][:40]:
            h, _ = c.call("read_history", {"talker": tk, "limit": 300}, "_probe")
            M.RESULTS.pop()
            for m in (h or {}).get("messages", []):
                if m.get("type") == 34 and len(voices) < 8:
                    voices.append((tk, m["local_id"]))
                if m.get("type") == 3 and len(imgs) < 1:
                    imgs.append((tk, m["local_id"]))
        for tk, lid in imgs:
            c.call("read_image", {"talker": tk, "local_id": lid})
        ok_voice = 0
        for tk, lid in voices:
            d, _ = c.call("transcribe_voice", {"talker": tk, "local_id": lid}, f"lid={lid}")
            if isinstance(d, dict) and d.get("ok") is not False and "error" not in d:
                ok_voice += 1
                print("  转写样例：", str(d.get("text") or d)[:60])
        print(f"语音：{len(voices)} 条里转写成功 {ok_voice} 条")

        f = os.path.join(M.TMP, "e2e.txt")
        open(f, "w", encoding="utf-8").write("e2e")
        details = []
        for tool, args in (
                ("send_text", {"talker": FH, "text": "e2e 预演，不会发出", "dry_run": True}),
                ("send_file", {"talker": FH, "path": f, "dry_run": True}),
                ("send_batch", {"messages": [{"talker": FH, "text": "e2e 一"}], "dry_run": True}),
                ("reply_to", {"talker": FH, "quote": "e2e", "text": "e2e 引用预演", "dry_run": True})):
            d, _ = c.call(tool, args)
            details.append((tool, d))
    finally:
        c.close()

    print()
    for prod, tool, label, ok, ms, summ, is_err in M.RESULTS:
        print(f"{'OK ' if ok else ('ERR' if is_err else '-- ')} {tool:18} {label:12} {ms:>6}ms  {summ[:140]}")
    print()
    for tool, d in details:
        print(f"[{tool}]", json.dumps(d, ensure_ascii=False)[:700])


if __name__ == "__main__":
    main()
