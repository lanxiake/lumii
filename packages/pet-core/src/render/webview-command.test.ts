import { describe, it, expect } from "vitest";
import {
  serializeWebViewCommand,
  parseWebViewInbound,
  type WebViewCommand,
} from "./webview-command.js";

describe("serializeWebViewCommand", () => {
  it("序列化各类合法指令", () => {
    expect(JSON.parse(serializeWebViewCommand({ type: "motion", group: "Talk", index: 1 }))).toEqual({
      type: "motion",
      group: "Talk",
      index: 1,
    });
    expect(JSON.parse(serializeWebViewCommand({ type: "expression", index: 3 }))).toEqual({
      type: "expression",
      index: 3,
    });
    expect(JSON.parse(serializeWebViewCommand({ type: "release_lipsync" }))).toEqual({
      type: "release_lipsync",
    });
  });

  it("未知指令类型抛错", () => {
    expect(() =>
      serializeWebViewCommand({ type: "boom" } as unknown as WebViewCommand),
    ).toThrow(/未知的 WebView 指令类型/);
  });
});

describe("parseWebViewInbound", () => {
  it("解析 ready", () => {
    expect(parseWebViewInbound(JSON.stringify({ type: "ready" }))).toEqual({ type: "ready" });
  });

  it("解析 error，缺 message 归空串", () => {
    expect(parseWebViewInbound(JSON.stringify({ type: "error", message: "boom" }))).toEqual({
      type: "error",
      message: "boom",
    });
    expect(parseWebViewInbound(JSON.stringify({ type: "error" }))).toEqual({
      type: "error",
      message: "",
    });
  });

  it("解析 motion_played，fileName 可选", () => {
    expect(
      parseWebViewInbound(
        JSON.stringify({ type: "motion_played", group: "Talk", index: 2, fileName: "m.json" }),
      ),
    ).toEqual({ type: "motion_played", group: "Talk", index: 2, fileName: "m.json" });
  });

  it("motion_played 缺 group/index 视为脏数据返回 null", () => {
    expect(parseWebViewInbound(JSON.stringify({ type: "motion_played", index: 1 }))).toBeNull();
    expect(parseWebViewInbound(JSON.stringify({ type: "motion_played", group: "T" }))).toBeNull();
  });

  it("脏数据 / 未知类型返回 null（不抛错）", () => {
    expect(parseWebViewInbound("not json")).toBeNull();
    expect(parseWebViewInbound("123")).toBeNull();
    expect(parseWebViewInbound(JSON.stringify({ type: "weird" }))).toBeNull();
  });
});
