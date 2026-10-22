import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  estimateDescribe,
  estimateSort,
  estimateTranscribe,
  fits,
  settleTranscribe,
  toNano,
} from "./budget.ts";
import { fitLongEdge, frameTimes, lostOf, tileGrid } from "./facts.ts";
import { Sha256, sha256Hex, stepIdOf } from "./sha256.ts";
import { decide, sortQuestion, sortState, unsorted } from "./sort.ts";
import { resolve, type TemplateInput } from "./template.ts";
import { promises, howOf } from "./page.ts";

const tpl: TemplateInput = {
  id: "t",
  version: 1,
  title: "资料",
  requester: "某某",
  pipeline: {
    image: [{ op: "image.resize" }],
    pdf: [{ op: "pdf.markdown" }],
    audio: [{ op: "transcribe" }],
  },
  sort: { threshold: 0.7, instructions: "背景说明" },
  items: [
    { key: "a", title: "甲", ask: "甲的说明", accept: ["image"] },
    { key: "b", title: "乙", ask: "乙的说明", accept: ["image", "pdf"], sortHint: "提示" },
    {
      key: "c",
      title: "丙",
      accept: ["pdf"],
      pipeline: { pdf: [{ op: "file.keep" }, { op: "pdf.markdown" }] },
    },
  ],
};
const snap = (() => {
  const r = resolve(tpl);
  if (!r.ok) throw new Error(r.problems.join("\n"));
  return r.snapshot;
})();

describe("sha256", () => {
  it("matches node:crypto, fed in uneven chunks", () => {
    const data = new Uint8Array(200_003).map((_, i) => (i * 31 + 7) & 0xff);
    const h = new Sha256();
    for (let i = 0; i < data.length; i += 977) h.update(data.subarray(i, i + 977));
    expect(h.hex()).toBe(createHash("sha256").update(data).digest("hex"));
    expect(sha256Hex("")).toBe(createHash("sha256").update("").digest("hex"));
    expect(sha256Hex("abc")).toBe(createHash("sha256").update("abc").digest("hex"));
    for (const n of [55, 56, 63, 64, 65, 119, 120])
      expect(sha256Hex(new Uint8Array(n).fill(1))).toBe(
        createHash("sha256").update(new Uint8Array(n).fill(1)).digest("hex"),
      );
  });
  it("step ids depend on params, not on their order", () => {
    expect(stepIdOf({ op: "image.resize", params: { a: 1, b: 2 } })).toBe(
      stepIdOf({ op: "image.resize", params: { b: 2, a: 1 } }),
    );
    expect(stepIdOf({ op: "image.resize", params: { longEdge: 1600 } })).not.toBe(
      stepIdOf({ op: "image.resize", params: { longEdge: 1024 } }),
    );
    expect(stepIdOf({ op: "image.resize", params: {} })).toMatch(/^image\.resize\.[0-9a-f]{8}$/);
  });
});

describe("sort: options are the invite's items", () => {
  it("only items that accept the kind are options, plus none", () => {
    expect(Object.keys(sortQuestion(snap, "image").criteria)).toEqual(["a", "b", "none"]);
    expect(Object.keys(sortQuestion(snap, "pdf").criteria)).toEqual(["b", "c", "none"]);
    expect(sortQuestion(snap, "image").criteria["b"]).toBe("乙。乙的说明。提示");
    expect(sortState(snap, { path: "x/y.jpg", kind: "image" })).toEqual({
      context: "背景说明",
      file: { path: "x/y.jpg", type: "图片" },
    });
  });
  it("lands above the threshold, otherwise unassigned with two candidates", () => {
    expect(decide(snap, "image", "m", { a: 0.9, b: 0.05, none: 0.05 })).toMatchObject({
      item: "a",
      by: "model",
      p: 0.9,
    });
    expect(decide(snap, "image", "m", { a: 0.5, b: 0.3, none: 0.2 })).toMatchObject({
      item: null,
      by: "none",
      candidates: ["a", "b"],
    });
    expect(decide(snap, "image", "m", { none: 0.8, b: 0.15, a: 0.05 })).toMatchObject({
      item: null,
      candidates: ["b", "a"],
    });
    // an item that does not accept this kind can never be chosen
    expect(decide(snap, "image", "m", { c: 0.95, a: 0.05 })).toMatchObject({
      item: null,
      candidates: ["a"],
    });
    expect(unsorted(snap, "pdf", "budget")).toEqual({
      item: null,
      by: "none",
      reason: "budget",
      candidates: ["b", "c"],
    });
  });
});

