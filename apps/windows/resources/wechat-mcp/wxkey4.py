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


def scan_pid(pid, files, salt_to_dbs, key_map, remaining):
    stats = {"needles": 0, "nodes": 0, "candidates": 0, "verified": 0,
             "opened": False, "open_error": 0, "regions": 0, "cand_salts": set()}
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
                    node = read_mem(h, node_base, 0x50)
                    if node and len(node) >= 0x40:
                        if (_u64_from(node, 0x10) in needle_addrs
                                and _u64_from(node, 0x18) == len(CONFIG_CIPHER_NAME)):
                            config_ptr = _u64_from(node, 0x28)
                            if 0x10000 <= config_ptr < MAX_USER_ADDRESS:
                                stats["nodes"] += 1
                                obj = read_mem(h, config_ptr + 0x88, 0x28)
                                if obj and len(obj) >= 0x18:
                                    data_ptr = _u64_from(obj, 0x8)
                                    data_len = _u64_from(obj, 0x10)
                                    if (0 < data_len <= CONFIG_BLOB_MAX
                                            and 0x10000 <= data_ptr < MAX_USER_ADDRESS):
                                        blob = read_mem(h, data_ptr, int(data_len))
                                        if blob and len(blob) == data_len:
                                            for key_hex, emb_salt in _blob_key_candidates(blob):
                                                cand = (key_hex, emb_salt)
                                                if cand in seen_cands:
                                                    continue
                                                seen_cands.add(cand)
                                                stats["candidates"] += 1
                                                if emb_salt:
                                                    stats["cand_salts"].add(emb_salt)
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
                                                    if salt_hex not in remaining:
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
