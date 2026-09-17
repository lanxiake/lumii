#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""最小 Agent Loop 教学实现 —— 《Agent 设计实践教程》第 1 章配套实验。

目标只有一个：让循环本身完全可读。一个 while 循环 + 一个工具字典 + 两类终止条件。
只依赖 Python 标准库；联网时走 OpenAI 兼容接口（urllib），不联网时用桩模型（StubModel）。

用法：
  python agent_loop.py                          # 离线桩模型跑内置演示任务（不需要 API key）
  python agent_loop.py --offline "你的任务"      # 桩模型跑你自己的任务
  python agent_loop.py "你的任务"                # 连 API（OpenAI 兼容）
环境变量：
  OPENAI_API_KEY   必填（联网模式）
  OPENAI_BASE_URL  默认 https://api.openai.com/v1
  MODEL_NAME       默认 gpt-4o-mini

对照章节：第 1 章 §六 —— 循环的每一行都能在正文里找到对应的概念。
"""
import json
import os
import re
import sys
import urllib.request
import urllib.error

if hasattr(sys.stdout, "reconfigure"):  # Windows 控制台中文兜底
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

HERE = os.path.dirname(os.path.abspath(__file__))
MAX_RESULT_CHARS = 400   # 工具结果回填上下文前的截断上限（最朴素的上下文工程）
MAX_STEPS = 8            # 终止条件一：最大步数

# ---------------------------------------------------------------- 工具层
# 约定：工具永远返回字符串。失败也返回 "ERROR: ..."——错误字符串会被回填
# 进上下文，模型下一轮“看得见”错误，这正是 agent 能自我纠错的最小组件。

def tool_calculator(expr: str) -> str:
    """安全计算器：只允许数字与 + - * / // % ** 括号，不执行任意代码。"""
    import ast, operator
    binops = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
              ast.Div: operator.truediv, ast.FloorDiv: operator.floordiv,
              ast.Mod: operator.mod, ast.Pow: operator.pow}
    def ev(node):
        if isinstance(node, ast.Expression):
            return ev(node.body)
        if isinstance(node, ast.Constant) and isinstance(node.value, (int, float)):
            return node.value
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            return +ev(node.operand) if isinstance(node.op, ast.UAdd) else -ev(node.operand)
        if isinstance(node, ast.BinOp) and type(node.op) in binops:
            return binops[type(node.op)](ev(node.left), ev(node.right))
        raise ValueError(f"不支持的语法节点: {type(node).__name__}")
    try:
        return repr(ev(ast.parse(expr, mode="eval")))
    except Exception as exc:
        return f"ERROR: 表达式无效 ({exc})"

def tool_read_file(path: str) -> str:
    """读取脚本目录下的文件（沙箱）。越界/不存在都返回错误字符串，不抛异常。"""
    target = os.path.normpath(os.path.join(HERE, path))
    if not target.startswith(os.path.normpath(HERE) + os.sep):
        return "ERROR: 越界路径，只允许读取脚本目录内的文件"
    if not os.path.isfile(target):
        return f"ERROR: 文件不存在: {path}"
    with open(target, encoding="utf-8", errors="replace") as fh:
        return fh.read(MAX_RESULT_CHARS)

def tool_append_note(text: str) -> str:
    """把一条备注追加到 notes.md——演示 agent 在会话之外“留下痕迹”。"""
    with open(os.path.join(HERE, "notes.md"), "a", encoding="utf-8") as fh:
        fh.write(f"- {text}\n")
    return f"已追加一条备注（{len(text)} 字符）"

TOOLS = {
    "calculator": {
        "fn": tool_calculator,
        "schema": {"type": "function", "function": {
            "name": "calculator",
            "description": "计算一个算术表达式，返回数值结果。",
            "parameters": {"type": "object", "properties": {
                "expr": {"type": "string", "description": "如 (128+64)*3"}},
                "required": ["expr"]}}},
    },
    "read_file": {
        "fn": tool_read_file,
        "schema": {"type": "function", "function": {
            "name": "read_file",
            "description": "读取脚本目录内某个文本文件的内容（最多返回前 400 字符）。",
            "parameters": {"type": "object", "properties": {
                "path": {"type": "string", "description": "相对脚本目录的路径"}},
                "required": ["path"]}}},
    },
    "append_note": {
        "fn": tool_append_note,
        "schema": {"type": "function", "function": {
            "name": "append_note",
            "description": "把一段文字作为备注追加到 notes.md，用于把结论留存到本次会话之外。",
            "parameters": {"type": "object", "properties": {
                "text": {"type": "string", "description": "备注内容"}},
                "required": ["text"]}}},
    },
}

# ---------------------------------------------------------------- 模型层
# 两个实现，同一个接口：f(messages: list[dict]) -> assistant message dict
# 这正是 harness 与 model 的分界：把 call_openai 换成 StubModel，循环一行没改。

