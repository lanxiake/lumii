# -*- coding: utf-8 -*-
"""独立版：微信 4.1+ 数据库密钥提取（只读 Config.Cipher 内存扫描，不注入）。

改写自 sunhanaix/pc_wechat_exp 的 config_cipher_extract.py（去掉了其 engine.* 依赖）。
仅用 PROCESS_VM_READ | PROCESS_QUERY_INFORMATION，不注入、不重启微信。

用法: python wxkey4.py <db_storage目录>
输出: 每条 "salt=<32hex> key=<64hex> db=<相对路径>"
"""
import ctypes
import ctypes.wintypes as wt
import hashlib
import hmac as hmac_mod
import os
import re
import struct
import sys
import time

PAGE_SZ = 4096
KEY_SZ = 32
SALT_SZ = 16
HMAC_SZ = 64
RESERVE_SZ = 80
IV_SZ = 16

CONFIG_CIPHER_NAME = b'com.Tencent.WCDB.Config.Cipher'
CONFIG_XOR_MASK = bytes.fromhex(
    "d2c7442458020000004889442450488b"
    "450048844c2448488944254048584c24"
)
CONFIG_BLOB_MAX = 1024
CONFIG_LITERAL_RE = re.compile(rb"[xX]'([0-9a-fA-F]{64,192})'")
MAX_USER_ADDRESS = 0x0000_8000_0000_0000

_KNOWN_EXE_NAMES = {'weixin.exe', 'wechat.exe'}

kernel32 = ctypes.windll.kernel32
MEM_COMMIT = 0x1000
READABLE = {0x02, 0x04, 0x08, 0x10, 0x20, 0x40, 0x80}


class MBI(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_uint64), ("AllocationBase", ctypes.c_uint64),
        ("AllocationProtect", wt.DWORD), ("_pad1", wt.DWORD),
        ("RegionSize", ctypes.c_uint64), ("State", wt.DWORD),
        ("Protect", wt.DWORD), ("Type", wt.DWORD), ("_pad2", wt.DWORD),
    ]


def verify_enc_key(enc_key, db_page1):
    salt = db_page1[:SALT_SZ]
    mac_salt = bytes(b ^ 0x3A for b in salt)
    mac_key = hashlib.pbkdf2_hmac("sha512", enc_key, mac_salt, 2, dklen=KEY_SZ)
    hmac_data = db_page1[SALT_SZ: PAGE_SZ - RESERVE_SZ + IV_SZ]
    stored_hmac = db_page1[PAGE_SZ - HMAC_SZ: PAGE_SZ]
    hm = hmac_mod.new(mac_key, hmac_data, hashlib.sha512)
    hm.update(struct.pack("<I", 1))
    return hm.digest() == stored_hmac


def collect_db_files(db_dir):
    """返回 (files, salt_to_dbs)；files=[(rel, path, size, salt_hex, page1)]"""
    files, salt_to_dbs = [], {}
    for root, _dirs, names in os.walk(db_dir):
        for n in names:
            if not n.lower().endswith(".db"):
                continue
            p = os.path.join(root, n)
            try:
                sz = os.path.getsize(p)
                if sz < PAGE_SZ:
                    continue
                with open(p, "rb") as f:
                    page1 = f.read(PAGE_SZ)
            except OSError:
                continue
            salt_hex = page1[:SALT_SZ].hex()
            rel = os.path.relpath(p, db_dir)
            files.append((rel, p, sz, salt_hex, page1))
            salt_to_dbs.setdefault(salt_hex, []).append(rel)
    return files, salt_to_dbs


