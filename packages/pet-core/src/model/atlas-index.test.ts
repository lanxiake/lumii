import { describe, it, expect } from "vitest";
import { parseAtlasIndex, atlasFrameNames, findAtlasFrame } from "./atlas-index.js";

const hashFormat = {
  frames: {
    "idle_00.png": { frame: { x: 0, y: 0, w: 32, h: 32 } },
    "idle_01.png": { frame: { x: 32, y: 0, w: 32, h: 32 } },
  },
  meta: { image: "atlas.png", size: { w: 64, h: 32 } },
};

const arrayFormat = {
  frames: [
    { filename: "eye_open", frame: { x: 0, y: 0, w: 8, h: 8 } },
    { filename: "eye_shut", frame: { x: 8, y: 0, w: 8, h: 8 } },
  ],
  meta: { image: "face.png" },
};

describe("parseAtlasIndex", () => {
  it("解析 TexturePacker Hash 格式", () => {
    const r = parseAtlasIndex(hashFormat);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.atlas.frames).toHaveLength(2);
    expect(r.atlas.frames[0]).toEqual({ name: "idle_00.png", x: 0, y: 0, w: 32, h: 32 });
    expect(r.atlas.image).toBe("atlas.png");
    expect(r.atlas.size).toEqual({ w: 64, h: 32 });
  });

  it("解析 TexturePacker Array / Aseprite 格式", () => {
    const r = parseAtlasIndex(arrayFormat);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.atlas.frames.map((f) => f.name)).toEqual(["eye_open", "eye_shut"]);
    expect(r.atlas.image).toBe("face.png");
    expect(r.atlas.size).toBeUndefined();
  });

  it("矩形可平铺在条目上（无 frame 包裹）", () => {
    const r = parseAtlasIndex({ frames: { a: { x: 1, y: 2, w: 3, h: 4 } } });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.atlas.frames[0]).toEqual({ name: "a", x: 1, y: 2, w: 3, h: 4 });
  });

  it("跳过坏条目并报出全部问题，好条目仍保留", () => {
    const r = parseAtlasIndex({
      frames: {
        good: { frame: { x: 0, y: 0, w: 8, h: 8 } },
        缺矩形: { frame: { x: 0, y: 0 } },
        负坐标: { frame: { x: -1, y: 0, w: 8, h: 8 } },
      },
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors).toHaveLength(2);
    expect(r.errors[0]).toContain("缺矩形");
  });

  it("数组格式缺 filename 报错", () => {
    const r = parseAtlasIndex({ frames: [{ frame: { x: 0, y: 0, w: 1, h: 1 } }] });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("filename");
  });

  it("零宽/零高视为坏条目（空帧会让渲染层拿到空纹理）", () => {
    const r = parseAtlasIndex({ frames: { a: { frame: { x: 0, y: 0, w: 0, h: 8 } } } });
    expect(r.ok).toBe(false);
  });

  it("重复条目名报错", () => {
    const r = parseAtlasIndex({
      frames: [
        { filename: "a", frame: { x: 0, y: 0, w: 1, h: 1 } },
        { filename: "a", frame: { x: 1, y: 0, w: 1, h: 1 } },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.errors[0]).toContain("重复");
  });

  it("非对象 / 无 frames / frames 为空都拒绝", () => {
    expect(parseAtlasIndex(null).ok).toBe(false);
    expect(parseAtlasIndex("x").ok).toBe(false);
    expect(parseAtlasIndex({ meta: {} }).ok).toBe(false);
    expect(parseAtlasIndex({ frames: {} }).ok).toBe(false);
    expect(parseAtlasIndex({ frames: [] }).ok).toBe(false);
  });
});

describe("atlasFrameNames", () => {
  it("同时给出原名与去扩展名别名", () => {
    const r = parseAtlasIndex(hashFormat);
    if (!r.ok) throw new Error("fixture 应可解析");
    const names = atlasFrameNames(r.atlas);
    expect(names).toContain("idle_00.png");
    expect(names).toContain("idle_00");
  });

  it("无扩展名的条目不会产生重复别名", () => {
    const r = parseAtlasIndex(arrayFormat);
    if (!r.ok) throw new Error("fixture 应可解析");
    const names = atlasFrameNames(r.atlas);
    expect(names).toEqual(["eye_open", "eye_shut"]);
  });
});

describe("findAtlasFrame", () => {
  it("原名优先命中", () => {
    const r = parseAtlasIndex(hashFormat);
    if (!r.ok) throw new Error("fixture 应可解析");
    expect(findAtlasFrame(r.atlas, "idle_01.png")?.x).toBe(32);
  });

  it("去扩展名也可命中", () => {
    const r = parseAtlasIndex(hashFormat);
    if (!r.ok) throw new Error("fixture 应可解析");
    expect(findAtlasFrame(r.atlas, "idle_01")?.x).toBe(32);
  });

  it("不存在返回 null", () => {
    const r = parseAtlasIndex(hashFormat);
    if (!r.ok) throw new Error("fixture 应可解析");
    expect(findAtlasFrame(r.atlas, "没有这个")).toBeNull();
  });
});
