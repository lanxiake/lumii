/**
 * PalaceRepo / PalaceIndexRepo —— 自建记忆宫殿（评审 §4.6 / 实施计划 T2、T3）
 *
 * 旧实现是 MemPalace（Python MCP + chromadb）：本机 chromadb 的 Rust 内核 upsert 直接
 * 0xC0000005 崩溃，覆盖率实测 4/171 = 2.3%——「过去说过什么」这条召回路径实际上不存在。
 *
 * 本用例守住的是**替代品必须真的等价或更好**这几条：
 * 1. 中文 2 字关键词能命中段原文（bigram 预分词的意义所在）
 * 2. 内容寻址幂等：同 (wing, room, content) 重复归档不产生第二行
 * 3. 非破坏删除：墓碑留行、检索摘除，且**重复归档不复活**
 * 4. 检索返回摘录而非全文（94473 字符的段不能整段进工具结果）
 * 5. 派生索引的一致性：墓碑不进索引，重建不复活墓碑
 */
import { describe, it, expect, beforeEach } from "vitest";
import { PalaceRepo, buildDrawerExcerpt, SEARCH_EXCERPT_CHARS } from "../palace-repo.js";
import { deterministicDrawerId } from "../content-address.js";
import { createMigratedTestDb } from "../../__tests__/helpers/sqlite-test-db.js";
import type { DatabaseAdapter } from "../../storage/local-database.js";

const USER = "local-user";
const AGENT = "assistant";

function longText(times: number): string {
  return Array.from({ length: times }, (_, i) => `第 ${i} 段：工单同步任务的排查记录。`).join("");
}

