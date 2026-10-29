import { describe, it, expect, afterEach } from "vitest";
import {
  normalizeSql,
  setSlowQueryListener,
  getSlowQueryThresholdMs,
  timeSql,
  MAX_SQL_TEMPLATE_CHARS,
} from "./slow-query.js";

describe("normalizeSql", () => {
  it("把字符串与数字字面量换成 ?", () => {
    expect(normalizeSql("SELECT * FROM messages WHERE id = 'abc' AND n = 42")).toBe(
      "SELECT * FROM messages WHERE id = ? AND n = ?",
    );
  });

  it("处理 SQL 的 '' 转义", () => {
    expect(normalizeSql("SELECT * FROM t WHERE name = 'It''s'")).toBe(
      "SELECT * FROM t WHERE name = ?",
    );
  });

  it("字符串里的注释标记不当作注释", () => {
    expect(normalizeSql("SELECT '-- not a comment' AS x")).toBe("SELECT ? AS x");
  });

  it("丢弃行注释与块注释", () => {
    expect(normalizeSql("SELECT 1 -- trailing\nFROM t")).toBe("SELECT ? FROM t");
    expect(normalizeSql("SELECT /* secret=1 */ 1")).toBe("SELECT ?");
  });

  it("保留双引号标识符", () => {
    expect(normalizeSql('SELECT "user id" FROM t WHERE a = 1')).toBe(
      'SELECT "user id" FROM t WHERE a = ?',
    );
  });

  it("不把 1+2 吞成一个字面量", () => {
    expect(normalizeSql("SELECT a + 1 + 2 FROM t")).toBe("SELECT a + ? + ? FROM t");
  });

  it("压缩空白并截断超长语句", () => {
    expect(normalizeSql("SELECT\n\n  1")).toBe("SELECT ?");
    const long = `SELECT ${"a, ".repeat(200)}1`
    const out = normalizeSql(long)
    expect(out.length).toBeLessThanOrEqual(MAX_SQL_TEMPLATE_CHARS + 1)
    expect(out.endsWith("…")).toBe(true)
  });
});

describe("timeSql", () => {
  afterEach(() => setSlowQueryListener(null))

  it("未接监听时零开销且不报错", () => {
    expect(timeSql("db", "get", "SELECT 1", () => 7)).toBe(7)
  })

  it("超阈值才上报，且语句已归一化", () => {
    const seen: unknown[] = []
    setSlowQueryListener((s) => seen.push(s), 1)
    timeSql("main.db", "all", "SELECT * FROM t WHERE id = 9", () => {
      const end = performance.now() + 5
      while (performance.now() < end) { /* 制造 1ms 以上的耗时 */ }
      return []
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ db: "main.db", op: "all", sql: "SELECT * FROM t WHERE id = ?" })
  })

  it("快语句不上报", () => {
    const seen: unknown[] = []
    setSlowQueryListener((s) => seen.push(s), 1000)
    timeSql("main.db", "get", "SELECT 1", () => 1)
    expect(seen).toHaveLength(0)
  })

  it("带上返回行数（all 有数组结果）", () => {
    const seen: Array<{ rows: number }> = []
    setSlowQueryListener((s) => seen.push(s), 0.0001)
    timeSql("db", "all", "SELECT * FROM t", () => {
      const end = performance.now() + 1
      while (performance.now() < end) { /* 越过极小阈值 */ }
      return [1, 2, 3]
    })
    expect(seen[0]?.rows).toBe(3)
  })

  it("get / exec 没有数组结果，行数记 -1", () => {
    const seen: Array<{ rows: number }> = []
    setSlowQueryListener((s) => seen.push(s), 0.0001)
    const spin = <T,>(v: T): T => {
      const end = performance.now() + 1
      while (performance.now() < end) { /* 越过极小阈值 */ }
      return v
    }
    timeSql("db", "get", "SELECT 1", () => spin(1))
    timeSql("db", "exec", "COMMIT", () => spin(undefined))
    expect(seen.map((s) => s.rows)).toEqual([-1, -1])
  })

  it("业务抛错照常上抛，观测不吞异常", () => {
    setSlowQueryListener(() => {}, 0)
    expect(getSlowQueryThresholdMs()).toBe(50)
    expect(() => timeSql("db", "exec", "BAD SQL", () => { throw new Error("boom") })).toThrow("boom")
  })

  it("监听器自己抛错不影响业务返回", () => {
    setSlowQueryListener(() => { throw new Error("listener boom") }, 0.0001)
    const result = timeSql("db", "get", "SELECT 1", () => {
      const end = performance.now() + 1
      while (performance.now() < end) { /* 越过极小阈值，确保监听器真被调用 */ }
      return 3
    })
    expect(result).toBe(3)
  })
})
