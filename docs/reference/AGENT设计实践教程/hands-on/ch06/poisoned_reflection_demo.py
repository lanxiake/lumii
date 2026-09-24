#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
「自信的错误解释」演示（第 6 章 · 实验 B）
==========================================
桩实现、完全离线。演示两种「从失败中学习」的机制在同一时间线上的分叉：

  A 线（自由反思直接入库）：一次失败 → 模型生成一段『自信但错误』的任务解释
     → 存入长期记忆 → 后续 5 个任务全部依据它决策 → 决策被系统性污染。
  B 线（程序化失败信号）：同一次失败 → 由代码比对『请求窗 vs 数据源更新时间』
     契约提取轨迹级失败信号 → 修正的是参数与流程，不是一段解释 → 后续任务恢复正常。

对应论文 Honest Lying（arXiv:2605.29463，预印本，C 级证据）：
  环境每次重置（每天都是新的一天），但记忆把上一次的错误解释带进下一个任务——
  这就是 memory confabulation。桩里「LLM 反思」返回的错误解释是硬编码的，
  演示的是机制，不是模型能力。

运行：python poisoned_reflection_demo.py
"""

# ---- 模拟世界（人定义的契约，程序可判定）----
SOURCE_CONTRACT = {
    "name": "sjsc 工单接口",
    "updated_at_daily": "12:00",   # 上游每天 12:00 才把当日工单补齐
    "timezone": "UTC+8",
}
AGENT_QUERY_TIME = "09:10"          # 任务固定在上午跑

def source_has_data(query_end: str) -> bool:
    """契约规定的真相：查询窗右边界晚于源更新时间才有当日数据。"""
    return query_end >= SOURCE_CONTRACT["updated_at_daily"]


# ---- 「LLM」桩：只会两种『学习』----
def confabulated_reflection() -> str:
    """硬编码的『自信但错误』解释——把『我窗算早了』曲解成『上游没数据』。"""
    return "工单接口经常没数据，返回空是正常的，直接上报 0 条即可，不用重试。"

def programmatic_failure_signal(query_end: str) -> str:
    """程序化提取的轨迹级失败信号：只陈述可验证的事实，不做解释。"""
    if not source_has_data(query_end):
        return (f"FAIL-SIGNAL: 请求窗右边界 {query_end} 早于源更新时间 "
                f"{SOURCE_CONTRACT['updated_at_daily']}，空结果不可归因为『无数据』；"
                f"动作=将窗口右边界对齐到更新时间之后。")
    return "FAIL-SIGNAL: 窗口设置无问题，失败原因在别处（转人工分类）。"


# ---- 决策桩：依据当前『记忆』选择查询窗 ----
def decide_window_A(memory: str | None) -> str:
    return AGENT_QUERY_TIME  # 拿着『空=没数据』的解释，永远不调整窗口，且见空即收

def decide_window_B(fix_rule: str | None) -> str:
    if fix_rule:
        return "12:30"        # B 线：失败信号驱动窗口对齐
    return AGENT_QUERY_TIME

def run_task(version: str, step: int, memory: str | None, fix: str | None):
    fam = ["日报汇总", "工单导出", "KPI 面板", "周报切片", "库存核对", "工单导出"][step % 6]
    if version == "A":
        win = decide_window_A(memory)
        note = "引用记忆解释：『接口经常没数据』" if memory else "无可用记忆，按默认窗执行"
    else:
        win = decide_window_B(fix)
        note = "应用窗口对齐修正" if fix else "无修正，按默认窗执行"
    success = source_has_data(win)
    trace = f"{AGENT_QUERY_TIME} 以窗口右边界 {win} 查询 → {'取回 41 条' if success else '空列表'}"
    return {"step": step, "task": fam, "window": win, "trace": trace,
            "note": note, "success": success}


def timeline(version: str):
    memory, fix = None, None
    rrr_hits = 0            # 错误解释被复用次数（对应论文的 RRR 思想）
    print("-" * 66)
    for step in range(6):
        r = run_task(version, step, memory, fix)
        mark = "✔" if r["success"] else "✘"
        print(f"  任务 {step}: {r['task']:6} | 窗右界 {r['window']} | {mark} {r['trace']}")
        print(f"          {r['note']}")
        if not r["success"] and step == 0:
            if version == "A":
                memory = confabulated_reflection()
                print(f"  ▶ 学习动作：反思入库 ——「{memory}」")
            else:
                sig = programmatic_failure_signal(r["window"])
                fix = sig
                print(f"  ▶ 学习动作：{sig}")
        elif not r["success"]:
            if version == "A" and memory:
                rrr_hits += 1
                print(f"  ↻ 依据记忆行动再次失败（错误解释第 {rrr_hits + 1} 次被倚重）——"
                      f"失败没有推翻解释，解释反而『解释』了失败")
    fails = 0
    return rrr_hits


def main():
    print("=" * 66)
    print("世界设定：数据源每天 12:00 补齐当日工单；Agent 每天 09:10 查询当日数据。")
    print("正确答案只有一个：把窗口右边界放到 12:00 之后（或改查昨日窗）。")
    print("=" * 66)

    print("\n【A 线】自由反思 → 解释直接入库（Reflexion 式，无验证门）")
    a_rrr = timeline("A")

    print("\n【B 线】程序化失败信号 → 修正参数与流程（Honest Lying 的 mitigation）")
    b_rrr = timeline("B")

    print("-" * 66)
    print("对照小结：")
    print(f"  A 线：错误解释被后续任务倚重 {a_rrr + 1} 次；环境每天重置，")
    print(f"        解释却跨任务存活——这正是 121 条反思 0 条命中正确目标的机制。")
    print(f"  B 线：没有任何自然语言解释入库，存活下来的是一条可执行的窗口修正；")
    print(f"        失败信号由代码判定，模型没有『自信』的机会。")
    print("  注意：A 线不是模型笨——桩里的解释在『当时那个任务』里貌似合理；")
    print("  危险在于它未经检验就获得了跨任务的指挥权。")


if __name__ == "__main__":
    main()
