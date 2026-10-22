import { describe, expect, it } from "vitest";
import { containerOf, extOf, isSystemFile, sniff } from "./kinds.ts";

const bytes = (...parts: Array<string | number[]>): Uint8Array =>
  new Uint8Array(
    parts.flatMap((p) =>
      typeof p === "string" ? Array.from({ length: p.length }, (_, i) => p.charCodeAt(i)) : p,
    ),
  );
const ftyp = (brand: string) => bytes([0, 0, 0, 0x20], "ftyp", brand, [0, 0, 0, 0]);
const zip = bytes([0x50, 0x4b, 0x03, 0x04, 0x14, 0, 0, 0]);

describe("sniff: the header decides, the extension only checks", () => {
  it("recognises common containers", () => {
    expect(containerOf(bytes([0xff, 0xd8, 0xff, 0xe0]))).toBe("jpeg");
    expect(containerOf(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]))).toBe("png");
    expect(containerOf(bytes("RIFF", [1, 2, 3, 4], "WEBPVP8 "))).toBe("webp");
    expect(containerOf(ftyp("heic"))).toBe("isobmff-image");
    expect(containerOf(ftyp("isom"))).toBe("isobmff-video");
    expect(containerOf(ftyp("qt  "))).toBe("isobmff-video");
    expect(containerOf(ftyp("M4A "))).toBe("isobmff-audio");
    expect(containerOf(bytes("%PDF-1.7"))).toBe("pdf");
    expect(containerOf(zip)).toBe("zip");
    expect(containerOf(bytes("ID3", [3, 0]))).toBe("mp3");
    expect(containerOf(bytes("#!AMR\n"))).toBe("amr");
    expect(containerOf(new TextEncoder().encode("型号,功率\nA,2kW\n"))).toBe("text");
  });

  it("accepts a file whose header matches its extension", () => {
    expect(sniff("相册/IMG_2041.HEIC", ftyp("heic"))).toEqual({
      ok: true,
      kind: "image",
      mime: "image/heic",
    });
    expect(sniff("a.MOV", ftyp("qt  "))).toEqual({
      ok: true,
      kind: "video",
      mime: "video/quicktime",
    });
    expect(sniff("参数表.xlsx", zip)).toMatchObject({ ok: true, kind: "sheet" });
    expect(sniff("简介.pptx", zip)).toMatchObject({ ok: true, kind: "slides" });
    expect(sniff("录音.m4a", ftyp("M4A "))).toMatchObject({ ok: true, kind: "audio" });
    // 有的手机把录音存成 isom 品牌的 .m4a
    expect(sniff("录音.m4a", ftyp("isom"))).toMatchObject({ ok: true, kind: "audio" });
    expect(sniff("想法.txt", new TextEncoder().encode("两个大人一个小孩"))).toMatchObject({
      ok: true,
      kind: "text",
    });
    expect(sniff("表.csv", new TextEncoder().encode("a,b\n1,2"))).toMatchObject({
      ok: true,
      kind: "sheet",
    });
  });

  it("refuses a mismatch with a reason the respondent can act on", () => {
    const r = sniff("资料/手册.pdf", zip);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.reason).toContain("zip");
    expect(sniff("x.jpg", bytes("%PDF-1.4")).ok).toBe(false);
  });

  it("refuses formats it knows but cannot read, saying what to do", () => {
    const r = sniff("旧版画册.ppt", bytes([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));
    expect(!r.ok && r.reason).toContain(".pptx");
    expect(sniff("资料.zip", zip).ok).toBe(false);
  });

  it("takes anything as `any` only where an item keeps originals", () => {
    expect(sniff("mark-final.ai", bytes("%PDF-1.5")).ok).toBe(false);
    expect(sniff("mark-final.ai", bytes("%PDF-1.5"), true)).toEqual({
      ok: true,
      kind: "any",
      mime: "application/octet-stream",
    });
  });

  it("utf-8 text cut in the middle of a character is still text", () => {
    const full = new TextEncoder().encode("中文");
    expect(containerOf(full.subarray(0, 4))).toBe("text");
  });
});

describe("system files and extensions", () => {
  it("ignores system files", () => {
    expect(isSystemFile("资料/.DS_Store")).toBe(true);
    expect(isSystemFile("__MACOSX/资料/._a.jpg")).toBe(true);
    expect(isSystemFile("资料/a.jpg")).toBe(false);
  });
  it("reads extensions case-insensitively", () => {
    expect(extOf("A/B.C/IMG.JPG")).toBe("jpg");
    expect(extOf(".hidden")).toBe("");
    expect(extOf("noext")).toBe("");
  });
});
