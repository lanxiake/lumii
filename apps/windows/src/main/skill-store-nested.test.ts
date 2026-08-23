import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalSkillStore } from "./skill-store";

let root: string;

function writeSkill(relDir: string, name: string): void {
  const dir = path.join(root, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} desc\n---\n\n# ${name}\n`,
    "utf-8",
  );
}

describe("LocalSkillStore 嵌套分类扫描", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-skills-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("扫描根层、两层与三层嵌套技能", async () => {
    writeSkill("flat-skill", "flat");
    writeSkill("分类A/nested-skill", "nested");
    writeSkill("短剧创作/01选题与故事开发/brainstorming", "brainstorming");

    const store = new LocalSkillStore(root);
    await store.initialize();
    const installed = await store.listInstalled();
    const byId = new Map(installed.map((s) => [s.id, s]));

    expect(byId.get("flat-skill")?.category).toBe("");
    expect(byId.get("分类A/nested-skill")?.category).toBe("分类A");

    const deep = byId.get("短剧创作/01选题与故事开发/brainstorming");
    expect(deep).toBeDefined();
    expect(deep?.category).toBe("短剧创作/01选题与故事开发");
    expect(deep?.dirName).toBe("brainstorming");
    expect(deep?.name).toBe("brainstorming");
  });

  it("多级 category 下 getSkillDirectory 解析到真实目录", async () => {
    writeSkill("短剧创作/01选题与故事开发/brainstorming", "brainstorming");

    const store = new LocalSkillStore(root);
    await store.initialize();

    const dir = store.getSkillDirectory("短剧创作/01选题与故事开发/brainstorming");
    expect(dir).toBe(
      path.join(root, "短剧创作", "01选题与故事开发", "brainstorming"),
    );
  });

  it("卸载嵌套技能删除的是嵌套目录本身，不误删分类", async () => {
    writeSkill("短剧创作/01选题与故事开发/brainstorming", "brainstorming");

    const store = new LocalSkillStore(root);
    await store.initialize();

    const res = await store.uninstall("短剧创作/01选题与故事开发/brainstorming");
    expect(res.success).toBe(true);
    expect(
      fs.existsSync(path.join(root, "短剧创作", "01选题与故事开发", "brainstorming")),
    ).toBe(false);
    // 分类目录本身保留
    expect(fs.existsSync(path.join(root, "短剧创作", "01选题与故事开发"))).toBe(true);
    expect(await store.listInstalled()).toHaveLength(0);
  });
});
