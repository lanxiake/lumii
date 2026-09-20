import { describe, it, expect } from "vitest";
import {
  validatePetPackage,
  planPetInstall,
  isSafePackagePath,
  isSafePackageId,
  joinPackagePath,
  PET_PACKAGE_MANIFEST,
} from "./pet-package.js";
import type { SpriteManifest } from "./sprite-manifest.js";

const atlasRaw = {
  frames: {
    idle_00: { frame: { x: 0, y: 0, w: 64, h: 64 } },
    m0: { frame: { x: 64, y: 0, w: 16, h: 16 } },
    m1: { frame: { x: 80, y: 0, w: 16, h: 16 } },
  },
  meta: { image: "atlas.png", size: { w: 96, h: 64 } },
};

const manifest = {
  id: "demo_pixel_cat",
  rendererType: "sprite",
  pixelArt: true,
  canvas: { w: 128, h: 128 },
  anchor: [64, 118],
  atlas: "atlas.png",
  atlasJson: "atlas.json",
  animations: [
    { group: "Idle", index: 0, kind: "loop", fps: 8, frames: [{ base: "idle_00" }] },
  ],
  mouthLevels: ["m0", "m1"],
};

const files = [PET_PACKAGE_MANIFEST, "atlas.png", "atlas.json"];
const okCtx = { files, atlasRaw, atlasHasAlpha: true };

const errorsText = (r: { errors: { path: string; message: string }[] }) =>
  r.errors.map((e) => `${e.path}: ${e.message}`).join("\n");

describe("validatePetPackage — 通过路径", () => {
  it("完整包通过，并回传清单", () => {
    const r = validatePetPackage(manifest, okCtx);
    expect(errorsText(r)).toBe("");
    expect(r.ok).toBe(true);
    expect(r.manifest?.id).toBe("demo_pixel_cat");
  });

  it("图集条目名带 .png 后缀也能与清单引用对上", () => {
    const r = validatePetPackage(manifest, {
      ...okCtx,
      atlasRaw: {
        frames: {
          "idle_00.png": { frame: { x: 0, y: 0, w: 64, h: 64 } },
          "m0.png": { frame: { x: 64, y: 0, w: 16, h: 16 } },
          "m1.png": { frame: { x: 80, y: 0, w: 16, h: 16 } },
        },
      },
    });
    expect(errorsText(r)).toBe("");
  });

  it("省略 atlasHasAlpha 时放行但告警", () => {
    const r = validatePetPackage(manifest, { files, atlasRaw });
    expect(r.ok).toBe(true);
    expect(r.warnings.some((w) => w.message.includes("透明度"))).toBe(true);
  });

  it("省略 atlasRaw 时跳过帧交叉校验", () => {
    const r = validatePetPackage(manifest, { files, atlasHasAlpha: true });
    expect(r.ok).toBe(true);
  });
});

describe("validatePetPackage — 拒绝路径", () => {
  it("图集文件缺失", () => {
    const r = validatePetPackage(manifest, { ...okCtx, files: [PET_PACKAGE_MANIFEST] });
    expect(r.ok).toBe(false);
    expect(errorsText(r)).toContain("文件不存在");
  });

  it("帧引用在图集里找不到", () => {
    const r = validatePetPackage(
      { ...manifest, animations: [{ group: "Idle", kind: "loop", frames: [{ base: "不存在" }] }] },
      okCtx,
    );
    expect(r.ok).toBe(false);
    expect(errorsText(r)).toContain("图集中不存在条目");
  });

  it("口型档位在图集里找不到", () => {
    const r = validatePetPackage({ ...manifest, mouthLevels: ["m0", "m9"] }, okCtx);
    expect(r.ok).toBe(false);
    expect(errorsText(r)).toContain("m9");
  });

  it("未抠底（图集无透明像素）→ 拒绝，并指向 cutout", () => {
    const r = validatePetPackage(manifest, { ...okCtx, atlasHasAlpha: false });
    expect(r.ok).toBe(false);
    expect(errorsText(r)).toContain("cutout");
  });

  it("atlas 用 .. 上跳引用包外文件 → 拒绝", () => {
    const r = validatePetPackage({ ...manifest, atlas: "../../secret.png" }, {
      ...okCtx,
      files: [...files, "../../secret.png"],
    });
    expect(r.ok).toBe(false);
    expect(errorsText(r)).toContain("包内相对路径");
  });

  it("atlas 用绝对路径 / URL → 拒绝", () => {
    for (const bad of ["C:/Windows/win.ini", "/etc/passwd", "https://example.com/a.png", "file:///c:/a.png"]) {
      const r = validatePetPackage({ ...manifest, atlas: bad }, okCtx);
      expect(r.ok, `应拒绝 ${bad}`).toBe(false);
    }
  });

  it("id 含路径分隔符 → 拒绝（它同时是目录名）", () => {
    for (const bad of ["a/b", "a\\b", "..evil", ".hidden", "a:b"]) {
      const r = validatePetPackage({ ...manifest, id: bad }, okCtx);
      expect(r.ok, `应拒绝 id=${bad}`).toBe(false);
    }
  });

  it("清单结构非法时不返回 manifest", () => {
    const r = validatePetPackage({ id: "x" }, okCtx);
    expect(r.ok).toBe(false);
    expect(r.manifest).toBeUndefined();
  });

  it("一次报出多个错误（作者改一轮就能全过）", () => {
    const r = validatePetPackage(
      { ...manifest, atlas: "missing.png", atlasJson: "missing.json", mouthLevels: ["m0", "m9"] },
      okCtx,
    );
    expect(r.errors.length).toBeGreaterThanOrEqual(3);
  });

  it("包内含上跳路径的文件 → 拒绝该文件", () => {
    const r = validatePetPackage(manifest, { ...okCtx, files: [...files, "../逃逸.png"] });
    expect(r.ok).toBe(false);
    expect(errorsText(r)).toContain("包内文件路径不合法");
  });
});

