# -*- coding: utf-8 -*-
"""
中文文案「去 AI 味」评分器

用法:
    python eval.py 稿件.md
    python eval.py --compare a.md b.md
    python eval.py --mode hook 钩子.md      # 钩子段：数字锚点不参与考核
    python eval.py --only numbers 稿件.md
"""
import re
import sys
import pathlib

# ---------- 词表 ----------
ABSTRACT_WORDS = [
    '赋能', '闭环', '抓手', '生态', '颗粒度', '链路', '沉淀', '复盘', '对齐',
    '拉通', '打通', '极致', '优雅', '强大', '无缝', '一站式', '全方位',
    '多维度', '深度赋能', '令人惊叹', '不容错过', '值得拥有', '开启新篇章',
    '助力', '加持', '护城河', '底层逻辑', '顶层设计', '范式', '心智',
]

CLICHE_OPEN = ['随着', '在当今', '众所周知', '在这个', '时代背景下']
CLICHE_END = ['总而言之', '综上所述', '拭目以待', '未来可期', '让我们']

FOUR_CHAR_PAT = re.compile(
    r'(?:稳定可靠|快速响应|易于维护|安全高效|性能卓越|功能强大|操作简便|'
    r'界面友好|扩展性强|兼容性好|开箱即用|轻量高效|简洁优雅|设计精美|'
    r'灵活多变|高效便捷|省时省力|事半功倍|得心应手|一目了然)'
)

# 阿拉伯数字 + 单位
NUMBER_PAT = re.compile(
    r'\d+(?:\.\d+)?\s*(?:MB|GB|KB|ms|毫秒|秒|分钟|小时|天|年|个|条|行|次|倍|%|W|Hz|万|千)'
    r'|v?\d+\.\d+(?:\.\d+)?'
    r'|\d{2,}'
)

# 中文数字 + 量词（如「三条路」「十个进程」「两个字母」）
CN_NUM = '一二三四五六七八九十百千两半'
CN_QUANT = '条个步种路类次遍张台件项款人秒天年月行字句点部分层片节'
CN_NUM_PAT = re.compile(f'[{CN_NUM}]+[{CN_QUANT}]')

PROPER_NOUNS = [
    'Electron', 'TypeScript', 'xterm', 'Netty', 'Swing', 'JVM', 'SSH', 'SFTP',
    'DPAPI', 'Keychain', 'libsecret', 'FinalShell', 'LiteShell', 'Node',
    'Chromium', 'Claude', 'Cursor', 'Cline', 'Ollama', 'Docker', 'nginx',
    'RDP', 'TOFU', 'JLine', 'BouncyCastle', 'FlatLaf', 'jVT220', 'React', 'Vite',
]


def clean(md: str) -> str:
    md = re.sub(r'```[\s\S]*?```', '', md)
    md = re.sub(r'`[^`]*`', '', md)
    md = re.sub(r'^\|.*$', '', md, flags=re.M)
    md = re.sub(r'^#{1,6}\s*', '', md, flags=re.M)
    md = re.sub(r'\*\*|\*|__', '', md)
    md = re.sub(r'\[([^\]]*)\]\([^)]*\)', r'\1', md)
    return md.strip()


def split_sentences(text: str):
    parts = re.split(r'[。！？；\n]+', text)
    return [p.strip() for p in parts if len(p.strip()) >= 2]


