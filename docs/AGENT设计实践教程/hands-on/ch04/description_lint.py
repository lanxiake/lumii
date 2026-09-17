#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
实验 B：工具描述重写工作坊（纯标准库）
======================================
内置 3 个刻意写坏的 tool schema（歧义命名、无 when-to-use、错误信息无信息量）
与它们的重写版，按 10 项 checklist 静态打分，输出重写前后得分变化与逐项诊断。

checklist 的依据（详见教程第 4 章参考文献）：
  Anthropic《Writing tools for agents》(2025-09-11)：工具是确定性代码与
  非确定性模型之间的契约；描述要写清何时用/边界/返回；错误要把上下文回传给模型。
  Anthropic《Building effective agents》与工程博客的通用原则：简单、正交、可读。

用法：
  python description_lint.py            # 全部 3 个工具：坏版 vs 重写版
  python description_lint.py --bad-only # 只诊断坏版（做练习时先盲打分）
"""
import re
import sys

# ---------------------------------------------------------------- 10 项 checklist
# 每项 (编号, 名称, 判定函数, 修复建议)
# 判定函数签名 f(tool: dict) -> bool

VAGUE_NAMES = ["stuff", "data", "helper", "helpers", "misc", "utils", "util", "tool", "tools", "common", "general", "handle", "manager", "do_", "process_"]
VAGUE_WORDS = ["等等", "之类的", "相关的东西", "各种", "灵活处理", "智能处理", "相应处理"]


def _params(t):
    return t.get("parameters", {}) or {}


def c1_name(t):
    n = t.get("name", "")
    if not re.fullmatch(r"[a-z][a-z0-9_]*", n or ""):
        return False
    if any(v in (n or "") for v in VAGUE_NAMES):
        return False
    return "_" in n  # 动词_宾语 两段式，自带语义


def c2_when_use(t):
    d = t.get("description", "")
    return bool(re.search(r"何时使用|时使用|用于|适用", d))


def c3_when_not(t):
    d = t.get("description", "")
    return bool(re.search(r"不要使用|不适用|勿用|请勿|请改用|如需.{0,12}请(用|改用)", d))


def c4_param_contract(t):
    ps = _params(t)
    if not ps:
        return False
    props = ps.get("properties", {})
    if not props:
        return False
    typed = [k for k, v in props.items() if v.get("type") and v.get("description")]
    return len(typed) == len(props)


def c5_enum_default(t):
    props = _params(t).get("properties", {})
    enums = [k for k, v in props.items() if v.get("enum")]
    if not enums:
        return True  # 无枚举参数则该项不适用，视为通过
    return all(props[k].get("default") is not None or props[k].get("description") == props[k].get("description") and "默认" in props[k].get("description", "") for k in enums)


def c6_format_units(t):
    blob = t.get("description", "") + " " + t.get("returns", "") + " " + " ".join(str(v) for v in _params(t).get("properties", {}).values())
    return bool(re.search(r"ISO|ISO-8601|UTC|时区|毫秒|秒|UTF-8|路径|URL|邮箱|手机号|页码|单位|格式", blob))


def c7_examples(t):
    ex = t.get("examples")
    return bool(ex) and isinstance(ex, list) and len(ex) >= 1 and all(isinstance(e, dict) and e for e in ex)


def c8_error_actionable(t):
    errs = t.get("error_examples")
    if not errs or not isinstance(errs, list):
        return False
    good = 0
    for e in errs:
        msg = (e or {}).get("message", "")
        if re.search(r"error|错误|失败|failed|invalid$", msg.strip().lower()) and not re.search(r"请|建议|可用|试试|缺少|示例", msg):
            continue
        if re.search(r"请|建议|可用|试试|缺少|可选值|示例|应为|须|先", msg):
            good += 1
    return good >= 1 and good == len(errs)


def c9_no_vagueness(t):
    blob = t.get("description", "") + " " + " ".join(str(v.get("description", "")) for v in _params(t).get("properties", {}).values())
    return not any(v in blob for v in VAGUE_WORDS)


def c10_returns_contract(t):
    r = t.get("returns", "")
    if not r:
        return False
    return bool(re.search(r"返回|包含", r)) and bool(re.search(r"截断|分页|上限|最多|完整|next|继续", r))


CHECKS = [
    ("01", "命名：snake_case 动宾结构，无歧义词", c1_name, "把 do_stuff/process_data 这类名字改成 动词_对象，如 draft_reply"),
    ("02", "描述含『何时使用』", c2_when_use, "补一句正向场景：『需要 X 时使用』"),
    ("03", "描述含『何时不用』并指向兄弟工具", c3_when_not, "补反向边界：『如需 Y，请改用 other_tool』——同族工具靠互相指路消歧"),
    ("04", "输入契约：每个参数有类型+描述", c4_param_contract, "为每个参数补 type 与一句话描述，别只留参数名"),
    ("05", "枚举参数列出全部取值并给默认", c5_enum_default, "enum 列全取值；有默认值写明『默认 x』"),
    ("06", "格式/单位/时区显式声明", c6_format_units, "时间给 ISO-8601+时区，长度给单位，路径/邮箱/URL 给格式"),
    ("07", "至少一个完整调用示例", c7_examples, "加 examples：真实参数形状的 1-2 个例子"),
    ("08", "错误信息可行动（能指导自我修正）", c8_error_actionable, "错误里写明缺什么、合法值、下一步动作，不返回干巴巴的 error"),
    ("09", "描述无『等等/之类的/各种』式含糊话", c9_no_vagueness, "含糊词逐个替换成可判定的边界"),
    ("10", "返回契约：返回什么+截断/分页规则", c10_returns_contract, "写明返回结构、最大长度、被截断时如何取后续"),
]

# ---------------------------------------------------------------- 3 个刻意写坏的工具
BAD_TOOLS = [
    {
        "name": "process_data",
        "description": "处理各种数据，比如文件、表格、文本之类的。",
        "parameters": {"data": {"type": "string"}, "mode": {}},
        "error_examples": [{"message": "An error occurred"}],
    },
    {
        "name": "search_stuff",
        "description": "搜索。",
        "parameters": {"query": {"type": "string"}},
        "error_examples": [{"message": "failed"}],
    },
    {
        "name": "notify",
        "description": "通知用户，或者发消息。等等。",
        "parameters": {"user": {"type": "string"}, "msg": {"type": "string"}},
        "error_examples": [{"message": "error"}],
    },
]

# ---------------------------------------------------------------- 重写版
GOOD_TOOLS = [
    {
        "name": "transform_csv",
        "description": (
            "对 CSV 文本做结构化转换（筛选列、按列去重、改列名）时使用；输入必须是 CSV 纯文本而非文件路径。"
            "如需读取文件请先用 read_file；如需 Excel/合并单元格请用 spreadsheet_edit（不适用本工具）。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "csv_text": {"type": "string", "description": "CSV 纯文本，UTF-8 编码，首行为表头；单条不超过 200KB"},
                "mode": {"type": "string", "enum": ["dedupe", "rename", "select"], "description": "转换动作；默认 dedupe（按整行去重）"},
                "columns": {"type": "array", "items": {"type": "string"}, "description": "受影响的列名列表，须与表头完全一致"},
            },
            "required": ["csv_text", "mode"],
        },
        "examples": [
            {"csv_text": "id,name\n1,Alice\n1,Alice\n", "mode": "dedupe"},
            {"csv_text": "id,name\n", "mode": "rename", "columns": ["id", "customer"]},
        ],
        "returns": "返回转换后的完整 CSV 文本；超过 200KB 时只返回前 200KB 并附 truncated=true 与 row_cursor 供续取。",
        "error_examples": [
            {"message": "列名 'customer' 不在表头中；现有表头：id,name。columns 须与首行完全一致，可先传 mode=rename 校验。"}
        ],
    },
    {
        "name": "search_web",
        "description": (
            "需要公开互联网上的最新信息、新闻或事实时使用（返回前 10 条结果）。"
            "内部文档请用 search_docs，个人知识库请用 kb_query，不要使用本工具查未公开资料；"
            "需要多轮调研与成文报告请改用 deep_research。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "搜索关键词，1-6 个词，不要输入整句问话"},
                "days": {"type": "integer", "description": "限定最近 N 天的内容；默认 30"},
                "max_results": {"type": "integer", "description": "返回条数 1-10；默认 10"},
            },
            "required": ["query"],
        },
        "examples": [
            {"query": "Fed rate decision September 2026", "days": 7},
            {"query": "Model Context Protocol spec revision", "days": 180, "max_results": 5},
        ],
        "returns": "返回 JSON 列表：title/url/snippet/published_at（ISO-8601, UTC）；snippet 超 500 字符会截断并标注 truncated。",
        "error_examples": [
            {"message": "days 必须是 1-365 的整数，收到 0。查历史资料请去掉 days 参数或设 days=365。"}
        ],
    },
    {
        "name": "send_im_message",
        "description": (
            "向已知联系人或群发送一条即时消息（微信/企微/飞书）时使用，单次一个接收方。"
            "邮件请用 send_email，短信请用 send_sms；向 10 人以上群发属高风险操作，"
            "请改用 broadcast_message（带确认闸门），不要循环调用本工具。"
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "peer": {"type": "string", "description": "联系人或群的 ID，ID 格式：wx:<id> 或 grp:<id>；不接受昵称——先调 search_contacts 解析"},
                "text": {"type": "string", "description": "消息正文，最长 2000 字符，纯文本"},
                "at_all": {"type": "boolean", "description": "是否 @所有人；默认 false，群外接收方设置此参数会报错"},
            },
            "required": ["peer", "text"],
        },
        "examples": [
            {"peer": "wx:zhanglaosan", "text": "路上堵车，晚到十分钟"},
            {"peer": "grp:team-a", "text": "今天评审改到 15:00，会议室 B2"},
        ],
        "returns": "返回 message_id 与送达状态 sent/read；文本超限会整体报错，不会静默截断；peer 不存在时不自动建会话。",
        "error_examples": [
            {"message": "peer '老王' 不是合法 ID：格式应为 wx:<id>/grp:<id>。请先用 search_contacts(name='老王') 取得 ID。"}
        ],
    },
]


# ---------------------------------------------------------------- lint 输出
def lint(tool):
    rows, score = [], 0
    for cid, label, fn, fix in CHECKS:
        try:
            ok = bool(fn(tool))
        except Exception:
            ok = False
        score += ok
        rows.append((cid, label, ok, fix))
    return score, rows


def report(tool, show_all=True):
    score, rows = lint(tool)
    print(f"\n┌─ {tool.get('name')}  ——  {score}/10")
    for cid, label, ok, fix in rows:
        if ok and not show_all:
            continue
        print(f"│ {'✓' if ok else '✗'} [{cid}] {label}" + ("" if ok else f"\n│      → 建议：{fix}"))
    print("└" + "─" * 40)
    return score


def main():
    only_bad = "--bad-only" in sys.argv
    bad_scores, good_scores = [], []
    for bad, good in zip(BAD_TOOLS, GOOD_TOOLS):
        bs = report(bad)
        bad_scores.append(bs)
        if not only_bad:
            gs = report(good)
            good_scores.append(gs)
            print(f"│ {bad['name']} → {good['name']}：{bs}/10 → {gs}/10")
    if not only_bad:
        print(f"\n合计：坏版本 {sum(bad_scores)}/30 → 重写版 {sum(good_scores)}/30")
        print("练习：删掉 GOOD_TOOLS 里任意一项（如 c3 的反向边界句），观察同族工具错误率如何回升。")


if __name__ == "__main__":
    main()