describe("budget: integer nano-dollars, worst case first", () => {
  it("never lets a reservation exceed the cap", () => {
    expect(fits(null, 10 ** 12, 10 ** 12)).toBe(true);
    expect(fits(toNano(0.002), toNano(0.0015), toNano(0.0005))).toBe(true);
    expect(fits(toNano(0.002), toNano(0.0015), toNano(0.0005) + 1)).toBe(false);
  });
  it("estimates are upper bounds of the settlements", () => {
    expect(estimateTranscribe(61)).toBeGreaterThanOrEqual(settleTranscribe(61));
    expect(estimateSort(4, 2000, 300)).toBeGreaterThan(0);
    expect(estimateSort(0, 100, 300, 240)).toBeGreaterThan(estimateSort(0, 100, 300));
    expect(estimateDescribe(1, 50, 400)).toBeGreaterThan(0);
  });
});

describe("facts and what was lost", () => {
  it("fits a long edge and never upsizes", () => {
    expect(fitLongEdge(6000, 4000, 1600)).toEqual({ w: 1600, h: 1067 });
    expect(fitLongEdge(800, 600, 1600)).toEqual({ w: 800, h: 600 });
  });
  it("tiles cover the image with overlap", () => {
    const g = tileGrid(3024, 4032, 1024, 64);
    expect(g[0]).toEqual({ x: 0, y: 0, w: 1024, h: 1024 });
    expect(Math.max(...g.map((t) => t.x + t.w))).toBe(3024);
    expect(Math.max(...g.map((t) => t.y + t.h))).toBe(4032);
    expect(tileGrid(800, 600, 1024, 64)).toEqual([{ x: 0, y: 0, w: 800, h: 600 }]);
  });
  it("frame times are spread over the video", () => {
    const t = frameTimes(482.4, 12);
    expect(t).toHaveLength(12);
    expect(t[0]).toBe(0);
    expect(t.at(-1)!).toBeLessThan(482.4);
  });
  it("lost is a deterministic sentence", () => {
    expect(
      lostOf(
        "image.resize",
        { format: "webp" },
        { width: 6000, height: 4000 },
        { width: 1600, height: 1067, format: "webp" },
      ),
    ).toBe("分辨率 6000×4000 → 1600×1067；重新编码为 WEBP；EXIF 已去除");
    expect(
      lostOf(
        "video.frames",
        {},
        { duration: 61, hasAudio: true },
        { frames: [0, 30, 60], width: 960, height: 540 },
      ),
    ).toContain("声音不在这个产物里");
    expect(lostOf("pdf.markdown", {}, { pages: 2 }, { chars: 10 })).toContain("扫描件");
    expect(lostOf("describe", {}, {}, {})).toBeUndefined();
  });
});

describe("the page's promises are derived from the snapshot", () => {
  it("names the items that keep originals", () => {
    const p = promises(snap);
    expect(p[0]).toBe("「丙」会上传原件，其余只上传处理后的版本");
    expect(p).toContain("录音转成文字，录音本身不上传");
    expect(p).toContain("文档经服务器转成文字，转完原件立刻删除");
  });
  it("says what each kind goes through, hiding model output", () => {
    expect(howOf(snap, "c")).toEqual([
      { kind: "pdf", label: "PDF", says: ["上传原件（提交时）", "取出文字"] },
    ]);
  });
});

import { isoOf } from "./time.ts";
describe("isoOf", () => {
  it("matches Date for a spread of instants", () => {
    for (const s of [0, 951782400, 1709164800, 1792648250, 4102444799, 1234567890])
      expect(isoOf(s)).toBe(new Date(s * 1000).toISOString().replace(/\.\d+Z$/, "Z"));
  });
});