def find_wechat_pids():
    TH32CS_SNAPPROCESS = 0x00000002
    INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value
    PROCESS_QUERY_INFORMATION = 0x0400
    PROCESS_VM_READ = 0x0010

    class PROCESSENTRY32(ctypes.Structure):
        _fields_ = [
            ("dwSize", wt.DWORD), ("cntUsage", wt.DWORD), ("th32ProcessID", wt.DWORD),
            ("th32DefaultHeapID", ctypes.POINTER(ctypes.c_ulong)), ("th32ModuleID", wt.DWORD),
            ("cntThreads", wt.DWORD), ("th32ParentProcessID", wt.DWORD),
            ("pcPriClassBase", wt.LONG), ("dwFlags", wt.DWORD),
            ("szExeFile", ctypes.c_char * 260),
        ]

    class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
        _fields_ = [
            ("cb", wt.DWORD), ("PageFaultCount", wt.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t), ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t), ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t), ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t), ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    snapshot = kernel32.CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0)
    if snapshot == INVALID_HANDLE_VALUE:
        return []
    pids = []
    pe = PROCESSENTRY32()
    pe.dwSize = ctypes.sizeof(PROCESSENTRY32)
    psapi = ctypes.windll.psapi
    if kernel32.Process32First(snapshot, ctypes.byref(pe)):
        while True:
            exe = pe.szExeFile.decode("utf-8", errors="replace").lower()
            if exe in _KNOWN_EXE_NAMES:
                pid = pe.th32ProcessID
                h = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
                mem = 0
                if h:
                    try:
                        pmc = PROCESS_MEMORY_COUNTERS()
                        pmc.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
                        if psapi.GetProcessMemoryInfo(h, ctypes.byref(pmc), pmc.cb):
                            mem = pmc.WorkingSetSize
                    finally:
                        kernel32.CloseHandle(h)
                pids.append((mem, pid))
            if not kernel32.Process32Next(snapshot, ctypes.byref(pe)):
                break
    kernel32.CloseHandle(snapshot)
    pids.sort(key=lambda x: x[0], reverse=True)
    return pids


def read_mem(h, addr, sz):
    buf = ctypes.create_string_buffer(sz)
    n = ctypes.c_size_t(0)
    if kernel32.ReadProcessMemory(h, ctypes.c_uint64(addr), buf, sz, ctypes.byref(n)):
        return buf.raw[:n.value]
    return None


def enum_regions(h):
    regs = []
    addr = 0
    mbi = MBI()
    while addr < 0x7FFFFFFFFFFF:
        if kernel32.VirtualQueryEx(h, ctypes.c_uint64(addr), ctypes.byref(mbi),
                                   ctypes.sizeof(mbi)) == 0:
            break
        if (mbi.State == MEM_COMMIT and mbi.Protect in READABLE
                and 0 < mbi.RegionSize < 500 * 1024 * 1024):
            regs.append((mbi.BaseAddress, mbi.RegionSize))
        nxt = mbi.BaseAddress + mbi.RegionSize
        if nxt <= addr:
            break
        addr = nxt
    return regs


def _u64_from(data, offset):
    if offset < 0 or offset + 8 > len(data):
        return 0
    return struct.unpack_from("<Q", data, offset)[0]


def _probable_32_byte_key(data):
    return (len(data) == KEY_SZ and len(set(data)) >= 15
            and data not in {b"\x00" * KEY_SZ, b"\xff" * KEY_SZ})


def _xor_repeat(data, mask):
    return bytes(v ^ mask[i % len(mask)] for i, v in enumerate(data))


def _iter_chunks(regions, read_region, chunk_size=2 * 1024 * 1024, overlap=0):
    for base, size in regions:
        offset = 0
        tail, tail_base = b"", base
        while offset < size:
            cur = min(chunk_size, size - offset)
            chunk = read_region(base + offset, cur) or b""
            data_base = tail_base if tail else base + offset
            data = tail + chunk
            if data:
                yield data_base, data
                if overlap:
                    tail = data[-overlap:]
                    tail_base = data_base + max(0, len(data) - len(tail))
                else:
                    tail, tail_base = b"", base + offset + cur
            else:
                tail, tail_base = b"", base + offset + cur
            offset += cur


def _blob_key_candidates(blob):
    if not blob or len(blob) > CONFIG_BLOB_MAX:
        return
    decoded = _xor_repeat(blob, CONFIG_XOR_MASK)
    seen = set()
    for m in CONFIG_LITERAL_RE.finditer(decoded):
        run = m.group(1).decode("ascii").lower()
        starts = [0]
        if len(run) > 96:
            starts.extend(range(0, len(run) - 63, 32))
            starts.append(len(run) - 64)
        for start in dict.fromkeys(starts):
            if start < 0 or start + 64 > len(run):
                continue
            key_hex = run[start:start + 64]
            try:
                key = bytes.fromhex(key_hex)
            except ValueError:
                continue
            if not _probable_32_byte_key(key):
                continue
            embedded = run[start + 64:start + 96] if start + 96 <= len(run) else None
            item = (key_hex, embedded)
            if item not in seen:
                seen.add(item)
                yield item


