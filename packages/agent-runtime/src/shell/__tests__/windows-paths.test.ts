import { describe, it, expect } from "vitest";
import { winToPosix, posixToWin } from "../windows-paths.js";

describe("winToPosix", () => {
  it("盘符路径转 POSIX（小写盘符）", () => {
    expect(winToPosix("D:\\foo\\bar")).toBe("/d/foo/bar");
    expect(winToPosix("C:\\Users\\a")).toBe("/c/Users/a");
  });

  it("正斜杠盘符路径也支持", () => {
    expect(winToPosix("C:/a/b")).toBe("/c/a/b");
  });

  it("非盘符路径仅归一分隔符", () => {
    expect(winToPosix("foo\\bar")).toBe("foo/bar");
    expect(winToPosix("./rel\\path")).toBe("./rel/path");
  });
});

describe("posixToWin", () => {
  it("POSIX 盘符路径转 Windows（大写盘符）", () => {
    expect(posixToWin("/d/foo/bar")).toBe("D:\\foo\\bar");
    expect(posixToWin("/c/Users/a")).toBe("C:\\Users\\a");
  });

  it("非盘符路径仅归一分隔符", () => {
    expect(posixToWin("foo/bar")).toBe("foo\\bar");
  });

  it("winToPosix 与 posixToWin 往返一致（大小写规整）", () => {
    expect(posixToWin(winToPosix("D:\\a\\b"))).toBe("D:\\a\\b");
  });
});
