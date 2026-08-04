import { describe, it, expect } from "vitest";
import { computeFileHash } from "../file-hash.js";

describe("file-hash", () => {
  it("小文件（<100KB）返回 SHA-1", () => {
    const content = "hello world";
    const hash = computeFileHash(content);
    expect(hash).toBe("2aae6c35c94fcfb415dbe95f408b9ce91ee846ed");
  });

  it("小文件 Buffer 返回 SHA-1", () => {
    const buf = Buffer.from("test", "utf8");
    const hash = computeFileHash(buf);
    expect(hash).toBe("a94a8fe5ccb19ba61c4c0873d391e987982fbbd3");
  });

  it("空内容返回 SHA-1", () => {
    const hash = computeFileHash("");
    expect(hash).toBe("da39a3ee5e6b4b0d3255bfef95601890afd80709");
  });

  it("大文件（>100KB）返回 undefined", () => {
    const large = "x".repeat(100 * 1024 + 1);
    const hash = computeFileHash(large);
    expect(hash).toBeUndefined();
  });

  it("99KB 文件仍计算哈希", () => {
    const justUnder = "x".repeat(100 * 1024 - 1);
    const hash = computeFileHash(justUnder);
    expect(hash).toBeDefined();
    expect(hash?.length).toBe(40); // SHA-1 hex length
  });
});