describe("PalaceRepo", () => {
  let db: DatabaseAdapter;
  let repo: PalaceRepo;

  beforeEach(() => {
    db = createMigratedTestDb();
    repo = new PalaceRepo(db);
  });

  function archive(content: string, opts: Partial<{ wing: string; room: string; agent: string }> = {}) {
    return repo.upsertDrawer({
      agentId: opts.agent ?? AGENT,
      userId: USER,
      wing: opts.wing ?? "assistant:local-user",
      room: opts.room ?? "2026-09-17",
      content,
      conversationId: "conv-1",
      segmentId: null,
    });
  }

  function search(query: string, extra: Record<string, unknown> = {}) {
    return repo.searchDrawers({ query, userId: USER, limit: 10, ...extra });
  }

  it("中文 2 字关键词能命中已归档的段原文", () => {
    archive("讨论了数据库连接池的配置，以及慢查询日志的排查方法。");
    archive("今天主要在整理前端构建产物，顺带修了一个样式问题。");

    const hits = search("工单");
    // 「工单」不在任何一条里 —— 先确认不该命中（否则下面的命中说明不了问题）
    expect(hits).toHaveLength(0);

    archive("这段讲的是工单同步卡点的排查：先看队列积压，再看消费端日志。");
    const hit = search("工单");
    expect(hit).toHaveLength(1);
    expect(hit[0]!.text).toContain("工单同步卡点");
    expect(hit[0]!.truncated).toBe(false);
    expect(hit[0]!.char_count).toBe("这段讲的是工单同步卡点的排查：先看队列积压，再看消费端日志。".length);
  });

  it("同 (wing, room, content) 重复归档不产生第二行，且两次返回同一 drawer_id", () => {
    const text = "重复归档的段原文，内容寻址应当幂等。";
    const first = archive(text);
    const second = archive(text);

    expect(second.drawerId).toBe(first.drawerId);
    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);

    const count = db
      .prepare<{ c: number }>("SELECT COUNT(*) AS c FROM palace_drawers")
      .get()!.c;
    expect(count).toBe(1);

    // 索引也只有一行（否则同一段会被检索出两次）
    const ftsCount = db
      .prepare<{ c: number }>("SELECT COUNT(*) AS c FROM palace_drawers_fts")
      .get()!.c;
    expect(ftsCount).toBe(1);
    expect(search("内容寻址")).toHaveLength(1);
  });

  it("wing/room 不同 → 不同 drawer_id（内容寻址把位置算进去）", () => {
    const text = "同一段原文归档到不同房间应当是两条。";
    const a = archive(text, { room: "2026-09-16" });
    const b = archive(text, { room: "2026-09-17" });
    expect(a.drawerId).not.toBe(b.drawerId);
  });

  it("传入的 drawerId 与内容寻址不符时以重算值为准（不变量只有一处来源）", () => {
    const text = "调用方给了一个别的 id。";
    const result = repo.upsertDrawer({
      agentId: AGENT,
      userId: USER,
      wing: "w",
      room: "r",
      content: text,
      drawerId: "0".repeat(16),
    });
    expect(result.drawerId).toBe(deterministicDrawerId("w", "r", text));
    expect(repo.readById("0".repeat(16))).toBeNull();
  });

  it("readById 返回的 content 与原文逐字一致（含换行与 emoji）", () => {
    const text = "第一行\n第二行\t制表符\nemoji 🙂 与「引号」\n\n末尾空行后结束。";
    const { drawerId } = archive(text);

    const detail = repo.readById(drawerId);
    expect(detail?.content).toBe(text);
    expect(detail?.wing).toBe("assistant:local-user");
    expect(detail?.room).toBe("2026-09-17");
    expect(detail?.metadata.segmentId).toBeNull();
    expect(detail?.metadata.conversationId).toBe("conv-1");
  });

  it("删除是写墓碑：行还在、检索摘除、readById 也读不到", () => {
    const { drawerId } = archive("要被删除的段原文：里面有关键词青竹。");
    expect(search("青竹")).toHaveLength(1);

    expect(repo.deleteById(drawerId)).toBe(true);

    const row = db
      .prepare<{ content: string; deleted_at: string | null }>(
        "SELECT content, deleted_at FROM palace_drawers WHERE drawer_id = ?",
      )
      .get(drawerId);
    expect(row?.content).toContain("青竹"); // 原文没被抹掉
    expect(row?.deleted_at).not.toBeNull(); // 墓碑有生产者

    expect(search("青竹")).toHaveLength(0);
    expect(repo.readById(drawerId)).toBeNull();
    // 重复删除返回 false（幂等，不重复写时间戳）
    expect(repo.deleteById(drawerId)).toBe(false);
  });

  it("被删除的段再次归档不会复活（墓碑优先，与云同步合并同一原则）", () => {
    const text = "删除后又被重新归档的段。";
    const { drawerId } = archive(text);
    repo.deleteById(drawerId);

    const again = archive(text);
    expect(again.drawerId).toBe(drawerId);
    expect(search("重新归档")).toHaveLength(0);
    expect(repo.readById(drawerId)).toBeNull();
  });

  it("长段返回摘录且锚定命中位置，char_count 保留原文长度", () => {
    const prefix = longText(200); // 约 6000 字符
    const content = `${prefix}这里是真正的关键段落：青竹三号暗号。${longText(200)}`;
    archive(content);

    const hit = search("青竹三号")[0]!;
    expect(hit.truncated).toBe(true);
    expect(hit.text.length).toBeLessThanOrEqual(SEARCH_EXCERPT_CHARS + 2); // 前后各可能有一个省略号
    expect(hit.text).toContain("青竹三号");
    expect(hit.char_count).toBe(content.length);
    // 摘录必须来自原文，不能是拼出来的
    expect(content).toContain(hit.text.replace(/^…|…$/g, ""));
  });

  it("短段原样返回，不加省略号", () => {
    archive("很短的一段。");
    const hit = search("很短")[0]!;
    expect(hit.truncated).toBe(false);
    expect(hit.text).toBe("很短的一段。");
  });

  it("作用域：默认跨 Agent（宫殿是会话存档），传 agentId 才收窄", () => {
    archive("甲助手的会话里提到了雪山。", { agent: "agent-a" });
    archive("乙助手的会话里也提到了雪山。", { agent: "agent-b" });

    expect(search("雪山")).toHaveLength(2);
    expect(search("雪山", { agentId: "agent-a" })).toHaveLength(1);

    // 别的用户搜不到
    const other = repo.searchDrawers({ query: "雪山", userId: "someone-else" });
    expect(other).toHaveLength(0);
  });

  it("wing / room 可作为过滤条件", () => {
    archive("九月十七日的房间。", { room: "2026-09-17" });
    archive("九月十六日的房间。", { room: "2026-09-16" });

    expect(search("房间")).toHaveLength(2);
    expect(search("房间", { room: "2026-09-16" })).toHaveLength(1);
  });

  it("分词为空（纯符号查询）回落 LIKE，不抛异常", () => {
    archive("一段含「——」破折号的内容。");
    const hits = search("——");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.score).toBe(0); // LIKE 命中不编造相关性分数
  });

  it("查询里的 FTS5 语法字符被当作普通文本（不会当成 AND / 前缀 / NEAR）", () => {
    archive("内容里出现了 AND 这个词，也出现了星号 * 与双引号 \" 的讨论。");
    expect(() => search('AND OR NEAR * "')).not.toThrow();
  });

  it("countByScope 分开统计活跃与墓碑", () => {
    const a = archive("第一条。");
    archive("第二条。");
    repo.deleteById(a.drawerId);

    expect(repo.countByScope(USER)).toEqual({ active: 1, tombstoned: 1, total: 2 });
    expect(repo.countByScope(USER, AGENT)).toEqual({ active: 1, tombstoned: 1, total: 2 });
    expect(repo.countByScope(USER, "other-agent")).toEqual({
      active: 0,
      tombstoned: 0,
      total: 0,
    });
  });

  it("健康检查：墓碑不进索引，重建索引也不会把墓碑捞回来", () => {
    const a = archive("会被删掉的一条，关键词灯笼。");
    archive("保留的一条，关键词灯笼也在。");
    expect(repo.checkFtsHealth().isHealthy).toBe(true);

    repo.deleteById(a.drawerId);
    expect(repo.checkFtsHealth().isHealthy).toBe(true);

    // 手动把索引全清掉 → 体检必须报出来（否则「索引挂了」永远无人知晓）
    db.exec("DELETE FROM palace_drawers_fts");
    const broken = repo.checkFtsHealth();
    expect(broken.isHealthy).toBe(false);
    expect(broken.reason).toContain("条数不一致");

    const rebuilt = repo.rebuildIndex();
    expect(rebuilt).toBe(1); // 只重建活跃行
    expect(repo.checkFtsHealth().isHealthy).toBe(true);
    expect(search("灯笼")).toHaveLength(1);
  });
});

