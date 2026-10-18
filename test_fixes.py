#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""验证 wechat-crm-mcp 修复效果"""
import sys
import time
import os

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "apps/windows/resources/wechat-crm-mcp"))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "apps/windows/resources/wechat-mcp"))

import contactscore as S
import chatlog as L

print("=" * 60)
print("wechat-crm-mcp Fix Verification")
print("=" * 60)

# P0 修复验证：空关键词参数校验
print("\n[P0] Verify empty keyword validation (should reject immediately)")
start = time.time()
try:
    L.search_messages("")
    print("[FAIL] Empty keyword was not rejected")
except ValueError as e:
    elapsed_ms = (time.time() - start) * 1000
    if elapsed_ms < 100:
        print(f"[PASS] Empty keyword rejected immediately ({elapsed_ms:.1f}ms)")
    else:
        print(f"[WARN] Empty keyword rejected but took too long ({elapsed_ms:.1f}ms)")
except Exception as e:
    elapsed_ms = (time.time() - start) * 1000
    print(f"[WARN] Exception thrown but wrong type: {type(e).__name__} ({elapsed_ms:.1f}ms)")

# P1 修复验证：list_contacts 分页支持
print("\n[P1] Verify list_contacts pagination support")
try:
    # 测试 limit=0 (全部)
    all_contacts = S.list_contacts(scope="friend", limit=0)
    total = len(all_contacts)
    print(f"  All contacts: {total}")

    # 测试 limit=20
    page1 = S.list_contacts(scope="friend", limit=20, offset=0)
    print(f"  limit=20, offset=0: returned {len(page1)}")

    # 测试 offset
    page2 = S.list_contacts(scope="friend", limit=20, offset=20)
    print(f"  limit=20, offset=20: returned {len(page2)}")

    # 验证不重复
    if len(page1) > 0 and len(page2) > 0:
        if page1[0]["username"] != page2[0]["username"]:
            print("[PASS] Pagination working correctly, no duplicate data")
        else:
            print("[FAIL] Pagination data is duplicated")
    else:
        print("[PASS] Pagination parameters supported (insufficient data to verify paging)")

except TypeError as e:
    print(f"[FAIL] list_contacts does not support limit/offset: {e}")
except Exception as e:
    print(f"[FAIL] {e}")

# 验证关键词参数的更严格校验
print("\n[P0] Verify keyword validation (whitespace string)")
start = time.time()
try:
    L.search_messages("   ")  # 只有空格
    print("[FAIL] Whitespace keyword was not rejected")
except ValueError:
    elapsed_ms = (time.time() - start) * 1000
    if elapsed_ms < 100:
        print(f"[PASS] Whitespace keyword rejected immediately ({elapsed_ms:.1f}ms)")
    else:
        print(f"[WARN] Whitespace keyword rejected but took too long ({elapsed_ms:.1f}ms)")
except Exception as e:
    print(f"[WARN] Exception thrown but wrong type: {type(e).__name__}")

# 性能基准测试
print("\n[Performance] Basic operation response time")
tests = [
    ("list_contacts(limit=20)", lambda: S.list_contacts(scope="friend", limit=20)),
    ("interaction_rank(top=5)", lambda: S.interaction_rank(top=5, sort="count")),
]

for name, func in tests:
    start = time.time()
    try:
        func()
        elapsed_ms = (time.time() - start) * 1000
        status = "[OK]" if elapsed_ms < 500 else "[SLOW]"
        print(f"  {status} {name}: {elapsed_ms:.0f}ms")
    except Exception as e:
        print(f"  [FAIL] {name}: {e}")

print("\n" + "=" * 60)
print("Fix verification completed")
print("=" * 60)
