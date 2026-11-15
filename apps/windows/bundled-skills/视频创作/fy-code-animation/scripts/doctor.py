"""Self-check for this skill: is the 341 library reachable, is the index current, what is missing.

Run from the skill root:

    python scripts/doctor.py

Output is JSON: checks, actions, and a one-line verdict.
Exit 0 = ready to work; 2 = do the "actions" first.
"""
import importlib.util
import json
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parent.parent

CORE_FILES = [
    "SKILL.md",
    "modules/meaning.md",
    "modules/style.md",
    "modules/workflow.md",
    "modules/qa.md",
    "modules/decisions.md",
    "adapters/style-library.md",
    "adapters/style-library.config.json",
    "adapters/style-index.json",
    "scripts/style_library.py",
    "templates/task.json",
    "templates/task-card.md",
]


def load_module(name):
    spec = importlib.util.spec_from_file_location(name, SKILL_ROOT / "scripts" / f"{name}.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def main():
    import argparse

    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--root", default=None, help="341 风格库根目录（其下应有 风格提示词/）")
    ap.add_argument("--index", default=None, help="索引文件，默认 adapters/style-index.json")
    args = ap.parse_args()

    report = {
        "skill_root": str(SKILL_ROOT),
        "python": sys.version.split()[0],
        "checks": [],
        "actions": [],
        "ready": False,
    }

    # 1. 技能目录是否完整
    missing = [p for p in CORE_FILES if not (SKILL_ROOT / p).is_file()]
    report["checks"].append({"name": "核心文件", "ok": not missing, "missing": missing})
    if missing:
        report["actions"].append("技能目录不完整，缺: " + ", ".join(missing) + "；重新解压完整目录")

    # 2. 载入检索脚本
    try:
        sty = load_module("style_library")
    except Exception as exc:  # noqa: BLE001 - report any import failure
        report["checks"].append({"name": "载入 style_library.py", "ok": False, "error": repr(exc)})
        report["actions"].append("style_library.py 无法载入，检查 Python 版本（需 3.9+）和文件完整性")
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 2

    # 3. 库根目录
    root = source = None
    try:
        root, source = sty.resolve_root(args.root)
    except Exception as exc:  # noqa: BLE001
        report["checks"].append({
            "name": "341 风格库",
            "ok": False,
            "resolved_from": None,
            "error": str(exc),
        })
        report["actions"].append(
            "让用户给出 341 风格库根目录（库根下应有 风格提示词/）：传 --root，或设环境变量 "
            "FY_STYLE_LIBRARY_ROOT，或写进 adapters/style-library.config.json 的 root。问一次就停，不要遍历磁盘。"
        )

    if root:
        root_path = Path(root)
        prompt_dir = root_path / "风格提示词"
        exists = root_path.is_dir() and prompt_dir.is_dir()
        check = {
            "name": "341 风格库",
            "ok": exists,
            "root": str(root_path),
            "resolved_from": source,
            "has_prompt_dir": prompt_dir.is_dir(),
        }
        report["checks"].append(check)
        if not exists:
            report["actions"].append(
                "库根下找不到 风格提示词/：" + str(root_path) + "；确认路径指向库根，而不是上一级或 风格提示词/ 本身"
            )
        else:
            # 4. 索引与其一致性
            index_path = Path(args.index) if args.index else SKILL_ROOT / "adapters" / "style-index.json"
            try:
                index = json.loads(index_path.read_text(encoding="utf-8-sig"))
                index_ok = True
            except Exception as exc:  # noqa: BLE001
                index = None
                index_ok = False
                report["checks"].append({"name": "索引", "ok": False, "error": repr(exc)})
                report["actions"].append("索引读不出来，运行 python scripts/style_library.py build --root <库根> 重建")

            if index_ok:
                report["checks"].append({
                    "name": "索引",
                    "ok": True,
                    "prompt_count": index.get("prompt_count"),
                    "library_version": index.get("library_version"),
                })
                try:
                    current = sty.index_library(root_path)
                except Exception as exc:  # noqa: BLE001
                    report["checks"].append({"name": "库可索引", "ok": False, "error": str(exc)})
                    report["actions"].append("库存在但索引不起来：" + str(exc) + "；检查 风格提示词/ 下的文件是否按 ID 命名")
                else:
                    same = current["library_version"] == index.get("library_version")
                    report["checks"].append({
                        "name": "索引与库一致",
                        "ok": same,
                        "library_prompt_count": current["prompt_count"],
                        "index_prompt_count": index.get("prompt_count"),
                        "library_version_now": current["library_version"],
                    })
                    if not same:
                        report["actions"].append(
                            "索引不是用这份库建的（或库已更新）：python scripts/style_library.py build --root "
                            + str(root_path) + " --index adapters/style-index.json"
                        )

    report["ready"] = bool(report["checks"]) and all(c.get("ok") for c in report["checks"]) and not report["actions"]
    report["verdict"] = "ready" if report["ready"] else "needs_action"
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ready"] else 2


if __name__ == "__main__":
    sys.exit(main())
