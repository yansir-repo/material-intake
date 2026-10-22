import { describe, expect, it } from "vitest";
import { canonicalParams, resolveParams } from "./ops.ts";
import {
  acceptedAnywhere,
  keepItems,
  pipelineFor,
  resolve,
  type TemplateInput,
} from "./template.ts";

const base: TemplateInput = {
  id: "t",
  version: 1,
  title: "资料",
  requester: "某某",
  pipeline: {
    image: [{ op: "image.resize" }],
    video: [{ op: "video.frames", count: 12 }, { op: "transcribe" }],
    pdf: [{ op: "pdf.markdown" }, { op: "pdf.pages" }],
    audio: [{ op: "transcribe", language: "zh" }],
  },
  items: [
    {
      key: "photos",
      title: "照片",
      accept: ["image", "video"],
      required: true,
      pipeline: { image: [{ op: "image.resize" }, { op: "describe", prompt: "只写看得见的。" }] },
    },
    {
      key: "papers",
      title: "文件",
      accept: ["pdf", "image"],
      pipeline: { image: [{ op: "image.tile" }] },
    },
    {
      key: "mark",
      title: "标识",
      accept: ["image", "any"],
      pipeline: {
        image: [{ op: "file.keep" }, { op: "image.resize", longEdge: 1024, format: "png" }],
        any: [{ op: "file.keep" }],
      },
    },
  ],
};

describe("params", () => {
  it("fills defaults and checks ranges", () => {
    expect(resolveParams("image.resize", {})).toEqual({
      ok: true,
      params: { longEdge: 1600, format: "webp", quality: 0.82 },
    });
    expect(resolveParams("image.resize", { longEdge: 99999 }).ok).toBe(false);
    expect(resolveParams("image.resize", { colour: "red" }).ok).toBe(false);
    expect(resolveParams("describe", {}).ok).toBe(false); // prompt is required
  });
  it("canonical params do not depend on key order", () => {
    expect(canonicalParams({ b: 1, a: 2 })).toBe(canonicalParams({ a: 2, b: 1 }));
  });
});

describe("resolve: template + overrides → snapshot", () => {
  it("expands every step's parameters", () => {
    const r = resolve(base);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.snapshot.pipeline.video?.[0]).toEqual({
      op: "video.frames",
      params: { count: 12, longEdge: 960, sheet: true, cols: 4 },
    });
    expect(r.snapshot.budget).toBeNull();
    expect(r.snapshot.retainDays).toBe(30);
  });

  it("a file's pipeline is its item's, else the invite's default", () => {
    const r = resolve(base);
    if (!r.ok) throw new Error(r.problems.join("\n"));
    const s = r.snapshot;
    expect(pipelineFor(s, "photos", "image").map((x) => x.op)).toEqual([
      "image.resize",
      "describe",
    ]);
    expect(pipelineFor(s, "photos", "video").map((x) => x.op)).toEqual([
      "video.frames",
      "transcribe",
    ]);
    expect(pipelineFor(s, null, "image").map((x) => x.op)).toEqual(["image.resize"]);
    expect(pipelineFor(s, "mark", "any").map((x) => x.op)).toEqual(["file.keep"]);
    expect(acceptedAnywhere(s, "any")).toBe(true);
    expect(acceptedAnywhere(s, "sheet")).toBe(false);
    expect(keepItems(s).map((i) => i.key)).toEqual(["mark"]);
  });

  it("overrides merge by key, remove, append; budget and limits", () => {
    const r = resolve(base, {
      title: "别的标题",
      items: [
        { key: "papers", remove: true },
        { key: "photos", required: false },
        { key: "extra", title: "其他", accept: ["pdf"] },
      ],
      budget: { usd: 2 },
      retainDays: 7,
    });
    if (!r.ok) throw new Error(r.problems.join("\n"));
    expect(r.snapshot.title).toBe("别的标题");
    expect(r.snapshot.items.map((i) => i.key)).toEqual(["photos", "mark", "extra"]);
    expect(r.snapshot.items[0]!.required).toBe(false);
    expect(r.snapshot.budget).toEqual({ usd: 2 });
    expect(r.snapshot.retainDays).toBe(7);
  });

  it("refuses, with every reason, what cannot work", () => {
    const r = resolve({
      ...base,
      pipeline: { ...base.pipeline, image: [{ op: "file.keep" }] },
      items: [
        { key: "Bad Key", title: "", accept: ["image"] },
        { key: "a", title: "A", accept: ["sheet"] },
        {
          key: "b",
          title: "B",
          accept: ["image"],
          pipeline: { image: [{ op: "describe", prompt: "x" }] },
        },
        { key: "c", title: "C", accept: ["any"] },
        { key: "c", title: "C2", accept: ["pdf"], pipeline: { pdf: [{ op: "image.resize" }] } },
        { key: "d", title: "D", accept: ["image"], required: true, count: { min: 0 } },
      ],
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const all = r.problems.join("\n");
    expect(all).toContain("file.keep only in an item's pipeline");
    expect(all).toContain("items.Bad Key: key must match");
    expect(all).toContain("items.Bad Key.title");
    expect(all).toContain("items.a: no pipeline for sheet");
    expect(all).toContain("describe needs an image-producing step before it");
    expect(all).toContain("items.c: accepting any needs pipeline.any");
    expect(all).toContain("items.c: duplicate key");
    expect(all).toContain("image.resize does not accept pdf");
    expect(all).toContain("required needs count.min");
  });

  it("refuses a second item with an existing title: change the item by its key instead", () => {
    const r = resolve(base, { items: [{ key: "photos-2", title: "照片", accept: ["image"] }] });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.problems.join("\n")).toContain("same title as items.photos");
    expect(resolve(base, { items: [{ key: "photos", title: "照片", ask: "改了说明" }] }).ok).toBe(
      true,
    );
  });

  it("refuses a budget of zero and silly limits", () => {
    const r = resolve(base, { budget: { usd: 0 }, maxFiles: 0, retainDays: 1000 });
    expect(r.ok).toBe(false);
  });
});