def score(path: pathlib.Path, mode: str = 'body'):
    body = clean(path.read_text(encoding='utf-8'))
    chars = len(re.sub(r'\s', '', body))
    sents = split_sentences(body)
    per100 = chars / 100 if chars else 1

    # 1 数字锚点（阿拉伯 + 中文数字 + 专名）
    nums_ar = NUMBER_PAT.findall(body)
    nums_cn = CN_NUM_PAT.findall(body)
    nouns = sum(1 for p in PROPER_NOUNS if p in body)
    anchors = len(nums_ar) + len(nums_cn) + nouns * 0.5
    a_density = anchors / per100 if per100 else 0

    if mode == 'hook':
        s1 = 12          # 钩子段不考核数字，给基准分
    elif a_density >= 2.0:
        s1 = 15
    elif a_density >= 1.5:
        s1 = 13
    elif a_density >= 1.0:
        s1 = 10
    elif a_density >= 0.5:
        s1 = 6
    else:
        s1 = 0

    # 2 抽象词
    ab_hits = [w for w in ABSTRACT_WORDS if w in body]
    ab_count = sum(body.count(w) for w in ab_hits)
    ab_density = ab_count / per100 if per100 else 0
    s2 = 12 if ab_count == 0 else (9 if ab_density <= 0.3 else (5 if ab_density <= 0.6 else 0))

    # 3 四字格
    four = FOUR_CHAR_PAT.findall(body)
    n4 = len(four)
    s3 = 10 if n4 <= 2 else (6 if n4 <= 5 else (2 if n4 <= 9 else 0))

    # 4 句长变异
    lens = [len(re.sub(r'\s', '', s)) for s in sents]
    if lens:
        mean = sum(lens) / len(lens)
        std = (sum((x - mean) ** 2 for x in lens) / len(lens)) ** 0.5
        cv = std / mean if mean else 0
    else:
        mean = std = cv = 0
    s4 = 10 if cv >= 0.55 else (7 if cv >= 0.40 else (4 if cv >= 0.25 else 0))

    # 5 人称
    wo = max(body.count('我') - body.count('我们'), 0)
    ni = body.count('你')
    s5 = 8 if (wo >= 3 and ni >= 3) else (5 if (wo >= 3 or ni >= 3) else 0)

    # 6 套话
    cl = 0
    if body[:60] and any(w in body[:60] for w in CLICHE_OPEN):
        cl += 1
    if any(w in body[-120:] for w in CLICHE_END):
        cl += 1
    s6 = 5 if cl == 0 else (2 if cl == 1 else 0)

    return {
        'file': path.name, 'chars': chars, 'sents': len(sents),
        'a_density': a_density, 'nums_ar': len(nums_ar), 'nums_cn': len(nums_cn),
        'nouns': nouns, 'cn_samples': nums_cn[:6],
        'ab_hits': ab_hits, 'ab_count': ab_count, 'ab_density': ab_density,
        'n4': n4, 'mean': mean, 'std': std, 'cv': cv,
        'wo': wo, 'ni': ni, 'cliche': cl,
        's': [s1, s2, s3, s4, s5, s6], 'total': sum([s1, s2, s3, s4, s5, s6]),
        'mode': mode,
    }


def report(r):
    print(f"文件: {r['file']}   模式: {r['mode']}")
    print(f"字数: {r['chars']}  句数: {r['sents']}  平均句长: {r['mean']:.1f}")
    print()
    print("[机器分]")
    tag = "（钩子段不考核）" if r['mode'] == 'hook' else ""
    print(f"  数字锚点密度   {r['a_density']:.2f} / 2.0{tag}")
    print(f"                阿拉伯 {r['nums_ar']} + 中文 {r['nums_cn']} + 专名 {r['nouns']}×0.5")
    if r['cn_samples']:
        print(f"                中文数字样例: {', '.join(r['cn_samples'])}")
    print(f"                → {r['s'][0]} / 15")
    print(f"  抽象词密度     {r['ab_density']:.2f}"
          f"   (命中 {r['ab_count']}: {', '.join(r['ab_hits']) if r['ab_hits'] else '无'})"
          f"   → {r['s'][1]} / 12")
    print(f"  四字格         {r['n4']} 个 → {r['s'][2]} / 10")
    print(f"  句长变异系数   {r['cv']:.2f} (标准差 {r['std']:.1f}) → {r['s'][3]} / 10")
    print(f"  人称在场       我 {r['wo']} / 你 {r['ni']} → {r['s'][4]} / 8")
    print(f"  套话           {r['cliche']} 处 → {r['s'][5]} / 5")
    print("  " + "─" * 46)
    print(f"  机器分合计: {r['total']} / 60")
    print()
    grade = "优秀" if r['total'] >= 55 else ("及格" if r['total'] >= 45 else "需重写")
    print(f"评级: {grade}")
    if r['total'] < 45:
        print("\n优先修:")
        if r['s'][0] < 10 and r['mode'] != 'hook':
            print("  · 数字太少 —— 换成具体数字或专有名词")
        if r['s'][1] < 9:
            print(f"  · 抽象词太多 —— {', '.join(r['ab_hits'][:5])} 换成具体动作")
        if r['s'][3] < 7:
            print("  · 句长太均匀 —— 加 3–6 字的短句")
        if r['s'][4] < 5:
            print("  · 缺人称 —— 中段加「我」，钩子段用「你」")


def main():
    args = sys.argv[1:]
    if not args:
        print(__doc__)
        return
    mode = 'body'
    if '--mode' in args:
        i = args.index('--mode')
        mode = args[i + 1]
        args = args[:i] + args[i + 2:]
    if '--compare' in args:
        i = args.index('--compare')
        for p in args[i + 1:]:
            r = score(pathlib.Path(p), mode)
            print(f"{r['file']:<26} {r['total']:>5.1f} / 60")
        return
    if '--only' in args:
        i = args.index('--only')
        which, target = args[i + 1], args[i + 2]
        r = score(pathlib.Path(target), mode)
        key = {'numbers': 'a_density', 'abstract': 'ab_density',
               'four': 'n4', 'cv': 'cv'}.get(which)
        print(f"{r['file']} {which} = {r[key]}")
        return
    for p in args:
        report(score(pathlib.Path(p), mode))


if __name__ == '__main__':
    main()
