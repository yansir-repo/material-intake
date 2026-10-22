import { describe, expect, it } from "vitest";
import { buildManifest, renderMap } from "./manifest.ts";
import type { FileRecord, Product } from "./model.ts";
import { resolve } from "./template.ts";

const snap = (() => {
  const r = resolve({
    id: "t",
    version: 1,
    title: "资料",
    requester: "某某",
    pipeline: { image: [{ op: "image.resize" }], audio: [{ op: "transcribe" }] },
    items: [
      { key: "a", title: "甲", accept: ["image", "audio"], required: true },
      { key: "b", title: "乙", accept: ["image"], allowNone: true },
    ],
  });
  if (!r.ok) throw new Error(r.problems.join("\n"));
  return r.snapshot;
})();

const file = (id: string, over: Partial<FileRecord>): FileRecord => ({
  id,
  round: 1,
  name: `${id}.jpg`,
  path: `夹/${id}.jpg`,
  kind: "image",
  mime: "image/jpeg",
  bytes: 1000,
  sha256: id.padEnd(64, "0"),
  facts: { width: 4000, height: 3000 },
  assignment: { item: "a", by: "model", model: "m", p: 0.9, scores: { a: 0.9, none: 0.1 } },
  failure: null,
  duplicateOf: null,
  ...over,
});
const resize: Product = {
  op: "image.resize",
  params: { longEdge: 1600 },
  stepId: "image.resize.00000000",
  status: "done",
  meta: { files: ["image.webp"], width: 1600, height: 1200, bytes: 200 },
  lost: "分辨率 4000×3000 → 1600×1200",
};
const transcript: Product = {
  op: "transcribe",
  params: {},
  stepId: "transcribe.11111111",
  status: "done",
  meta: {},
  text: "转出来的话",
  model: "whisper",
  segments: [{ start: 0, end: 2, text: "转出来的话" }],
};

describe("manifest", () => {
  const m = buildManifest({
    inviteId: "inv_x",
    ref: "R-1",
    round: 1,
    submittedAt: 1792648250,
    snapshot: snap,
    files: [
      { file: file("f_a", {}), products: [resize] },
      {
        file: file("f_b", {
          kind: "audio",
          name: "r.m4a",
          path: "r.m4a",
          assignment: { item: "a", by: "client" },
        }),
        products: [transcript],
      },
      {
        file: file("f_c", {
          assignment: { item: null, by: "none", candidates: ["a", "b"], reason: "budget" },
        }),
        products: [resize],
      },
    ],
    notes: { a: { none: false, note: "原话" }, b: { none: true, note: "还在办" } },
    usage: { usd: 0.001, calls: { sort: 3, describe: 0, transcribe: 1 }, skipped: { budget: 1 } },
  });

  it("files live in one place; items and unassigned only refer to them", () => {
    expect(m.items.map((i) => [i.key, i.status, i.files])).toEqual([
      ["a", "provided", ["f_a", "f_b"]],
      ["b", "none", []],
    ]);
    expect(m.unassigned).toEqual(["f_c"]);
    expect(m.items[0]!.note).toBe("原话");
    expect(m.submittedAt).toBe("2026-10-22T05:50:50Z");
  });

  it("artifacts carry their output paths, model output stays labelled", () => {
    expect(m.files["f_a"]!.artifacts[0]).toMatchObject({
      op: "image.resize",
      class: "lossy",
      path: "files/f_a/image.resize.00000000/image.webp",
    });
    expect(m.files["f_b"]!.artifacts[0]).toMatchObject({
      op: "transcribe",
      class: "model",
      path: "files/f_b/transcribe.11111111/transcript.md",
      text: "转出来的话",
    });
  });

  it("MAP.md shows every file, including one with only model output", () => {
    const md = renderMap(m);
    expect(md).toContain("> 对方原话：原话");
    expect(md).toContain("对方声明：没有。");
    expect(md).toContain("模型转写（whisper）");
    expect(md).toContain("未分类（budget）");
    expect(md).toContain("因上限跳过 1 次");
    expect(md).toMatch(/\| r\.m4a<br>f_b · 对方放的 \|[^|]*\| 模型转写/);
  });
});
