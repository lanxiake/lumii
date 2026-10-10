#!/usr/bin/env python3
"""Comprehensive Test Suite for WeChat MCP v0.6.2"""
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

def test_diagnostics():
    """Test 1: Diagnostics data collection"""
    import wechat_sender as ws

    print("\n" + "="*70)
    print("  Test 1: Diagnostics Collection")
    print("="*70)

    ws._LAST_DIAGNOSTICS = {k: None for k in ws._LAST_DIAGNOSTICS}
    ws._record_diagnostics(ui_readable=True, session_count=12, best_match_score=0.85)

    diag = ws.last_diagnostics()
    checks = [
        (diag.get('ui_readable') == True, 'ui_readable'),
        (diag.get('session_count') == 12, 'session_count'),
        (diag.get('best_match_score') == 0.85, 'best_match_score'),
    ]

    passed = all(c[0] for c in checks)
    for ok, name in checks:
        print(f"  {'[PASS]' if ok else '[FAIL]'} {name}")

    return passed

def test_error_classification():
    """Test 2: Error code classification"""
    import server

    print("\n" + "="*70)
    print("  Test 2: Error Code Classification")
    print("="*70)

    tests = [
        ('target_unconfirmed', 'target'),
        ('ui_unresponsive', 'send'),
        ('env_not_ready', 'env'),
        ('input_not_landed', 'input'),
    ]

    passed = True
    for code, expected in tests:
        stage = server._stage_of(code)
        ok = expected in stage
        print(f"  {'[PASS]' if ok else '[FAIL]'} {code} -> {stage}")
        if not ok:
            passed = False

    return passed

def test_retry_logic():
    """Test 3: Retry mechanism"""
    import server

    print("\n" + "="*70)
    print("  Test 3: Retry Logic")
    print("="*70)

    # 收发的 detail 一律用**发送层真实产出的中文文案**（`_code_of` 的码表就是照它写的）。
    # 别在这里造 `input_not_landed: xxx` 这种英文格式——生产链路永远不返回它，
    # 那样测的只是「测试自己编的字符串能不能被解析」，等于没测。
    class Counter:
        def __init__(self):
            self.count = 0

    c1 = Counter()
    def retriable():
        c1.count += 1
        if c1.count < 2:
            return (False, "投递输入失败（输入未落地）")
        return (True, "已发送")

    ok, detail, attempts = server._send_with_retry(retriable, max_retries=2, retry_delay=0.1)
    test1 = ok and attempts == 2 and c1.count == 2
    print(f"  {'[PASS]' if test1 else '[FAIL]'} Retriable error retried (attempts={attempts}, called={c1.count})")

    # 语义存疑的那类绝不能重试：重试 = 给好友发第二遍
    c2 = Counter()
    def nonretriable():
        c2.count += 1
        return False, "目标会话未确认（更像其它会话）"

    ok, detail, attempts = server._send_with_retry(nonretriable, max_retries=2, retry_delay=0.1)
    test2 = not ok and attempts == 1 and c2.count == 1
    print(f"  {'[PASS]' if test2 else '[FAIL]'} Non-retriable stopped (attempts={attempts}, called={c2.count})")

    # `send_not_confirmed`：已经回车了但库里没看到 —— 最危险的一类，绝不重试
    c3 = Counter()
    def ambiguous():
        c3.count += 1
        return False, "未见新消息（send_not_confirmed）"

    ok, detail, attempts = server._send_with_retry(ambiguous, max_retries=2, retry_delay=0.1)
    test3 = not ok and attempts == 1 and c3.count == 1
    print(f"  {'[PASS]' if test3 else '[FAIL]'} Ambiguous send NOT retried (attempts={attempts}, called={c3.count})")

    return test1 and test2 and test3

def test_tools():
    """Test 4: Tool definitions"""
    import server

    print("\n" + "="*70)
    print("  Test 4: Tool Definitions")
    print("="*70)

    tools = server.TOOLS
    print(f"  Total tools: {len(tools)}")

    key_tools = ['send_text', 'send_file', 'read_history', 'list_sessions']
    passed = True

    for name in key_tools:
        tool = next((t for t in tools if t['name'] == name), None)
        if tool:
            params = len(tool.get('inputSchema', {}).get('properties', {}))
            print(f"  [PASS] {name:20s} ({params} params)")
        else:
            print(f"  [FAIL] {name:20s} NOT FOUND")
            passed = False

    return passed

def test_environment():
    """Test 5: Real environment check"""
    import wechat_core as core
    import wechat_sender as ws

    print("\n" + "="*70)
    print("  Test 5: Environment Check")
    print("="*70)

    try:
        pids = ws.weixin_pids()
        print(f"  WeChat running: {len(pids) > 0} (PIDs: {pids[:2] if pids else []})")
    except Exception as e:
        print(f"  [WARN] Process check: {e}")
        return False

    try:
        hwnd = ws.find_main_hwnd()
        print(f"  Window found: {hwnd is not None} (hwnd={hwnd})")
    except Exception as e:
        print(f"  [WARN] Window check: {e}")

    try:
        sessions = core.sessions()
        print(f"  Sessions: {len(sessions)} available")
    except Exception as e:
        print(f"  [FAIL] Database: {e}")
        return False

    return True

def test_dry_run():
    """Test 6: Dry-run sends"""
    import wechat_sender as ws

    print("\n" + "="*70)
    print("  Test 6: Dry-Run Sends")
    print("="*70)

    cases = [
        ("Normal text", "Test normal"),
        ("Emoji", "Test emoji"),
        ("Long text", "Long " * 30),
    ]

    passed = True
    for desc, text in cases:
        try:
            ok, detail = ws.send_text(text, 'filehelper', dry_run=True, verbose=False)
            result = ok or 'dry' in detail.lower() or 'env_not_ready' in detail
            print(f"  {'[PASS]' if result else '[FAIL]'} {desc:15s} - {detail[:40]}")
            if not result:
                passed = False
        except Exception as e:
            print(f"  [FAIL] {desc:15s} - {e}")
            passed = False

    return passed

def main():
    print("\n" + "="*70)
    print("  WECHAT MCP COMPREHENSIVE TEST SUITE v0.6.2")
    print("  (Prompt Enhancement + Diagnostics)")
    print("="*70)

    tests = [
        ("Diagnostics", test_diagnostics),
        ("Error Classification", test_error_classification),
        ("Retry Logic", test_retry_logic),
        ("Tool Definitions", test_tools),
        ("Environment", test_environment),
        ("Dry-Run", test_dry_run),
    ]

    results = []
    for name, func in tests:
        try:
            passed = func()
            results.append((name, passed))
        except Exception as e:
            print(f"\n  [ERROR] {name}: {e}")
            import traceback
            traceback.print_exc()
            results.append((name, False))

    print("\n" + "="*70)
    print("  SUMMARY")
    print("="*70)

    for name, passed in results:
        print(f"  {'[PASS]' if passed else '[FAIL]'} {name}")

    passed_count = sum(1 for _, p in results if p)
    print(f"\n  {passed_count}/{len(results)} passed")

    return 0 if passed_count == len(results) else 1

if __name__ == '__main__':
    sys.exit(main())