def call_openai(messages: list) -> dict:
    base = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1").rstrip("/")
    payload = {
        "model": os.environ.get("MODEL_NAME", "gpt-4o-mini"),
        "messages": messages,
        "tools": [t["schema"] for t in TOOLS.values()],
    }
    req = urllib.request.Request(
        base + "/chat/completions",
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": "Bearer " + os.environ["OPENAI_API_KEY"]},
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            body = json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"API 调用失败 {exc.code}: {exc.read().decode('utf-8', 'replace')[:400]}")
    return body["choices"][0]["message"]

class StubModel:
    """离线桩模型：不调用任何 API，也能把循环走完整。

    它是无状态的：每一轮从 messages 里数出“已有几条工具结果 k”，
    再按任务文本推演出的固定动作序列，返回第 k 个工具调用；
    全部做完后返回纯文本——于是循环自然终止。
    请对照第 1 章 §二.4：模型负责“决定下一步”，harness 负责“执行与回填”。
    """

    def __call__(self, messages: list) -> dict:
        task = next(m["content"] for m in messages if m["role"] == "user")
        done = [m for m in messages if m["role"] == "tool"]
        actions = self._plan(task)
        if len(done) < len(actions):
            name, args = actions[len(done)]
            return {"role": "assistant",
                    "content": f"(stub) 我决定调用 {name}。",
                    "tool_calls": [{"id": f"call_{len(done)+1}", "type": "function",
                                    "function": {"name": name,
                                                 "arguments": json.dumps(args, ensure_ascii=False)}}]}
        summary = "; ".join(f"{m['content'][:60]}" for m in done)
        return {"role": "assistant",
                "content": f"(stub) 任务完成。已执行 {len(actions)} 次工具调用：{summary}",
                "tool_calls": None}

    @staticmethod
    def _plan(task: str) -> list:
        """从任务文本里用规则推演出动作序列（仅用于教学演示）。"""
        actions = []
        m = re.search(r"计算\s*([\d\s.+\-*/%()]+)", task)
        if m:
            actions.append(("calculator", {"expr": m.group(1).strip()}))
        m = re.search(r"读取\s*([\w./\\-]+\.\w+)", task)
        if m:
            actions.append(("read_file", {"path": m.group(1)}))
        if re.search(r"记录|备注|保存", task):
            actions.append(("append_note", {"text": f"任务[{task[:20]}…]的关键结果已由 stub 汇总"}))
        return actions

# ---------------------------------------------------------------- Agent 循环（全章的主角）

SYSTEM_PROMPT = (
    "你是一个会用工具的助手。可用工具：calculator、read_file、append_note。"
    "需要时调用工具；信息足够后，直接用纯文本给出最终回答，不要再调用工具。"
)

def agent_loop(task: str, model, max_steps: int = MAX_STEPS) -> str:
    messages = [{"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": task}]
    print(f"\n=== 任务 ===\n{task}")
    for step in range(1, max_steps + 1):
        # 上下文组装：messages 就是模型这一轮看到的全部世界。
        msg = model(messages)
        messages.append(msg)
        print(f"\n--- 第 {step} 步 ---")
        if msg.get("content"):
            print("assistant:", msg["content"][:300])
        calls = msg.get("tool_calls") or []
        if not calls:                      # 终止条件二：不再请求工具 == 模型认为已答完
            print(f"\n[终止] 第 {step} 步无工具调用，采纳最终回答")
            return msg.get("content") or ""
        for call in calls:                 # 工具执行与结果回填
            fn = call["function"]["name"]
            try:
                args = json.loads(call["function"]["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {}
            tool = TOOLS.get(fn)
            result = (tool["fn"](**args) if tool
                      else f"ERROR: 未知工具 {fn}，可用: {list(TOOLS)}")
            print(f"[{fn}]({args}) -> {result[:200]}")
            messages.append({"role": "tool", "tool_call_id": call["id"],
                             "content": str(result)[:MAX_RESULT_CHARS]})
    print(f"\n[终止] 达到最大步数 {max_steps}，强制停止")   # 终止条件一兜底
    return "(无最终回答：被最大步数终止)"

# ---------------------------------------------------------------- 入口

DEMO_TASK = ("先计算 (128+64)*3，再读取 sample_data/orders.md，"
             "最后把结果记录为一条备注。")

def main() -> None:
    args = [a for a in sys.argv[1:] if a != "--offline"]
    offline = "--offline" in sys.argv[1:] or not os.environ.get("OPENAI_API_KEY")
    if offline:
        print("[模式] 离线桩模型（StubModel）——不调用任何 API，只为看清控制流")
        model = StubModel()
    else:
        print(f"[模式] OpenAI 兼容接口 base={os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1')}")
        model = call_openai
    task = args[0] if args else DEMO_TASK
    agent_loop(task, model)

if __name__ == "__main__":
    main()
