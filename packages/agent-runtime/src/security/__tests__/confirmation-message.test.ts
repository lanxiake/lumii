import { describe, expect, it } from "vitest";
import { buildConfirmationMessage } from "../permission-checker.js";

describe("buildConfirmationMessage", () => {
  // 回归：内置工具 schema 用 filePath（驼峰），旧代码读 file_path 导致显示 <unknown>
  it("file_write 读驼峰 filePath", () => {
    const msg = buildConfirmationMessage("file_write", { filePath: "D:/a/b.md", content: "x" });
    expect(msg).toBe("写入文件：D:/a/b.md");
  });

  it("file_edit 与 file_read 同样取到路径", () => {
    expect(buildConfirmationMessage("file_edit", { filePath: "/x.ts" })).toBe("编辑文件：/x.ts");
    expect(buildConfirmationMessage("file_read", { filePath: "/y.ts" })).toBe("读取文件：/y.ts");
  });

  it("兼容蛇形 file_path", () => {
    expect(buildConfirmationMessage("Write", { file_path: "/z.md" })).toBe("写入文件：/z.md");
  });

  it("bash 展示命令", () => {
    expect(buildConfirmationMessage("bash", { command: "ls -la" })).toBe("执行命令：ls -la");
  });

  it("file_move / file_mkdir 展示路径", () => {
    expect(buildConfirmationMessage("file_mkdir", { path: "outputs/tmp" })).toBe("创建目录：outputs/tmp");
    expect(buildConfirmationMessage("file_move", { source: "a.txt", destination: "b.txt" })).toBe(
      "移动：a.txt → b.txt",
    );
  });

  it("绝不出现 <unknown>：参数缺失时回落为完整参数 JSON", () => {
    const msg = buildConfirmationMessage("file_write", { wrongKey: "v" });
    expect(msg).not.toContain("<unknown>");
    expect(msg).toContain("file_write");
    expect(msg).toContain("wrongKey");
  });

  it("未覆盖的工具展示工具名与参数", () => {
    const msg = buildConfirmationMessage("web_fetch", { url: "https://example.com" });
    expect(msg).toContain("web_fetch");
    expect(msg).toContain("https://example.com");
  });

  it("超长命令与超长参数都截断", () => {
    const long = "a".repeat(2000);
    expect(buildConfirmationMessage("bash", { command: long }).length).toBeLessThan(600);
    expect(buildConfirmationMessage("mystery", { blob: long }).length).toBeLessThan(700);
  });
});