# ---------------------------------------------------------------------------
# 从 Config.Cipher 节点里挖出 blob
#
# **快路径**按实测布局读（4.1.15：`node+0x28` → 对象 `+0x88` → `{ptr@+0x8, len@+0x10}`）。
# 微信一旦挪了内部结构，快路径就什么都挖不到——这正是"换版本即整体失效"的那类硬绑定。
#
# 所以加了**无偏移兜底**：把节点窗口里每个 qword 都当候选指针、把候选对象里每个 qword 对当
# `{ptr, len}`，**唯一判据是 `verify_enc_key` 能不能过**。错候选在密码学上必然验不过，
# 代价只是几次内存读——这也是为什么这条路可以"瞎试"而不怕给出错值。
#
# ⚠️ 兜底路径**没有在第二个微信版本上验证过**（本机只有 4.1.15，无版本可换）。
#    它不可能给出**错的**密钥（判据是验签），但"能不能真的救回新版本"尚未证实。
# ---------------------------------------------------------------------------
NODE_READ = 0x100             # 节点窗口读多大（快路径只要 0x50，兜底要扫得更宽）
_FAST_NODE_PTR_OFF = 0x28     # 快路径：node 里的 config 指针偏移
_FAST_OBJ_OFF = 0x88          # 快路径：config 对象里的 blob 访问器偏移
_FAST_OBJ_PTR = 0x8
_FAST_OBJ_LEN = 0x10
_GENERIC_SCAN_FROM = 0x20     # 兜底扫描起点（0x20 之前是节点头，不放指针）
_GENERIC_MAX_CFG_PTRS = 12    # 每个节点最多试几个候选指针，防止病态内存把扫描拖死


def _blob_keys_from_node(h, node, seen_cands, stats, remaining=None):
    """把节点窗口里所有可能的 blob 都挖出来，逐个交给 `_blob_key_candidates` 拆密钥。

    **固定偏移优先，验不过才做偏移探测**：快路径按已验证布局读，只有它真的让调用方
    **验过一个库**（`remaining` 变小）才收工；否则继续无偏移兜底。这是新版本自救的关键——
    "读到了 blob" 不等于 "拆出了能用的密钥"，按前者提前收工就会白白跳过兜底。

    产出 `(key_hex, embedded_salt)`；按 `seen_cands` 去重（跨节点也去重）。
    """
    def blob_at(data_ptr, data_len):
        if not (0 < data_len <= CONFIG_BLOB_MAX and 0x10000 <= data_ptr < MAX_USER_ADDRESS):
            return None
        blob = read_mem(h, data_ptr, int(data_len))
        return blob if blob and len(blob) == data_len else None

    def emit(blob):
        for key_hex, emb_salt in _blob_key_candidates(blob):
            cand = (key_hex, emb_salt)
            if cand in seen_cands:
                continue
            seen_cands.add(cand)
            stats["candidates"] += 1
            if emb_salt:
                stats["cand_salts"].add(emb_salt)
            yield key_hex, emb_salt

    # 快路径：已知布局（4.1.15 实测）
    config_ptr = _u64_from(node, _FAST_NODE_PTR_OFF)
    if 0x10000 <= config_ptr < MAX_USER_ADDRESS:
        obj = read_mem(h, config_ptr + _FAST_OBJ_OFF, 0x28)
        if obj and len(obj) >= 0x18:
            blob = blob_at(_u64_from(obj, _FAST_OBJ_PTR), _u64_from(obj, _FAST_OBJ_LEN))
            if blob:
                before = len(remaining) if remaining is not None else -1
                yield from emit(blob)
                if remaining is not None and len(remaining) < before:
                    stats["fast_nodes"] = stats.get("fast_nodes", 0) + 1
                    return
                # 固定偏移没救到任何库 → 落到下面的偏移探测

    # 兜底：无偏移探测（每个 qword 当候选对象指针，对象里每个 {ptr,len} 都试）
    tried = 0
    for off in range(_GENERIC_SCAN_FROM, len(node) - 8, 8):
        ptr = _u64_from(node, off)
        if not (0x10000 <= ptr < MAX_USER_ADDRESS):
            continue
        tried += 1
        if tried > _GENERIC_MAX_CFG_PTRS:
            break
        obj = read_mem(h, ptr, 0x100)
        if not obj:
            continue
        for i in range(0, len(obj) - 16, 8):
            blob = blob_at(_u64_from(obj, i), _u64_from(obj, i + 8))
            if blob:
                stats["generic_hits"] = stats.get("generic_hits", 0) + 1
                yield from emit(blob)