describe("isSafePackagePath / isSafePackageId", () => {
  it("合法相对路径通过", () => {
    for (const p of ["a.png", "img/a.png", "a b/c-d_e.png", "中文/图.png"]) {
      expect(isSafePackagePath(p), p).toBe(true);
    }
  });

  it("越界与非法路径拒绝", () => {
    for (const p of ["", "/abs", "\\abs", "C:/x", "a/../b", "../x", "https://x", "file:///x", "a\u0000b"]) {
      expect(isSafePackagePath(p), p).toBe(false);
    }
  });

  it("joinPackagePath 对越界返回 null", () => {
    expect(joinPackagePath("mycat", "a/b.png")).toBe("mycat/a/b.png");
    expect(joinPackagePath("mycat", "../x.png")).toBeNull();
    expect(joinPackagePath("", "a.png")).toBe("a.png");
  });

  it("id 拒绝平台非法字符与过长", () => {
    expect(isSafePackageId("demo_pixel_cat")).toBe(true);
    expect(isSafePackageId("我的宠物")).toBe(true);
    expect(isSafePackageId("a".repeat(65))).toBe(false);
    for (const bad of ["a/b", "a\\b", ".x", "", "a*b", 'a?b', 'a"b', "a<b", "a>b", "a|b", "a\u0001b"]) {
      expect(isSafePackageId(bad), bad).toBe(false);
    }
  });
});

describe("planPetInstall", () => {
  const m = manifest as unknown as SpriteManifest;

  it("文件映射到 <id>/ 之下", () => {
    const plan = planPetInstall(m, files);
    expect(plan.dirName).toBe("demo_pixel_cat");
    expect(plan.files.map((f) => f.to)).toEqual([
      "demo_pixel_cat/manifest.json",
      "demo_pixel_cat/atlas.png",
      "demo_pixel_cat/atlas.json",
    ]);
  });

  it("跳过垃圾文件", () => {
    const plan = planPetInstall(m, [...files, ".DS_Store", "sub/Thumbs.db", "a.tmp"]);
    expect(plan.files).toHaveLength(3);
  });

  it("registryEntry 指向安装后的清单，且强制 sprite", () => {
    const plan = planPetInstall(m, files);
    expect(plan.registryEntry.modelUrl).toBe(`demo_pixel_cat/${PET_PACKAGE_MANIFEST}`);
    expect(plan.registryEntry.rendererType).toBe("sprite");
    expect(plan.registryEntry.id).toBe("demo_pixel_cat");
    // 清单没有 name 字段，回退用 id
    expect(plan.registryEntry.name).toBe("demo_pixel_cat");
  });

  it("信封（pet.json）补足注册表侧字段", () => {
    const plan = planPetInstall(m, files, {
      name: "像素猫",
      scale: 0.8,
      idleMotionGroup: "Idle",
      talkMotionGroup: "Talk",
      emotionMap: { joy: 0 },
      tapMotions: { HitAreaHead: { Idle: 0 } },
      actionMotions: { 挥手: { group: "Wave" } },
      personaAddon: "你是一只猫",
    });
    expect(plan.registryEntry.name).toBe("像素猫");
    expect(plan.registryEntry.scale).toBe(0.8);
    expect(plan.registryEntry.emotionMap).toEqual({ joy: 0 });
    expect(plan.registryEntry.actionMotions).toEqual({ 挥手: { group: "Wave" } });
    expect(plan.registryEntry.personaAddon).toBe("你是一只猫");
  });

  it("信封不得改写 id / rendererType / modelUrl", () => {
    const plan = planPetInstall(m, files, {
      id: "别的模型",
      rendererType: "live2d",
      modelUrl: "../../别的目录/manifest.json",
    });
    expect(plan.registryEntry.id).toBe("demo_pixel_cat");
    expect(plan.registryEntry.rendererType).toBe("sprite");
    expect(plan.registryEntry.modelUrl).toBe(`demo_pixel_cat/${PET_PACKAGE_MANIFEST}`);
  });

  it("信封非法时降级为默认值并记警告，不抛异常", () => {
    const plan = planPetInstall(m, files, "不是对象");
    expect(plan.registryEntry.id).toBe("demo_pixel_cat");
    expect(plan.warnings.length).toBeGreaterThan(0);
  });
});
