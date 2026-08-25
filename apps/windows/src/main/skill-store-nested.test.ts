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

describe("LocalSkillStore 索引写盘幂等", () => {
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "lumii-skills-"));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * 回归：目录未变时重复扫描不得重写 index.json。
   *
   * index.json 位于 SkillWatcher 监控的 skills/ 目录内，每次重写都会触发一轮
   * watch 事件 → 重扫 → 再重写的自激循环（表现为日志每 1.5s 刷屏，且回合快照
   * diff 里永远多出一条 skills/index.json 修改）。
   */
  it("目录未变化时重复 reload 不重写 index.json", async () => {
    writeSkill("flat-skill", "flat");

    const store = new LocalSkillStore(root);
    await store.initialize();

    const indexPath = path.join(root, "index.json");
    expect(fs.existsSync(indexPath)).toBe(true);
    const firstContent = fs.readFileSync(indexPath, "utf-8");

    await store.reload();
    await store.reload();

    // updatedAt 也在内容里：内容全等即证明没有发生写盘
    expect(fs.readFileSync(indexPath, "utf-8")).toBe(firstContent);
  });

  it("目录新增技能时仍会写盘", async () => {
    writeSkill("flat-skill", "flat");

    const store = new LocalSkillStore(root);
    await store.initialize();
    const indexPath = path.join(root, "index.json");
    const before = fs.readFileSync(indexPath, "utf-8");

    writeSkill("second-skill", "second");
    await store.reload();

    const after = fs.readFileSync(indexPath, "utf-8");
    expect(after).not.toBe(before);
    expect(await store.listInstalled()).toHaveLength(2);
  });
});
