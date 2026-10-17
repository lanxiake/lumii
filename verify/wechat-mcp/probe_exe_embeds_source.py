# -*- coding: utf-8 -*-
"""**产物里到底打进了哪份源码**——直接读 PyInstaller 归档里的模块字节码，不是搜压缩块。

为什么不能用 `strings exe | grep`：onefile 的载荷是 zlib 压过的，改没改进去**搜不出来**；
搜不到就断言"没打进去"是假阴性，偶尔在未压缩的元数据里蒙中就成假阳性。判据得是
**解压后那棵代码对象**里的字符串常量。

跑法：PYTHONIOENCODING=utf-8 ~/.lumii/runtimes/python-embed/python.exe probe_exe_embeds_source.py <exe>...
只读：只读文件。
"""
import os
import sys
import tempfile
import types

# PyInstaller 的归档读取器（构建用的那份 wheel 里就有）——**别装新依赖**，指过去即可
SP = r"C:\Users\75791\AppData\Local\uv\cache\archive-v0\VsvLMrP_tqQqy61X\Lib\site-packages"

# `(模块名, 该模块里必须有的字符串常量)`——代表"这份共享层的这一改动进没进产物"。
# ⚠️ 只能放**字符串常量**：函数名/变量名住在 `co_names` 里，拿它当判据必然假红。
WANT = [
    ("mcp_install", "适配的微信版本"),
    ("wechat_core", "VERIFIED_VERSION_PREFIXES"),
    ("wechat_core", "4.1.15"),     # 前缀的**值**也在，防止只打进一个空壳
]


def consts_strings(code, out):
    """递归收集一个代码对象里的**字符串常量**（含嵌套函数）。"""
    if isinstance(code, types.CodeType):
        for c in code.co_consts:
            if isinstance(c, str):
                out.add(c)
            elif isinstance(c, types.CodeType):
                consts_strings(c, out)
    return out


def module_strings(reader, name):
    """从 PYZ 里取一个模块 → 它的全部字符串常量；取不到返回 `None`。

    ⚠️ PyInstaller 6 的 `ZlibArchiveReader.extract` **直接返回 code 对象**（不是 pyc 字节），
    再喂 `marshal.loads` 会说 "a bytes-like object is required, not 'code'"。
    """
    import marshal
    co = reader.extract(name)
    if co is None:
        return None
    if not isinstance(co, types.CodeType):            # 换了实现就兼容回字节形态
        co = marshal.loads(co)
    return consts_strings(co, set())


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:                                               # noqa: BLE001
        pass
    sys.path.insert(0, SP)
    from PyInstaller.archive.readers import CArchiveReader, ZlibArchiveReader

    bad = 0
    for exe in sys.argv[1:]:
        print("=" * 78)
        print(exe)
        try:
            arch = CArchiveReader(exe)
            # ⚠️ `ZlibArchiveReader` 只吃**路径**（内部拿名字拼缓存/做 rfind），给 BytesIO 会炸
            tmp = os.path.join(tempfile.gettempdir(), "pyz-%d.pyz" % os.getpid())
            with open(tmp, "wb") as f:
                f.write(arch.extract("PYZ.pyz"))
            pyz = ZlibArchiveReader(tmp)
            names = set(pyz.toc)
        except Exception as e:                                      # noqa: BLE001
            print("  ✗ 解不开归档：%r" % (e,))
            bad += 1
            continue
        for mod, needle in WANT:
            if mod not in names:
                print("  ✗ %-16s 模块**根本不在产物里**（没法查 %r）" % (mod, needle))
                bad += 1
                continue
            try:
                strs = module_strings(pyz, mod)
            except Exception as e:                                  # noqa: BLE001
                print("  ✗ %-16s 取模块失败：%r" % (mod, e))
                bad += 1
                continue
            hit = any(needle in s for s in strs)
            print("  %s %-16s 含 %-28s （常量 %d 条）" % ("✓" if hit else "✗", mod, repr(needle), len(strs)))
            if not hit:
                bad += 1
    print("=" * 78)
    print("结论：%s" % ("全部产物都含当前共享层" if not bad else "有 %d 处对不上" % bad))
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