describe("buildDrawerExcerpt", () => {
  it("窗口不足时原样返回", () => {
    expect(buildDrawerExcerpt("短文本", "短")).toEqual({ text: "短文本", truncated: false });
  });

  it("命中点靠前时不加前置省略号", () => {
    const content = `关键词在开头${"填充".repeat(500)}`;
    const r = buildDrawerExcerpt(content, "关键词", 100);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("…")).toBe(false);
    expect(r.text.endsWith("…")).toBe(true);
  });

  it("命中点靠后时加前置省略号，且摘录仍在原文内", () => {
    const content = `${"填充".repeat(500)}关键词在结尾`;
    const r = buildDrawerExcerpt(content, "关键词", 100);
    expect(r.text.startsWith("…")).toBe(true);
    expect(r.text.endsWith("…")).toBe(false);
    expect(r.text).toContain("关键词在结尾");
  });

  it("查不到任何 token 时退化为取开头，不返回空", () => {
    const content = "填充".repeat(500);
    const r = buildDrawerExcerpt(content, "完全不存在的词", 100);
    expect(r.truncated).toBe(true);
    expect(r.text.startsWith("…")).toBe(false);
    expect(r.text.length).toBeGreaterThan(50);
  });

  it("多处命中时取查询词最密集的窗口，不被开头那个常见 bigram 带偏", () => {
    // 「的时」是中文里极常见的组合，刚好在开头；「青竹三号」才是真正要找的东西。
    // 锚点若按「首个命中位置」或「最长 token」（bigram 全是 2 字符，无从区分）都会选错。
    const content = `的时${"填充".repeat(400)}青竹三号${"填充".repeat(400)}`;
    const r = buildDrawerExcerpt(content, "的时 青竹三号", 120);
    expect(r.text).toContain("青竹三号");
  });

  it("短文本里多个 token 分散时不越界（窗口仍在原文内）", () => {
    const content = `${"填充".repeat(500)}开头词${"填充".repeat(500)}结尾词`;
    const r = buildDrawerExcerpt(content, "开头词 结尾词", 80);
    expect(r.text.length).toBeLessThanOrEqual(82);
    const inner = r.text.replace(/^…|…$/g, "");
    expect(content).toContain(inner);
  });
});