def scan_pid(pid, files, salt_to_dbs, key_map, remaining):
    stats = {"needles": 0, "nodes": 0, "candidates": 0, "verified": 0,
             "opened": False, "open_error": 0, "queryable": False,
             "regions": 0, "cand_salts": set(), "fast_nodes": 0, "generic_hits": 0}
    # 先用 **LIMITED_INFORMATION** 探一次：它跨权限级别也能开（同一用户的不同完整性级别），
    # 所以"能探到基本信息、却读不了内存"就精确指向**权限级别不一致**（错误 5），
    # 而"连基本信息都读不到"才是**另一个用户会话**。换机排查全靠这个区分。
    hq = kernel32.OpenProcess(0x1000, False, pid)
    if hq:
        stats["queryable"] = True
        kernel32.CloseHandle(hq)
    h = kernel32.OpenProcess(0x0010 | 0x0400, False, pid)  # VM_READ|QUERY
    if not h:
        stats["open_error"] = int(kernel32.GetLastError() or 0)
        return stats
    stats["opened"] = True
    try:
        regions = enum_regions(h)
        stats["regions"] = len(regions)
        if not regions:
            return stats

        needle_addrs = set()
        for base, data in _iter_chunks(regions, lambda a, s: read_mem(h, a, s),
                                       overlap=len(CONFIG_CIPHER_NAME) - 1):
            pos = data.find(CONFIG_CIPHER_NAME)
            while pos >= 0:
                needle_addrs.add(base + pos)
                pos = data.find(CONFIG_CIPHER_NAME, pos + 1)
        stats["needles"] = len(needle_addrs)
        if not needle_addrs:
            return stats

        pair_patterns = [struct.pack("<Q", a) + struct.pack("<Q", len(CONFIG_CIPHER_NAME))
                         for a in needle_addrs]
        seen_cands = set()
        for base, data in _iter_chunks(regions, lambda a, s: read_mem(h, a, s), overlap=0x80):
            if not remaining:
                break
            for pat in pair_patterns:
                pos = data.find(pat)
                while pos >= 0:
                    node_base = base + pos - 0x10
                    node = read_mem(h, node_base, NODE_READ)
                    if node and len(node) >= 0x40:
                        if (_u64_from(node, 0x10) in needle_addrs
                                and _u64_from(node, 0x18) == len(CONFIG_CIPHER_NAME)):
                            stats["nodes"] += 1
                            for key_hex, emb_salt in _blob_keys_from_node(
                                    h, node, seen_cands, stats, remaining):
                                try:
                                    key = bytes.fromhex(key_hex)
                                except ValueError:
                                    continue
                                targets = [emb_salt] if (emb_salt in remaining) else list(remaining)
                                for salt_hex in targets:
                                    if salt_hex not in remaining:
                                        continue
                                    for rel, _p, _sz, s, page1 in files:
                                        if s == salt_hex and verify_enc_key(key, page1):
                                            key_map[salt_hex] = (key_hex, rel)
                                            remaining.discard(salt_hex)
                                            stats["verified"] += 1
                                            break
                    pos = data.find(pat, pos + 1)
    finally:
        kernel32.CloseHandle(h)
    return stats


def main():
    db_dir = sys.argv[1]
    files, salt_to_dbs = collect_db_files(db_dir)
    print(f"[wxkey4] db_storage={db_dir}")
    print(f"[wxkey4] 发现 {len(files)} 个库，{len(salt_to_dbs)} 个不同 salt")
    if not files:
        print("[wxkey4] 没有可用的库文件")
        return
    pids = find_wechat_pids()
    print(f"[wxkey4] 微信进程: {[p for _, p in pids]}")
    if not pids:
        print("[wxkey4] 未检测到微信进程（需已登录运行）")
        return
    key_map, remaining = {}, set(salt_to_dbs)
    t0 = time.time()
    for mem, pid in pids:
        if not remaining:
            break
        st = scan_pid(pid, files, salt_to_dbs, key_map, remaining)
        print(f"[wxkey4] PID={pid} opened={st['opened']} err={st['open_error']} "
              f"regions={st['regions']} 字样={st['needles']} 节点={st['nodes']} "
              f"候选={st['candidates']} 通过={st['verified']}")
    print(f"[wxkey4] 耗时 {time.time()-t0:.1f}s，共验证 {len(key_map)}/{len(salt_to_dbs)} 个密钥")
    for salt_hex, (key_hex, rel) in sorted(key_map.items(), key=lambda kv: kv[1][1]):
        print(f"salt={salt_hex} key={key_hex} db={rel}")


if __name__ == "__main__":
    main()
