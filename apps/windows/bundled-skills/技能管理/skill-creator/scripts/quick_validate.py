#!/usr/bin/env python3
"""
校验一个 Lumii 技能目录（结构 + SKILL.md frontmatter）。

规则对齐运行时解析器 apps/windows/src/main/skill-md-frontmatter.ts，而不是 Anthropic
的技能规范——两者在下面几处不同，按后者校验会误报：

  - 技能名可以是中文。没有 kebab-case 限制，也没有长度上限（name 省略时回退目录名）
  - 只有 name / description / when_to_use / activation_scope / version / metadata 六个键有效，
    其余字段会被静默忽略（本脚本报为 warning，免得白写）
  - description 不得含尖括号（顶层解析器拿尖括号做标记）
  - 技能列表只注入 description 的前 120 字符，触发词要压在这个范围内

**error 表示技能不工作，warning 表示能工作但有白写的字段。** 只看退出码时两者都算通过。

故意不依赖 PyYAML：运行时可能用内置的嵌入式 Python，未必装了它。
解析方式是运行时那套行式解析的逐行复刻。

用法：python quick_validate.py <技能目录>
"""

import json
import re
import sys
from pathlib import Path

# 运行时真正读取的 frontmatter 键（含别名）
ALLOWED_PROPERTIES = {
    "name",
    "description",
    "when_to_use",
    "whenToUse",
    "activation_scope",
    "activationScope",
    "version",
    "metadata",
}
ACTIVATION_SCOPES = {"always", "contextual", "on_demand"}
# 运行时 parseSkillRequires 认的字段；meta.requires 里出现别的键等于没写
REQUIRES_KEYS = {"bins", "anyBins", "env", "config"}
BLOCK_MARKERS = {"|", ">", "|-", ">-"}
# 注入技能列表时的截断长度——触发词必须落在这一段里
DESC_TRIGGER_WINDOW = 120


def parse_frontmatter(content):
    """逐行复刻 parseSkillMdFrontmatter：返回 (字段字典, 未知顶层键列表)。

    单行值走 stripYamlQuotes；`|`/`>` 块标量收集缩进行后 join('\\n')；
    metadata 的多行块则逐行 trim 后 join(' ')，与运行时一致。
    """
    normalized = content.replace("\r\n", "\n").replace("\r", "\n")
    if not normalized.startswith("---"):
        return None, []
    close = normalized.find("\n---", 3)
    if close == -1:
        return None, []

    lines = normalized[4:close].split("\n")
    result, unknown = {}, []
    i = 0
    while i < len(lines):
        line = lines[i]
        colon = line.find(":")
        if colon <= 0:
            i += 1
            continue
        key, rest = line[:colon].strip(), line[colon + 1:].strip()

        # 收集后续缩进行（直到遇到顶格行）
        def take_indented(start):
            body, j = [], start
            while j < len(lines):
                ln = lines[j]
                if ln and not ln[0].isspace():
                    break
                body.append(ln)
                j += 1
            return body, j

        if rest in BLOCK_MARKERS:
            body, i = take_indented(i + 1)
            result[key] = "\n".join(body).strip()
            continue

        if key == "metadata":
            if not rest:
                body, i = take_indented(i + 1)
                result["metadata"] = " ".join(b.strip() for b in body).strip()
            else:
                result["metadata"] = rest
                i += 1
            continue

        value = rest
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        result[key] = value
        i += 1

    for key in result:
        if key not in ALLOWED_PROPERTIES:
            unknown.append(key)
    return result, unknown


def validate_skill(skill_path):
    """校验技能目录，返回 (是否合法, [消息])。"""
    skill_path = Path(skill_path)
    if not skill_path.is_dir():
        return False, [f"error: 不是一个目录: {skill_path}"]

    skill_md = next((p for p in skill_path.iterdir() if p.name.lower() == "skill.md"), None)
    if skill_md is None:
        return False, ["error: 未找到 SKILL.md —— Lumii 靠目录里的 SKILL.md 识别技能"]

    fm, unknown = parse_frontmatter(skill_md.read_text(encoding="utf-8"))
    if fm is None:
        return False, ["error: 缺少 YAML frontmatter（文件需以 --- 开头并有结束的 ---）"]

    errors, warnings = [], []

    # description 是唯一的触发机制
    desc = fm.get("description")
    if desc is None:
        errors.append("error: 缺少 description —— 它是技能唯一的触发机制，缺了技能永远不会被调用")
    elif not desc.strip():
        errors.append("error: description 为空")
    else:
        if "<" in desc or ">" in desc:
            errors.append("error: description 不能含尖括号 < >（顶层解析器用它们做标记）")
        head = re.sub(r"\s+", " ", desc).strip()[:DESC_TRIGGER_WINDOW]
        if not head:
            errors.append(f"error: description 前 {DESC_TRIGGER_WINDOW} 字符为空")

    if "name" in fm and not fm["name"].strip():
        errors.append("error: name 声明了但为空（省略时回退目录名，写了就必须有内容）")

    scope = fm.get("activation_scope") or fm.get("activationScope")
    if scope is not None and scope not in ACTIVATION_SCOPES:
        errors.append(f"error: activation_scope 必须是 {sorted(ACTIVATION_SCOPES)} 之一，得到 {scope!r}")

    for key in unknown:
        warnings.append(
            f"warning: 字段 {key!r} 运行时不会读，写了不生效（有效键: {', '.join(sorted(ALLOWED_PROPERTIES))}）"
        )

    meta_raw = fm.get("metadata")
    if meta_raw:
        try:
            meta = json.loads(re.sub(r",\s*([}\]])", r"\1", meta_raw))
        except json.JSONDecodeError as e:
            errors.append(f"error: metadata 不是合法 JSON5: {e}")
        else:
            requires = (meta or {}).get("mtbot", {}).get("requires")
            if isinstance(requires, dict):
                bogus = sorted(set(requires) - REQUIRES_KEYS)
                if bogus:
                    warnings.append(
                        f"warning: metadata.mtbot.requires 里的 {', '.join(bogus)} 运行时不会读"
                        f"（只认 {', '.join(sorted(REQUIRES_KEYS))}）"
                    )

    return not errors, errors + warnings


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print("用法: python quick_validate.py <技能目录>")
        sys.exit(1)
    valid, messages = validate_skill(sys.argv[1])
    print("\n".join(messages) if messages else "技能合法")
    sys.exit(0 if valid else 1)
